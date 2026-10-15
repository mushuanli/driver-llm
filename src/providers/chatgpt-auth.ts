import { LLMError, LLMErrorCode } from '../errors';
import type { ChatGPTAccessToken, ChatGPTAuthSession, ChatGPTTokenSource } from '../types/chatgpt';

/** A route error is never retried implicitly, including after a partial generation. */
export class ChatGPTError extends LLMError {
    constructor(public readonly reason: string, statusCode?: number) {
        super(`ChatGPT plan request failed: ${reason}`, {
            provider: 'chatgpt', statusCode, retryable: false,
            code: errorCode(reason, statusCode),
        });
    }
}

function errorCode(reason: string, status?: number): LLMErrorCode {
    if (reason === 'subscription_sharing_usage_limit_exceeded') return LLMErrorCode.QUOTA_EXCEEDED;
    if (reason === 'subscription_sharing_usage_unavailable') return LLMErrorCode.SERVICE_UNAVAILABLE;
    if (status === 401 || status === 403) return LLMErrorCode.UNAUTHORIZED;
    if (reason === 'transport_interrupted' || reason === 'stream_interrupted') return LLMErrorCode.NETWORK_ERROR;
    return status ? LLMError.fromResponse('chatgpt', status, {}).code : LLMErrorCode.INVALID_REQUEST;
}

function validateToken(token: ChatGPTAccessToken): ChatGPTAccessToken {
    if (!token.accessToken?.trim()) throw new ChatGPTError('missing_access_token', 401);
    if (!['resource.invoke', 'chatgpt.tokens.use.direct'].every(scope => token.scopes.includes(scope))) {
        throw new ChatGPTError('plan_permission_required', 403);
    }
    if (token.expiresAt !== undefined && (!Number.isFinite(token.expiresAt) || token.expiresAt <= Date.now())) {
        throw new ChatGPTError('access_token_expired', 401);
    }
    return token;
}

/** Cancellation belongs to each waiter, not to a shared rotating-token refresh. */
async function waitForToken<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!signal) return pending;
    let abort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([pending, aborted]); }
    finally { signal.removeEventListener('abort', abort); }
}

/** One session per account; no browser, disk, token exchange or global credential cache. */
export function createChatGPTAuthSession(source: ChatGPTTokenSource): ChatGPTAuthSession {
    let refreshing: Promise<ChatGPTAccessToken> | undefined;
    const refresh = () => {
        if (!source.refresh) throw new ChatGPTError('reauthorization_required', 401);
        refreshing ??= Promise.resolve().then(() => source.refresh!()).then(validateToken)
            .finally(() => { refreshing = undefined; });
        return refreshing;
    };
    return {
        async getToken(options = {}) {
            options.signal?.throwIfAborted();
            const token = await waitForToken(Promise.resolve().then(() => source.read()), options.signal);
            options.signal?.throwIfAborted();
            const expired = token.expiresAt !== undefined && token.expiresAt <= Date.now();
            const rejected = options.rejectedAccessToken === token.accessToken;
            return expired || rejected ? waitForToken(refresh(), options.signal) : validateToken(token);
        },
    };
}

/** Restrict credentials to the two documented public API routes and disallow redirects. */
export async function fetchChatGPT(session: ChatGPTAuthSession, path: 'responses' | 'models',
    init: RequestInit, fetcher: typeof globalThis.fetch = globalThis.fetch): Promise<Response> {
    const token = validateToken(await session.getToken({ signal: init.signal ?? undefined }));
    const send = (accessToken: string) => {
        init.signal?.throwIfAborted();
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${accessToken}`);
        return fetcher(`https://api.openai.com/v1/${path}`, { ...init, headers, redirect: 'error' });
    };
    let response = await send(token.accessToken);
    if (response.status !== 401) return response;
    await response.body?.cancel();
    const renewed = validateToken(await session.getToken({ rejectedAccessToken: token.accessToken,
        signal: init.signal ?? undefined }));
    response = await send(renewed.accessToken);
    return response;
}

export function chatGPTFailure(error: unknown, fallback: string, status?: number): ChatGPTError {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    const reason = typeof code === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(code) ? code : fallback;
    return new ChatGPTError(reason, status);
}
