export interface MicrosoftTokenResponse {
  token_type: string;
  scope?: string;
  expires_in: number;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

export interface MicrosoftUserProfile {
  id: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

export interface GraphDraftResponse {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
}

export interface GraphMailMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  isDraft?: boolean;
  from?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  sender?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  toRecipients?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
  }>;
  body?: {
    contentType?: string;
    content?: string;
  };
  internetMessageHeaders?: Array<{
    name: string;
    value: string;
  }>;
}

export interface GraphDeltaResponse {
  value: GraphMailMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export interface GraphSubscriptionResponse {
  id: string;
  expirationDateTime: string;
}

export class GraphApiError extends Error {
  readonly statusCode: number;
  readonly errorCode?: string;
  readonly retryAfterSeconds?: number;
  readonly isPermanent: boolean;
  readonly isAuthRevoked: boolean;
  readonly isRateLimited: boolean;

  constructor(
    message: string,
    opts: {
      statusCode: number;
      errorCode?: string;
      retryAfterSeconds?: number;
      isPermanent?: boolean;
      isAuthRevoked?: boolean;
      isRateLimited?: boolean;
    },
  ) {
    super(message);
    this.name = 'GraphApiError';
    this.statusCode = opts.statusCode;
    this.errorCode = opts.errorCode;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.isPermanent = Boolean(opts.isPermanent);
    this.isAuthRevoked = Boolean(opts.isAuthRevoked);
    this.isRateLimited = Boolean(opts.isRateLimited);
  }
}

export interface MicrosoftGraphClient {
  createDraft(
    accessToken: string,
    payload: {
      subject: string;
      htmlBody: string;
      toEmail: string;
      correlationId: string;
      unsubscribeUrl?: string;
    },
  ): Promise<GraphDraftResponse>;
  sendDraft(accessToken: string, draftId: string): Promise<{ statusCode: number }>;
  findSentByCorrelationOrMessageId(
    accessToken: string,
    params: { internetMessageId?: string | null; conversationId?: string | null; draftId?: string | null },
  ): Promise<{ state: 'SENT' | 'DRAFT_ONLY' | 'NOT_FOUND'; graphMessageId?: string }>;
  fetchInboxDelta(
    accessToken: string,
    deltaLink?: string | null,
  ): Promise<GraphDeltaResponse>;
  fetchMessageById(accessToken: string, messageId: string): Promise<GraphMailMessage>;
  createInboxSubscription(
    accessToken: string,
    notificationUrl: string,
    clientState: string,
    expirationDateTime: string,
  ): Promise<GraphSubscriptionResponse>;
  renewSubscription(
    accessToken: string,
    subscriptionId: string,
    expirationDateTime: string,
  ): Promise<GraphSubscriptionResponse>;
}
