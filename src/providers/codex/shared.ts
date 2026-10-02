// @file: driver-llm/providers/codex/shared.ts
// Provider-neutral helpers shared by the `codex exec` and `codex app-server`
// adapters (message text, stream chunks, param validation, runtime detection).

import type { ChatCompletionChunk, ChatCompletionParams } from '../../types';

/** Raw JSON-line event emitted by `codex exec --json`. */
export type CodexEvent = {
    type: string;
    thread_id?: string;
    item?: { type?: string; text?: string };
    usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
    };
};

export const CODEX_DEFAULT_MODEL = 'gpt-5.6-sol';

/** True when executing under Node (vs browser/Tauri), for lazy runtime imports. */
export function isNodeRuntime(): boolean {
    return typeof process !== 'undefined' && Boolean(process.versions?.node);
}

/** Text of a chat message (string content or multipart content parts). */
export function messageText(message: ChatCompletionParams['messages'][number]): string {
    if (typeof message.content === 'string') return message.content;
    return message.content
        .map(part => (part.type === 'text' ? part.text : JSON.stringify(part)))
        .join('\n');
}

/** Try to parse assistant content as JSON (structured output); `{}` when not JSON. */
export function parsedContent(content: string): { parsed?: unknown } {
    try {
        return { parsed: JSON.parse(content) };
    } catch {
        return {};
    }
}

/** Reject params the current Codex mode cannot honour. */
export function validateCodexParams(
    params: ChatCompletionParams,
    mode: 'exec' | 'app-server',
): void {
    if (params.audioOutput) {
        throw new Error('Provider codex does not support audio output');
    }
    const bad = params.messages
        .flatMap(message => message.attachments ?? [])
        .find(attachment => attachment.type === 'video' || (mode === 'exec' && attachment.type === 'audio'));
    if (bad) {
        throw new Error(`Provider codex does not support ${bad.type} attachments in ${mode} mode`);
    }
}

/** Build a provider-neutral stream chunk. */
export function contentChunk(
    id: string | undefined,
    model: string,
    content: string,
    finishReason: 'stop' | null,
): ChatCompletionChunk {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finishReason }],
    };
}
