import { ResponsesProvider } from './responses';
import { ChatGPTError, chatGPTFailure, fetchChatGPT } from './chatgpt-auth';
import { decodeWireObject, parseWireEvent } from '../utils/wire-decoder';
import type { ChatCompletionParams, ChatCompletionResponse, ChatCompletionChunk,
    LLMProviderConfig, ChatMessage } from '../types';

const unsupportedFields = ['temperature', 'max_output_tokens', 'top_p', 'stop', 'user', 'metadata'];

/** Sign in with ChatGPT plan usage; authentication is distinct from the Responses protocol. */
export class ChatGPTProvider extends ResponsesProvider {
    readonly name = 'chatgpt';
    protected readonly completeToolCallsOnly = true;
    readonly capabilities = {
        vision: true, documents: false, audioInput: false, audioOutput: false, video: false, tools: true,
        parallelTools: true, structuredOutput: true, jsonMode: true, thinking: true, caching: false,
        codeExecution: false, computerUse: false, mcp: false, batch: false, streaming: true,
    };

    constructor(config: LLMProviderConfig) {
        super({ ...config, apiBaseUrl: 'https://api.openai.com/v1', defaultPath: '/responses' });
        if (!config.chatgpt?.session) throw new ChatGPTError('auth_session_required', 401);
        if (config.protocol && config.protocol !== 'openai-responses') throw new ChatGPTError('responses_protocol_required');
        if (config.apiBaseUrl && config.apiBaseUrl.replace(/\/+$/, '') !== 'https://api.openai.com/v1') {
            throw new ChatGPTError('unsupported_endpoint');
        }
        if (config.defaultPath && !['/responses', '/v1/responses'].includes(config.defaultPath)) {
            throw new ChatGPTError('unsupported_endpoint');
        }
    }

    /** The public non-streaming interface collects the required wire stream to completion. */
    async create(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
        let response: ChatCompletionResponse | undefined;
        try {
            for await (const _chunk of this.streamResponse(params, wire => { response = this.normalizeResponse(wire); })) {
                // Use the full terminal response, including tools and usage.
            }
            return response!;
        } catch (error) { throw nonRetryable(error, params.signal); }
    }

    async *stream(params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
        try { yield* super.stream(params); }
        catch (error) { throw nonRetryable(error, params.signal); }
    }

    validateParams(params: ChatCompletionParams): void {
        if (params.audioInput || params.audioOutput || params.codeExecution) throw new ChatGPTError('unsupported_feature');
        validateInputs({ ...params, model: this.getModel(params) });
        super.validateParams(params);
    }

    protected buildResponsesBody(params: ChatCompletionParams): Record<string, any> {
        const messages = normalizeMessages(params.messages);
        const body = super.buildResponsesBody({ ...params, messages });
        for (const key of unsupportedFields) delete body[key];
        body.store = false;
        body.stream = true;
        const functions = (body.tools ?? []).filter((tool: any) => tool.type === 'function');
        const hosted = (body.tools ?? []).filter((tool: any) => tool.type !== 'function');
        if (hosted.some((tool: any) => !['web_search', 'web_search_2025_08_26'].includes(tool.type))) {
            throw new ChatGPTError('unsupported_tool');
        }
        if (functions.length) body.tools = [{ type: 'namespace', name: 'functions',
            description: 'Functions executed by the client.', tools: functions }, ...hosted];
        for (const item of body.input) if (item.type === 'function_call') item.namespace = 'functions';
        return body;
    }

    protected async fetchStream(_url: string, options: RequestInit): Promise<ReadableStream<Uint8Array>> {
        try {
            const response = await fetchChatGPT(this.config.chatgpt!.session, 'responses', options, this.config.fetch);
            const headers = Object.fromEntries(response.headers.entries());
            this.hooks?.onResponseHeaders?.(headers, response.status);
            if (!response.ok) {
                const body = await response.json().catch(() => undefined);
                throw chatGPTFailure(body?.error, `http_${response.status}`, response.status);
            }
            if (!response.body) throw new ChatGPTError('missing_response_body');
            return response.body;
        } catch (error) { throw nonRetryable(error, options.signal ?? undefined); }
    }

    protected validateStreamEvent(event: string | undefined, payload: any): void {
        if (event === 'error' || event === 'response.failed') {
            throw chatGPTFailure(payload.response?.error ?? payload.error ?? payload, 'response_failed');
        }
        if (event === 'response.incomplete') throw new ChatGPTError('response_incomplete');
        if (event === 'response.completed') {
            const response = payload.response ?? payload;
            if (response.status !== 'completed' || !Array.isArray(response.output)) {
                throw new ChatGPTError('invalid_completed_response');
            }
            try { decodeWireObject(response, 'output'); }
            catch { throw new ChatGPTError('invalid_completed_response'); }
        }
    }

    protected safeJson(data: string): any {
        try { return parseWireEvent(data); }
        catch { throw new ChatGPTError('invalid_stream_event'); }
    }

    protected validateStreamEnd(terminal?: string): void {
        if (terminal !== 'response.completed') throw new ChatGPTError('stream_interrupted');
    }
}

function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.flatMap(message => {
        if (message.role === 'system' && Array.isArray(message.content)) {
            return [{ ...message, content: message.content.map(part => part.type === 'text' ? part.text : '').join('\n') }];
        }
        if (message.role === 'assistant' && message.tool_calls?.length && message.content.length) {
            return [{ ...message, tool_calls: undefined }, { ...message, content: '' }];
        }
        return [message];
    });
}

function validateInputs(params: ChatCompletionParams): void {
    if (!params.model?.trim()) throw new ChatGPTError('model_required');
    if (params.retrieval || params.modalities?.some(value => value !== 'text')) throw new ChatGPTError('unsupported_output');
    for (const message of params.messages) {
        if (typeof message.content === 'string') continue;
        if (message.content.some(part => !['text', 'image_url'].includes(part.type))) throw new ChatGPTError('unsupported_input');
        if (message.role === 'system' && message.content.some(part => part.type !== 'text')) {
            throw new ChatGPTError('unsupported_system_content');
        }
    }
}

function nonRetryable(error: unknown, signal?: AbortSignal): unknown {
    signal?.throwIfAborted();
    return error instanceof ChatGPTError ? error : new ChatGPTError('transport_interrupted');
}
