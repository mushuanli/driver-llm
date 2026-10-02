// @file: driver-llm/providers/codex/exec-adapter.ts
// Legacy one-shot `codex exec --json` adapter. Spawns a fresh process per call,
// parses the JSON-line event stream, and maps it to provider-neutral outputs.

import type {
    ChatCompletionChunk,
    ChatCompletionParams,
    ChatCompletionResponse,
    CodexCommandRunner,
    LLMProviderConfig,
    TokenUsage,
    ToolCall,
} from '../../types';
import {
    CODEX_DEFAULT_MODEL,
    contentChunk,
    isNodeRuntime,
    parsedContent,
    validateCodexParams,
    type CodexEvent,
} from './shared';

export class CodexExecAdapter {
    constructor(private readonly config: LLMProviderConfig) {}

    private get command(): string {
        return this.config.codex?.command ?? 'codex';
    }

    async create(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
        validateCodexParams(params, 'exec');
        const model = this.resolveModel(params);
        const runner = await this.getRunner();
        const result = await runner.run(
            this.command,
            this.buildArgs(params, model),
            this.runOptions(params),
        );
        return this.toResponse(this.parseLines(result.stdout), model);
    }

    async *stream(params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
        validateCodexParams(params, 'exec');
        const model = this.resolveModel(params);
        const runner = await this.getRunner();
        if (!runner.stream) {
            const response = await this.create({ ...params, stream: false });
            yield this.responseChunk(response);
            return;
        }

        let buffer = '';
        let id: string | undefined;
        for await (const raw of runner.stream(this.command, this.buildArgs(params, model), this.runOptions(params))) {
            buffer += raw;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const event of this.parseLines(lines)) {
                if (event.type === 'thread.started') id = event.thread_id;
                if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
                    yield contentChunk(id, model, event.item.text ?? '', null);
                } else if (event.type === 'turn.completed') {
                    yield { ...contentChunk(id, model, '', 'stop'), usage: this.mapUsage(event.usage) };
                }
            }
        }
        for (const event of this.parseLines(buffer.split(/\r?\n/))) {
            if (event.type === 'turn.completed') {
                yield { ...contentChunk(id, model, '', 'stop'), usage: this.mapUsage(event.usage) };
            }
        }
    }

    private resolveModel(params: ChatCompletionParams): string {
        return params.model || this.config.model || CODEX_DEFAULT_MODEL;
    }

    private async getRunner(): Promise<CodexCommandRunner> {
        if (this.config.codex?.runner) return this.config.codex.runner;
        if (!isNodeRuntime()) {
            throw new Error('Codex requires an injected runner in browser/Tauri environments');
        }
        try {
            return (await import('../../runtime/node-codex-runner')).nodeCodexCommandRunner;
        } catch (cause) {
            throw new Error('Codex requires an injected runner in browser/Tauri environments', { cause });
        }
    }

    private runOptions(params: ChatCompletionParams): { signal?: AbortSignal; cwd?: string } {
        return { signal: params.signal, cwd: this.config.codex?.cwd };
    }

    private buildArgs(params: ChatCompletionParams, model: string): string[] {
        const effort =
            params.reasoningEffort ??
            (this.config.metadata?.reasoningEffort as string | undefined) ??
            'high';
        return [
            'exec',
            '--skip-git-repo-check',
            '--json',
            '--color',
            'never',
            '-m',
            model,
            '-c',
            `model_reasoning_effort=${JSON.stringify(effort)}`,
            ...this.localImagePaths(params).flatMap(path => ['--image', path]),
            ...(this.config.codex?.args ?? []),
            this.renderPrompt(params),
        ];
    }

    private renderPrompt(params: ChatCompletionParams): string {
        const messages = params.messages
            .map(message => `${message.role}: ${this.renderContent(message.content)}`)
            .join('\n\n');

        const instructions: string[] = [];
        if (params.responseFormat?.type === 'json_object') {
            instructions.push('Return only a valid JSON object.');
        }
        if (params.responseFormat?.type === 'json_schema') {
            instructions.push(
                `Return only JSON matching this schema: ${JSON.stringify(params.responseFormat.json_schema.schema)}`,
            );
        }
        if (params.tools?.length) {
            instructions.push(
                `Available caller tools: ${JSON.stringify(params.tools)}. If one is needed, return only {"tool_calls":[{"id":"...","type":"function","function":{"name":"...","arguments":"{...}"}}]}. Otherwise answer normally.`,
            );
        }
        return [messages, ...instructions].filter(Boolean).join('\n\n');
    }

    private renderContent(content: ChatCompletionParams['messages'][number]['content']): string {
        if (typeof content === 'string') return content;
        return content
            .map(part => {
                if (part.type === 'text') return part.text;
                if (part.type === 'tool_result') {
                    const value = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
                    return `Tool result (${part.tool_use_id}): ${value}`;
                }
                if (part.type === 'file' || part.type === 'document') {
                    return this.fileText(part.file ?? part.document);
                }
                if (part.type === 'image' || part.type === 'image_url') return '[Attached image]';
                return JSON.stringify(part);
            })
            .join('\n');
    }

    private toResponse(events: CodexEvent[], model: string): ChatCompletionResponse {
        const id = events.find(event => event.type === 'thread.started')?.thread_id
            ?? `codex-${Date.now().toString(36)}`;
        const content = events
            .filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message')
            .map(event => event.item?.text ?? '')
            .join('');
        const usage = events.filter(event => event.type === 'turn.completed').at(-1)?.usage;
        const toolCalls = this.parseToolCalls(content);
        return {
            id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: toolCalls ? null : content,
                    ...(toolCalls ? { tool_calls: toolCalls } : {}),
                    ...parsedContent(content),
                },
                finish_reason: toolCalls ? 'tool_calls' : 'stop',
            }],
            usage: this.mapUsage(usage),
        };
    }

    private parseLines(text: string | string[]): CodexEvent[] {
        const lines = Array.isArray(text) ? text : text.split(/\r?\n/);
        return lines
            .filter(line => line.trim().startsWith('{'))
            .flatMap(line => {
                try {
                    return [JSON.parse(line) as CodexEvent];
                } catch {
                    return [];
                }
            });
    }

    private mapUsage(usage?: CodexEvent['usage']): TokenUsage | undefined {
        if (!usage) return undefined;
        return {
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            cached_tokens: usage.cached_input_tokens,
            thinking_tokens: usage.reasoning_output_tokens,
            details: { cache_write_input_tokens: usage.cache_write_input_tokens ?? 0 },
        };
    }

    private parseToolCalls(content: string): ToolCall[] | undefined {
        try {
            const value = JSON.parse(content);
            return Array.isArray(value?.tool_calls) ? value.tool_calls : undefined;
        } catch {
            return undefined;
        }
    }

    private localImagePaths(params: ChatCompletionParams): string[] {
        return params.messages
            .flatMap(message => message.attachments ?? [])
            .filter(attachment => attachment.type === 'image')
            .map(attachment => attachment.source)
            .filter((source): source is string => typeof source === 'string' && !/^(data:|https?:)/.test(source));
    }

    private fileText(file?: { data?: string; source?: unknown; filename?: string }): string {
        const value = file?.data ?? (typeof file?.source === 'string' ? file.source : undefined);
        return value ? `[File ${file?.filename ?? ''}]\n${value}` : `[File ${file?.filename ?? ''}]`;
    }

    private responseChunk(response: ChatCompletionResponse): ChatCompletionChunk {
        return {
            ...contentChunk(
                response.id,
                response.model ?? '',
                response.choices[0]?.message.content ?? '',
                response.choices[0]?.finish_reason === 'stop' ? 'stop' : null,
            ),
            usage: response.usage,
        };
    }
}
