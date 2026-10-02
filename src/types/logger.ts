/**
 * @file common/interfaces/ILLMLogger.ts
 * @description LLM message logger — records conversation content to VFS /var/log/llm/
 *
 * Web:  NoopLLMLogger (no-op, browser DevTools Network panel is sufficient)
 * Tauri: TauriLLMLogger persists to {rootDir}/var/log/llm/{session}.json
 *
 * Each session file is a single JSON object with the latest exchange:
 *   { ts, session, request: { provider, model, url, messages, params },
 *     response: { status, headers }, messages: [{role, content, ts}] }
 */

import type { ChatMessage } from './message';

/** Full request snapshot logged before the HTTP call */
export interface LLMRequestLog {
    provider: string;
    model: string;
    messages: ChatMessage[];
    params: Record<string, unknown>;
}

/** Response metadata captured from the HTTP response */
export interface LLMResponseLog {
    status: number;
    headers: Record<string, string>;
}

/** LLM message logger — platform-agnostic interface */
export interface ILLMLogger {
    /**
     * Log a single message (user / assistant / system).
     * For stream mode, the caller accumulates all chunks and calls once
     * with the complete assistant response.
     */
    logMessage(session: string, role: 'user' | 'assistant' | 'system', content: string): void;

    /** Log the full outgoing request (messages array + params). Called before fetch. */
    logRequest(session: string, request: LLMRequestLog): void;

    /** Log HTTP response metadata (status code + headers). Called after fetch. */
    logResponse(session: string, response: LLMResponseLog): void;
}
