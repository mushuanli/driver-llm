// @file: driver-llm/providers/codex/app-server-adapter.ts
// Persistent `codex app-server` JSON-RPC adapter. Maintains the thread/turn
// state machine and bridges dynamic tool calls back to caller tool results.

import type {
    ChatCompletionChunk,
    ChatCompletionParams,
    ChatCompletionResponse,
    CodexAppServerTransport,
    CodexRPCMessage,
    LLMProviderConfig,
    TokenUsage,
    ToolCall,
} from '../../types';
import {
    contentChunk,
    isNodeRuntime,
    messageText,
    parsedContent,
    validateCodexParams,
} from './shared';

export class CodexAppServerAdapter {
    private appTransport?: Promise<CodexAppServerTransport>;
    private threadId?: string;
    private turnId?: string;
    private submittedMessageCount = 0;
    private threadSignature?: string;
    private pendingTool?: { rpcId: string | number; callId: string };

    constructor(private readonly config: LLMProviderConfig) {}

    private get command(): string {
        return this.config.codex?.command ?? 'codex';
    }

    async create(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
        let content = '';
        let thinking = '';
        let usage: TokenUsage | undefined;
        let id: string | undefined;
        let toolCalls: ToolCall[] | undefined;
        for await (const chunk of this.stream(params)) {
            id = chunk.id ?? id;
            content += chunk.choices[0]?.delta.content ?? '';
            thinking += chunk.choices[0]?.delta.thinking ?? '';
            if (chunk.choices[0]?.delta.tool_calls?.length) {
                toolCalls = chunk.choices[0].delta.tool_calls as ToolCall[];
            }
            usage = chunk.usage ?? usage;
        }
        return {
            id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: this.resolveModel(params),
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: toolCalls ? null : content,
                    ...(thinking ? { thinking } : {}),
                    ...(toolCalls ? { tool_calls: toolCalls } : {}),
                    ...parsedContent(content),
                },
                finish_reason: toolCalls ? 'tool_calls' : 'stop',
            }],
            usage,
        };
    }

    async *stream(params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
        validateCodexParams(params, 'app-server');
        const transport = await this.getAppTransport();
        // Subscribe before starting/resuming a turn so early deltas cannot race
        // ahead of the response to `turn/start`.
        const events = transport.events();
        const model = this.resolveModel(params);
        await this.ensureThread(params, transport, model);
        await this.startTurn(params, transport, model);

        const abort = () => {
            if (this.threadId && this.turnId) {
                void transport.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
            }
        };
        params.signal?.addEventListener('abort', abort, { once: true });
        try {
            yield* this.consumeAppEvents(events, model);
        } finally {
            params.signal?.removeEventListener('abort', abort);
        }
    }

    /** Release a lazily-started local transport. Injected transports are caller-owned. */
    async dispose(): Promise<void> {
        if (!this.appTransport) return;
        const transport = await this.appTransport;
        this.appTransport = undefined;
        await transport.close?.();
    }

    private resolveModel(params: ChatCompletionParams): string | undefined {
        return params.model || this.config.model || undefined;
    }

    private async getAppTransport(): Promise<CodexAppServerTransport> {
        if (this.config.codex?.transport) return this.config.codex.transport;
        if (!isNodeRuntime()) {
            throw new Error('Codex app-server requires an injected transport in browser/Tauri environments');
        }
        if (!this.appTransport) {
            this.appTransport = import('../../runtime/node-codex-app-server-transport')
                .then(({ NodeCodexAppServerTransport }) =>
                    NodeCodexAppServerTransport.create(this.command, this.config.codex?.cwd))
                .catch((cause: unknown) => {
                    throw new Error('Codex app-server requires an injected transport in browser/Tauri environments', { cause });
                });
        }
        return this.appTransport;
    }

    /** Reuse or create the app-server thread for this (model, tools, system) signature. */
    private async ensureThread(
        params: ChatCompletionParams,
        transport: CodexAppServerTransport,
        model: string | undefined,
    ): Promise<void> {
        const signature = JSON.stringify({
            model,
            tools: params.tools ?? [],
            toolChoice: params.toolChoice ?? 'auto',
            system: params.messages.filter(message => message.role === 'system' || message.role === 'developer'),
        });
        if (this.threadId && this.threadSignature === signature && params.messages.length >= this.submittedMessageCount) {
            return;
        }
        const started = await transport.request<any>('thread/start', {
            ...(model ? { model } : {}),
            cwd: this.config.codex?.cwd ?? null,
            approvalPolicy: 'never',
            dynamicTools: this.dynamicTools(params),
            ephemeral: true,
            baseInstructions: this.systemInstructions(params),
        });
        this.threadId = started.thread.id;
        this.threadSignature = signature;
        this.submittedMessageCount = 0;
        this.pendingTool = undefined;
    }

    /** Respond to a pending tool call, or start the next turn with the new messages. */
    private async startTurn(
        params: ChatCompletionParams,
        transport: CodexAppServerTransport,
        model: string | undefined,
    ): Promise<void> {
        const toolResult = this.pendingTool
            ? params.messages.find(message => message.role === 'tool' && message.tool_call_id === this.pendingTool?.callId)
            : undefined;
        if (this.pendingTool && toolResult) {
            await transport.respond(this.pendingTool.rpcId, {
                success: true,
                contentItems: [{ type: 'inputText', text: messageText(toolResult) }],
            });
            this.pendingTool = undefined;
            this.submittedMessageCount = params.messages.length;
            return;
        }
        const input = this.toUserInputs(params.messages.slice(this.submittedMessageCount));
        const started = await transport.request<any>('turn/start', {
            threadId: this.threadId,
            input,
            ...(model ? { model } : {}),
            effort: params.reasoningEffort ?? this.config.metadata?.reasoningEffort ?? 'high',
            outputSchema: params.responseFormat?.type === 'json_schema'
                ? params.responseFormat.json_schema.schema
                : params.responseFormat?.type === 'json_object'
                    ? { type: 'object' }
                    : null,
        });
        this.turnId = started.turn.id;
        this.submittedMessageCount = params.messages.length;
    }

    /** Consume app-server events until the turn completes (or a tool call is requested). */
    private async *consumeAppEvents(
        events: AsyncIterable<CodexRPCMessage>,
        model: string | undefined,
    ): AsyncGenerator<ChatCompletionChunk> {
        for await (const event of events) {
            const p = event.params ?? {};
            if (p.threadId && p.threadId !== this.threadId) continue;
            if (p.turnId && this.turnId && p.turnId !== this.turnId) continue;

            if (event.method === 'item/agentMessage/delta') {
                yield contentChunk(this.threadId, model, p.delta ?? '', null);
            } else if (event.method === 'item/reasoning/textDelta' || event.method === 'item/reasoning/summaryTextDelta') {
                yield {
                    ...contentChunk(this.threadId, model, '', null),
                    choices: [{ index: 0, delta: { role: 'assistant', thinking: p.delta ?? '' }, finish_reason: null }],
                };
            } else if (event.method === 'thread/tokenUsage/updated') {
                yield {
                    ...contentChunk(this.threadId, model, '', null),
                    usage: this.mapAppUsage(p.tokenUsage?.last),
                };
            } else if (event.method === 'item/tool/call' && event.id != null) {
                const call: ToolCall = {
                    id: p.callId,
                    type: 'function',
                    function: { name: p.tool, arguments: JSON.stringify(p.arguments ?? {}) },
                };
                this.pendingTool = { rpcId: event.id, callId: p.callId };
                yield {
                    ...contentChunk(this.threadId, model, '', null),
                    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: 'tool_calls' }],
                };
                return;
            } else if (event.method === 'turn/completed') {
                if (p.turn?.status === 'failed') {
                    throw new Error(p.turn.error?.message ?? 'Codex turn failed');
                }
                // The native thread now contains the generated assistant message;
                // skip that message when callers send the full history next round.
                this.submittedMessageCount += 1;
                yield contentChunk(this.threadId, model, '', 'stop');
                return;
            } else if (event.method === 'error') {
                throw new Error(p.message ?? 'Codex app-server error');
            }
        }
    }

    private dynamicTools(params: ChatCompletionParams): any[] {
        if (params.toolChoice === 'none') return [];
        return (params.tools ?? [])
            .filter(tool => tool.function?.name)
            .map(tool => ({
                type: 'function',
                name: tool.function!.name,
                description: tool.function!.description ?? '',
                inputSchema: tool.function!.parameters ?? { type: 'object' },
            }));
    }

    private systemInstructions(params: ChatCompletionParams): string | null {
        const parts = params.messages
            .filter(message => message.role === 'system' || message.role === 'developer')
            .map(message => messageText(message));
        if (params.toolChoice === 'required') {
            parts.push('You must call one of the provided dynamic tools before answering.');
        } else if (typeof params.toolChoice === 'object') {
            const name = 'function' in params.toolChoice
                ? params.toolChoice.function.name
                : 'name' in params.toolChoice
                    ? params.toolChoice.name
                    : undefined;
            if (name) parts.push(`You must call the dynamic tool named ${name} before answering.`);
        }
        return parts.join('\n\n') || null;
    }

    private toUserInputs(messages: ChatCompletionParams['messages']): any[] {
        return messages
            .filter(message => message.role !== 'system' && message.role !== 'developer' && message.role !== 'tool')
            .flatMap(message => {
                const inputs: any[] = [{
                    type: 'text',
                    text: `${message.role}: ${messageText(message)}`,
                    text_elements: [],
                }];
                for (const attachment of message.attachments ?? []) {
                    if (typeof attachment.source !== 'string') continue;
                    if (attachment.type === 'image') {
                        inputs.push(/^(data:|https?:)/.test(attachment.source)
                            ? { type: 'image', url: attachment.source }
                            : { type: 'localImage', path: attachment.source });
                    } else if (attachment.type === 'audio') {
                        inputs.push(/^(data:|https?:)/.test(attachment.source)
                            ? { type: 'audio', url: attachment.source }
                            : { type: 'localAudio', path: attachment.source });
                    } else if ((attachment.type === 'file' || attachment.type === 'text') && !/^(data:|https?:)/.test(attachment.source)) {
                        inputs.push({
                            type: 'mention',
                            name: attachment.name ?? attachment.filename ?? 'file',
                            path: attachment.source,
                        });
                    }
                }
                return inputs;
            });
    }

    private mapAppUsage(usage?: any): TokenUsage | undefined {
        if (!usage) return undefined;
        return {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
            cached_tokens: usage.cachedInputTokens,
            thinking_tokens: usage.reasoningOutputTokens,
            details: { cache_write_input_tokens: usage.cacheWriteInputTokens ?? 0 },
        };
    }
}
