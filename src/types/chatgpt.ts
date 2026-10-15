/** Validated credentials for one host-selected ChatGPT account/workspace. */
export interface ChatGPTAccessToken {
    accessToken: string;
    /** Granted scopes from the OAuth token response, not requested scopes. */
    scopes: readonly string[];
    /** Unix milliseconds; omitted when expiry is managed by the host. */
    expiresAt?: number;
}

/** The host owns sign-in, identity validation, secure storage and refresh-token rotation. */
export interface ChatGPTTokenSource {
    read(): Promise<ChatGPTAccessToken>;
    /** Atomically persist all replacement credentials before returning. */
    refresh?(): Promise<ChatGPTAccessToken>;
}

/** Share one session per account registration across drivers and model catalogs. */
export interface ChatGPTAuthSession {
    getToken(options?: { rejectedAccessToken?: string; signal?: AbortSignal }): Promise<ChatGPTAccessToken>;
}

export interface ChatGPTConfig {
    session: ChatGPTAuthSession;
}
