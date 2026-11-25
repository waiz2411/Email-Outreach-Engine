import type { AppConfig } from '../../config/env.js';
import {
  decryptSecret,
  encryptSecret,
  generatePkcePair,
  generateRandomToken,
} from '../../crypto/security.js';
import { logger } from '../../utils/logger.js';
import type { MicrosoftTokenResponse, MicrosoftUserProfile } from './graphTypes.js';

export const MICROSOFT_GRAPH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
];

export interface OAuthHttpTransport {
  exchangeCode(params: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  }): Promise<MicrosoftTokenResponse>;
  refreshToken(params: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<MicrosoftTokenResponse>;
  fetchProfile(accessToken: string): Promise<MicrosoftUserProfile>;
}

export class OAuthFlowError extends Error {
  readonly code: string;
  readonly requiresAdminConsent: boolean;
  readonly isRevoked: boolean;

  constructor(
    message: string,
    opts: { code: string; requiresAdminConsent?: boolean; isRevoked?: boolean },
  ) {
    super(message);
    this.name = 'OAuthFlowError';
    this.code = opts.code;
    this.requiresAdminConsent = Boolean(opts.requiresAdminConsent);
    this.isRevoked = Boolean(opts.isRevoked);
  }
}

function parseOAuthErrorBody(rawText: string): { error?: string; errorDescription?: string } {
  try {
    const parsed = JSON.parse(rawText) as { error?: string; error_description?: string };
    return {
      error: parsed.error,
      errorDescription: parsed.error_description,
    };
  } catch {
    return { errorDescription: rawText.slice(0, 300) };
  }
}

export function interpretMicrosoftOAuthError(errorCode?: string, description?: string): OAuthFlowError {
  const combined = `${errorCode ?? ''} ${description ?? ''}`.toLowerCase();
  if (
    combined.includes('aadsts65001') ||
    combined.includes('aadsts90094') ||
    combined.includes('consent_required') ||
    combined.includes('admin_consent')
  ) {
    return new OAuthFlowError(
      'Your Microsoft 365 organization requires tenant administrator approval before this app can access your mailbox. Ask your M365 administrator to grant delegated permissions (User.Read, Mail.ReadWrite, Mail.Send) or connect a personal Outlook account.',
      { code: 'ADMIN_CONSENT_REQUIRED', requiresAdminConsent: true },
    );
  }
  if (
    combined.includes('invalid_grant') ||
    combined.includes('aadsts70008') ||
    combined.includes('aadsts50173') ||
    combined.includes('revoked') ||
    combined.includes('expired')
  ) {
    return new OAuthFlowError(
      'Microsoft authorization expired or was revoked. Please reauthorize this Outlook account.',
      { code: 'TOKEN_REVOKED', isRevoked: true },
    );
  }
  return new OAuthFlowError(
    description?.split('\r\n')[0] || errorCode || 'Microsoft OAuth request failed',
    { code: errorCode || 'OAUTH_ERROR' },
  );
}

export const defaultOAuthTransport: OAuthHttpTransport = {
  async exchangeCode(params) {
    const body = new URLSearchParams({
      client_id: params.clientId,
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      scope: MICROSOFT_GRAPH_SCOPES.join(' '),
    });
    if (params.clientSecret) {
      body.set('client_secret', params.clientSecret);
    }

    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(params.tenantId)}/oauth2/v2.0/token`;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      const parsed = parseOAuthErrorBody(text);
      throw interpretMicrosoftOAuthError(parsed.error, parsed.errorDescription);
    }
    return JSON.parse(text) as MicrosoftTokenResponse;
  },

  async refreshToken(params) {
    const body = new URLSearchParams({
      client_id: params.clientId,
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      scope: MICROSOFT_GRAPH_SCOPES.join(' '),
    });
    if (params.clientSecret) {
      body.set('client_secret', params.clientSecret);
    }

    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(params.tenantId)}/oauth2/v2.0/token`;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      const parsed = parseOAuthErrorBody(text);
      throw interpretMicrosoftOAuthError(parsed.error, parsed.errorDescription);
    }
    return JSON.parse(text) as MicrosoftTokenResponse;
  },

  async fetchProfile(accessToken) {
    const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new OAuthFlowError(`Failed to fetch Microsoft user profile (${res.status})`, {
        code: 'PROFILE_FETCH_FAILED',
      });
    }
    return JSON.parse(text) as MicrosoftUserProfile;
  },
};

export interface AccountTokenDb {
  oAuthState: {
    create(args: {
      data: {
        state: string;
        codeVerifierEncrypted: string;
        redirectTo?: string | null;
        expiresAt: Date;
      };
    }): Promise<unknown>;
    findUnique(args: {
      where: { state: string };
    }): Promise<{
      id: string;
      state: string;
      codeVerifierEncrypted: string;
      redirectTo: string | null;
      expiresAt: Date;
    } | null>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    deleteMany(args: { where: { expiresAt: { lt: Date } } }): Promise<unknown>;
  };
  outlookAccount: {
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      email: string;
      encryptedAccessToken: string | null;
      encryptedRefreshToken: string | null;
      tokenExpiresAt: Date | null;
      connectionStatus: string;
    } | null>;
    upsert(args: {
      where: { email: string };
      create: {
        email: string;
        displayName?: string | null;
        microsoftUserId?: string | null;
        accountType?: string;
        connectionStatus?: string;
        authorizationStatus?: string;
        encryptedAccessToken?: string | null;
        encryptedRefreshToken?: string | null;
        tokenExpiresAt?: Date | null;
        scopes?: string | null;
        lastError?: string | null;
        lastActivityAt?: Date | null;
      };
      update: {
        displayName?: string | null;
        microsoftUserId?: string | null;
        accountType?: string;
        connectionStatus?: string;
        authorizationStatus?: string;
        encryptedAccessToken?: string | null;
        encryptedRefreshToken?: string | null;
        tokenExpiresAt?: Date | null;
        scopes?: string | null;
        lastError?: string | null;
        lastActivityAt?: Date | null;
      };
    }): Promise<{ id: string; email: string }>;
    update(args: {
      where: { id: string };
      data: {
        connectionStatus?: string;
        authorizationStatus?: string;
        encryptedAccessToken?: string | null;
        encryptedRefreshToken?: string | null;
        tokenExpiresAt?: Date | null;
        scopes?: string | null;
        lastError?: string | null;
      };
    }): Promise<unknown>;
  };
}

export class MicrosoftOAuthService {
  private readonly refreshInFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly db: AccountTokenDb,
    private readonly config: AppConfig,
    private readonly transport: OAuthHttpTransport = defaultOAuthTransport,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.microsoftClientId);
  }

  async createAuthorizationUrl(opts?: { loginHint?: string; redirectTo?: string }): Promise<{ url: string; state: string }> {
    if (!this.config.microsoftClientId) {
      throw new OAuthFlowError(
        'Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in environment variables.',
        { code: 'OAUTH_NOT_CONFIGURED' },
      );
    }

    await this.db.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const state = generateRandomToken(24);
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const codeVerifierEncrypted = encryptSecret(codeVerifier, this.config.encryptionKey);

    await this.db.oAuthState.create({
      data: {
        state,
        codeVerifierEncrypted,
        redirectTo: opts?.redirectTo ?? '/accounts',
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });

    const params = new URLSearchParams({
      client_id: this.config.microsoftClientId,
      response_type: 'code',
      redirect_uri: this.config.microsoftRedirectUri,
      response_mode: 'query',
      scope: MICROSOFT_GRAPH_SCOPES.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });

    if (opts?.loginHint) {
      params.set('login_hint', opts.loginHint);
    }

    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.config.microsoftTenantId)}/oauth2/v2.0/authorize?${params.toString()}`;
    return { url, state };
  }

  async handleCallback(params: {
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<{ accountId: string; email: string; redirectTo: string }> {
    if (params.error) {
      throw interpretMicrosoftOAuthError(params.error, params.errorDescription);
    }
    if (!params.code || !params.state) {
      throw new OAuthFlowError('Missing OAuth code or state parameter', { code: 'INVALID_CALLBACK' });
    }

    const storedState = await this.db.oAuthState.findUnique({ where: { state: params.state } });
    if (!storedState) {
      throw new OAuthFlowError('Invalid or already consumed OAuth state', { code: 'INVALID_STATE' });
    }
    await this.db.oAuthState.delete({ where: { id: storedState.id } });

    if (storedState.expiresAt < new Date()) {
      throw new OAuthFlowError('OAuth authorization session expired. Please try connecting again.', {
        code: 'STATE_EXPIRED',
      });
    }

    const codeVerifier = decryptSecret(storedState.codeVerifierEncrypted, this.config.encryptionKey);
    const tokens = await this.transport.exchangeCode({
      tenantId: this.config.microsoftTenantId,
      clientId: this.config.microsoftClientId,
      clientSecret: this.config.microsoftClientSecret,
      redirectUri: this.config.microsoftRedirectUri,
      code: params.code,
      codeVerifier,
    });

    const profile = await this.transport.fetchProfile(tokens.access_token);
    const email = (profile.mail || profile.userPrincipalName || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new OAuthFlowError('Microsoft profile did not return a valid email address.', {
        code: 'NO_EMAIL_IN_PROFILE',
      });
    }

    const isConsumer = /@(outlook|hotmail|live|msn)\./i.test(email);
    const encryptedAccessToken = encryptSecret(tokens.access_token, this.config.encryptionKey);
    const encryptedRefreshToken = tokens.refresh_token
      ? encryptSecret(tokens.refresh_token, this.config.encryptionKey)
      : null;
    const tokenExpiresAt = new Date(Date.now() + Math.max(60, tokens.expires_in - 120) * 1000);

    const account = await this.db.outlookAccount.upsert({
      where: { email },
      create: {
        email,
        displayName: profile.displayName ?? null,
        microsoftUserId: profile.id,
        accountType: isConsumer ? 'PERSONAL' : 'WORK_OR_SCHOOL',
        connectionStatus: 'CONNECTED',
        authorizationStatus: 'AUTHORIZED',
        encryptedAccessToken,
        encryptedRefreshToken,
        tokenExpiresAt,
        scopes: tokens.scope ?? MICROSOFT_GRAPH_SCOPES.join(' '),
        lastError: null,
        lastActivityAt: new Date(),
      },
      update: {
        displayName: profile.displayName ?? null,
        microsoftUserId: profile.id,
        accountType: isConsumer ? 'PERSONAL' : 'WORK_OR_SCHOOL',
        connectionStatus: 'CONNECTED',
        authorizationStatus: 'AUTHORIZED',
        encryptedAccessToken,
        ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
        tokenExpiresAt,
        scopes: tokens.scope ?? MICROSOFT_GRAPH_SCOPES.join(' '),
        lastError: null,
        lastActivityAt: new Date(),
      },
    });

    logger.info('Outlook account connected via OAuth', { accountId: account.id, email: account.email });

    return {
      accountId: account.id,
      email: account.email,
      redirectTo: storedState.redirectTo || '/accounts',
    };
  }

  /**
   * Returns a valid access token for the account, transparently refreshing expired tokens with concurrency locking.
   */
  async getValidAccessToken(accountId: string, forceRefresh = false): Promise<string> {
    const existingRefresh = this.refreshInFlight.get(accountId);
    if (existingRefresh) {
      return existingRefresh;
    }

    const account = await this.db.outlookAccount.findUnique({ where: { id: accountId } });
    if (!account || account.connectionStatus === 'DISCONNECTED') {
      throw new OAuthFlowError('Outlook account is disconnected', { code: 'DISCONNECTED', isRevoked: true });
    }

    const bufferMs = 120_000;
    if (
      !forceRefresh &&
      account.encryptedAccessToken &&
      account.tokenExpiresAt &&
      account.tokenExpiresAt.getTime() - Date.now() > bufferMs
    ) {
      return decryptSecret(account.encryptedAccessToken, this.config.encryptionKey);
    }

    if (!account.encryptedRefreshToken) {
      await this.markAccountAuthFailure(accountId, 'REVOKED', 'Refresh token missing. Please reauthorize account.');
      throw new OAuthFlowError('Refresh token missing. Reauthorize account.', {
        code: 'NO_REFRESH_TOKEN',
        isRevoked: true,
      });
    }

    const refreshPromise = (async () => {
      try {
        const refreshToken = decryptSecret(account.encryptedRefreshToken!, this.config.encryptionKey);
        const tokens = await this.transport.refreshToken({
          tenantId: this.config.microsoftTenantId,
          clientId: this.config.microsoftClientId,
          clientSecret: this.config.microsoftClientSecret,
          refreshToken,
        });

        const encryptedAccessToken = encryptSecret(tokens.access_token, this.config.encryptionKey);
        const encryptedRefreshToken = tokens.refresh_token
          ? encryptSecret(tokens.refresh_token, this.config.encryptionKey)
          : account.encryptedRefreshToken;
        const tokenExpiresAt = new Date(Date.now() + Math.max(60, tokens.expires_in - 120) * 1000);

        await this.db.outlookAccount.update({
          where: { id: accountId },
          data: {
            connectionStatus: 'CONNECTED',
            authorizationStatus: 'AUTHORIZED',
            encryptedAccessToken,
            encryptedRefreshToken,
            tokenExpiresAt,
            scopes: tokens.scope ?? undefined,
            lastError: null,
          },
        });

        return tokens.access_token;
      } catch (err) {
        const oauthErr =
          err instanceof OAuthFlowError
            ? err
            : new OAuthFlowError('Token refresh failed', { code: 'REFRESH_FAILED', isRevoked: true });

        await this.markAccountAuthFailure(
          accountId,
          oauthErr.requiresAdminConsent ? 'PENDING_ADMIN_CONSENT' : 'REVOKED',
          oauthErr.message,
        );
        throw oauthErr;
      } finally {
        this.refreshInFlight.delete(accountId);
      }
    })();

    this.refreshInFlight.set(accountId, refreshPromise);
    return refreshPromise;
  }

  async markAccountAuthFailure(accountId: string, authorizationStatus: string, message: string): Promise<void> {
    await this.db.outlookAccount.update({
      where: { id: accountId },
      data: {
        connectionStatus: 'REAUTH_REQUIRED',
        authorizationStatus,
        lastError: message,
      },
    });
  }
}
