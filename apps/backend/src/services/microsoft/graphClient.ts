import {
  GraphApiError,
  type GraphDeltaResponse,
  type GraphDraftResponse,
  type GraphMailMessage,
  type GraphSubscriptionResponse,
  type MicrosoftGraphClient,
} from './graphTypes.js';

interface GraphErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

const PERMANENT_GRAPH_ERROR_CODES = new Set([
  'ErrorInvalidRecipients',
  'ErrorRecipientNotFound',
  'ErrorMessageSubmissionBlocked',
  'ErrorInvalidRequest',
  'InvalidRecipients',
  'ErrorCannotSendWhenAccountIsDisabled',
  'ErrorSendAsDenied',
]);

const AUTH_REVOKED_ERROR_CODES = new Set([
  'InvalidAuthenticationToken',
  'TokenExpired',
  'ErrorAccessDenied',
  'AccessDenied',
]);

function parseGraphError(statusCode: number, bodyText: string, retryAfterHeader?: string | null): GraphApiError {
  let code: string | undefined;
  let message = `Microsoft Graph error (${statusCode})`;
  try {
    const parsed = JSON.parse(bodyText) as GraphErrorPayload;
    code = parsed.error?.code;
    if (parsed.error?.message) {
      message = parsed.error.message;
    }
  } catch {
    if (bodyText) {
      message = bodyText.slice(0, 280);
    }
  }

  let retryAfterSeconds: number | undefined;
  if (retryAfterHeader) {
    const numeric = Number(retryAfterHeader);
    if (!Number.isNaN(numeric) && numeric > 0) {
      retryAfterSeconds = numeric;
    }
  }

  const isRateLimited = statusCode === 429 || code === 'ApplicationThrottled' || code === 'MailboxConcurrency';
  const isAuthRevoked = statusCode === 401 || AUTH_REVOKED_ERROR_CODES.has(code ?? '');
  const isPermanent =
    !isRateLimited &&
    !isAuthRevoked &&
    statusCode >= 400 &&
    statusCode < 500 &&
    (PERMANENT_GRAPH_ERROR_CODES.has(code ?? '') ||
      /invalid recipient|bad address|does not exist|blocked/i.test(message));

  return new GraphApiError(message, {
    statusCode,
    errorCode: code,
    retryAfterSeconds,
    isPermanent,
    isAuthRevoked,
    isRateLimited,
  });
}

export class RealMicrosoftGraphClient implements MicrosoftGraphClient {
  private readonly baseUrl = 'https://graph.microsoft.com/v1.0';

  private async request<T>(
    accessToken: string,
    url: string,
    init: RequestInit = {},
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    const text = await res.text();
    if (!res.ok) {
      throw parseGraphError(res.status, text, res.headers.get('Retry-After'));
    }

    const data = text ? (JSON.parse(text) as T) : (undefined as T);
    return { status: res.status, data };
  }

  async createDraft(
    accessToken: string,
    payload: {
      subject: string;
      htmlBody: string;
      toEmail: string;
      correlationId: string;
      unsubscribeUrl?: string;
    },
  ): Promise<GraphDraftResponse> {
    const body: Record<string, unknown> = {
      subject: payload.subject,
      body: {
        contentType: 'HTML',
        content: payload.htmlBody,
      },
      toRecipients: [
        {
          emailAddress: {
            address: payload.toEmail,
          },
        },
      ],
      internetMessageHeaders: [
        {
          name: 'X-Outreach-Correlation-Id',
          value: payload.correlationId,
        },
      ],
    };

    if (payload.unsubscribeUrl) {
      body.singleValueExtendedProperties = [
        {
          id: 'String 0x1045',
          value: `<${payload.unsubscribeUrl}>`,
        },
      ];
    }

    const { data } = await this.request<GraphDraftResponse>(
      accessToken,
      `${this.baseUrl}/me/messages`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    return data;
  }

  async sendDraft(accessToken: string, draftId: string): Promise<{ statusCode: number }> {
    const { status } = await this.request<void>(
      accessToken,
      `${this.baseUrl}/me/messages/${encodeURIComponent(draftId)}/send`,
      {
        method: 'POST',
      },
    );
    return { statusCode: status };
  }

  async findSentByCorrelationOrMessageId(
    accessToken: string,
    params: { internetMessageId?: string | null; conversationId?: string | null; draftId?: string | null },
  ): Promise<{ state: 'SENT' | 'DRAFT_ONLY' | 'NOT_FOUND'; graphMessageId?: string }> {
    if (params.conversationId) {
      const escapedConv = params.conversationId.replace(/'/g, "''");
      const sentUrl =
        `${this.baseUrl}/me/mailFolders('SentItems')/messages` +
        `?$filter=conversationId eq '${encodeURIComponent(escapedConv)}'&$select=id,internetMessageId,isDraft&$top=5`;
      const { data } = await this.request<{ value: Array<{ id: string; internetMessageId?: string; isDraft?: boolean }> }>(
        accessToken,
        sentUrl,
      );
      const match = data.value?.find(
        (m) => !params.internetMessageId || m.internetMessageId === params.internetMessageId,
      );
      if (match) {
        return { state: 'SENT', graphMessageId: match.id };
      }
    }

    if (params.draftId) {
      try {
        const { data: draft } = await this.request<{ id: string; isDraft?: boolean }>(
          accessToken,
          `${this.baseUrl}/me/messages/${encodeURIComponent(params.draftId)}?$select=id,isDraft`,
        );
        if (draft?.isDraft) {
          return { state: 'DRAFT_ONLY' };
        }
        return { state: 'SENT', graphMessageId: draft.id };
      } catch (err) {
        if (err instanceof GraphApiError && err.statusCode === 404) {
          return { state: 'NOT_FOUND' };
        }
        throw err;
      }
    }

    return { state: 'NOT_FOUND' };
  }

  async fetchInboxDelta(accessToken: string, deltaLink?: string | null): Promise<GraphDeltaResponse> {
    const initialUrl =
      deltaLink ||
      `${this.baseUrl}/me/mailFolders('Inbox')/messages/delta?$select=id,internetMessageId,conversationId,subject,bodyPreview,receivedDateTime,from,sender,toRecipients,body,internetMessageHeaders&$top=25`;

    const allMessages: GraphMailMessage[] = [];
    let nextUrl: string | undefined = initialUrl;
    let finalDeltaLink: string | undefined;
    let pages = 0;

    while (nextUrl && pages < 5) {
      pages++;
      const pageResp: { data: GraphDeltaResponse } = await this.request<GraphDeltaResponse>(
        accessToken,
        nextUrl,
      );
      const data = pageResp.data;
      if (Array.isArray(data.value)) {
        allMessages.push(...data.value);
      }
      nextUrl = data['@odata.nextLink'];
      if (data['@odata.deltaLink']) {
        finalDeltaLink = data['@odata.deltaLink'];
      }
    }

    return {
      value: allMessages,
      '@odata.nextLink': nextUrl,
      '@odata.deltaLink': finalDeltaLink ?? deltaLink ?? undefined,
    };
  }

  async fetchMessageById(accessToken: string, messageId: string): Promise<GraphMailMessage> {
    const url = `${this.baseUrl}/me/messages/${encodeURIComponent(messageId)}?$select=id,internetMessageId,conversationId,subject,bodyPreview,receivedDateTime,from,sender,toRecipients,body,internetMessageHeaders`;
    const { data } = await this.request<GraphMailMessage>(accessToken, url);
    return data;
  }

  async createInboxSubscription(
    accessToken: string,
    notificationUrl: string,
    clientState: string,
    expirationDateTime: string,
  ): Promise<GraphSubscriptionResponse> {
    const { data } = await this.request<GraphSubscriptionResponse>(
      accessToken,
      `${this.baseUrl}/subscriptions`,
      {
        method: 'POST',
        body: JSON.stringify({
          changeType: 'created',
          notificationUrl,
          resource: "/me/mailFolders('Inbox')/messages",
          expirationDateTime,
          clientState,
        }),
      },
    );
    return data;
  }

  async renewSubscription(
    accessToken: string,
    subscriptionId: string,
    expirationDateTime: string,
  ): Promise<GraphSubscriptionResponse> {
    const { data } = await this.request<GraphSubscriptionResponse>(
      accessToken,
      `${this.baseUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ expirationDateTime }),
      },
    );
    return data;
  }
}
