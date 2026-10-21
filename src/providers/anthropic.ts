import { decodeWireObject, parseWireEvent } from '../utils/wire-decoder';
// @file: driver-llm/providers/anthropic.ts

import { BaseProvider } from './base';
import {
    LLMProviderConfig,
    ChatCompletionParams,
    ChatCompletionResponse,
    ChatCompletionChunk,
    ChatMessage,
    ProviderCapabilities,
    ToolDefinition
} from '../types';
import { parseSSEStream } from '../utils/stream';
import { LLMError } from '../errors';

/**
 * Anthropic Provider
 * 
 * 特点：
 * 1. 使用不同的 API 结构
 * 2. 支持 extended thinking
 * 3. System message 单独处理
 */
export class AnthropicProvider extends BaseProvider {
    readonly name = 'anthropic';

    readonly capabilities: ProviderCapabilities = {
        vision: true,
        audioInput: false,
        audioOutput: false,
        video: false,
        documents: true,
        tools: true,
        parallelTools: true,
        structuredOutput: true,
        jsonMode: false,
        thinking: true,
        codeExecution: false,
        computerUse: true,  // Anthropic 特有
        mcp: true,          // Anthropic 特有
        caching: true,
        batch: true,
        streaming: true
    };

    private readonly API_VERSION = '2023-06-01';

    constructor(config: LLMProviderConfig) {
        super(config);
        if (!this.baseURL) {
            this.baseURL = 'https://api.anthropic.com';
        }
    }

    protected getProviderFormat(): 'openai' | 'anthropic' | 'gemini' {
        return 'anthropic';
    }

    async create(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
        this.validateParams(params);
        const processedParams = await this.preprocessMessages(params);

        const url = this.resolveMessagesUrl();
        const body = this.buildRequestBody(processedParams);

        const response = await this.fetchJSON<unknown>(url, {
            method: 'POST',
            headers: this.buildHeaders(processedParams),
            body: JSON.stringify(body),
            signal: params.signal
        });

        return this.normalizeResponse(decodeWireObject(response, 'content'));
    }

    async *stream(params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
        this.validateParams(params);
        const processedParams = await this.preprocessMessages(params);

        const url = this.resolveMessagesUrl();
        const body = this.buildRequestBody({ ...processedParams, stream: true });

        const stream = await this.fetchStream(url, {
            method: 'POST',
            headers: this.buildHeaders(processedParams),
            body: JSON.stringify(body),
            signal: params.signal
        });

        let currentThinking = '';
        let currentContent = '';
        const usage: Record<string, number> = {};

        for await (const data of parseSSEStream(stream)) {
            const event = this.decodeStreamEvent(data);
            if (!event) continue;
            Object.assign(usage, event.message?.usage ?? event.usage ?? {});
            const chunk = this.normalizeStreamEvent(event, currentThinking, currentContent, usage);

            if (chunk) {
                if (chunk.choices[0]?.delta.thinking) {
                    currentThinking += chunk.choices[0].delta.thinking;
                }
                if (chunk.choices[0]?.delta.content) {
                    currentContent += chunk.choices[0].delta.content;
                }
                yield chunk;
            }
        }
    }

    private decodeStreamEvent(data: string): Record<string, any> | null {
        let event: Record<string, any>;
        try { event = parseWireEvent(data); }
        catch { return null; }
        if (event.type === 'error') {
            const statuses: Record<string, number> = { overloaded_error: 529, rate_limit_error: 429,
                authentication_error: 401, permission_error: 403, invalid_request_error: 400 };
            throw LLMError.fromResponse(this.name, statuses[event.error?.type] ?? 500, event, this.defaultModel);
        }
        return event;
    }

    // ============== 请求构建 ==============

    /**
     * Resolve the actual Messages API URL.
     * Priority: anthropicPath > defaultPath > built-in default (/v1/messages).
     *
     * anthropicPath replaces the built-in /v1/messages suffix entirely,
     * so it must include the full path (e.g. "/anthropic/v1/messages").
     */
    private resolveMessagesUrl(): string {
        if (this.config.anthropicPath) {
            return this.trimBase() + this.config.anthropicPath;
        }
        return this.resolveEndpointUrl(this.config.defaultPath ?? '/v1/messages');
    }

    protected buildHeaders(params?: ChatCompletionParams): Record<string, string> {
        const base = 'computer-use-2024-10-22,prompt-caching-2024-07-31';
        // effort 模式需追加 beta header
        const effortBeta = 'effort-2025-11-24';
        const betaHeader = params?.thinking && params.reasoningEffort
            ? `${base},${effortBeta}`
            : base;
        return {
            ...super.buildHeaders(),
            'x-api-key': this.config.apiKey,
            'anthropic-version': this.API_VERSION,
            'anthropic-beta': betaHeader
        };
    }

    protected buildRequestBody(params: ChatCompletionParams): Record<string, any> {
        const { systemMessage, userMessages } = this.separateMessages(params.messages);

        const body: Record<string, any> = {
            model: this.getModel(params),
            messages: userMessages,
            max_tokens: params.maxTokens ?? 4096
        };

        // System message (支持缓存)
        if (systemMessage) {
            body.system = this.buildSystemContent(systemMessage, params.caching);
        }

        // 基础参数
        if (params.temperature !== undefined) body.temperature = params.temperature;
        if (params.topP !== undefined) body.top_p = params.topP;
        if (params.stop !== undefined) {
            body.stop_sequences = Array.isArray(params.stop) ? params.stop : [params.stop];
        }

        // 流式
        if (params.stream) {
            body.stream = true;
        }

        // Extended Thinking — 双模式：
        // 1. reasoningEffort → output_config.effort（需要 effort beta header，DeepSeek /anthropic 端点使用）
        // 2. thinking.budget_tokens → 精确控制 token 预算（标准 Anthropic API）
        // reasoningEffort 优先级高于 thinkingBudget。
        this.configureThinking(body, params);
        if (params.responseFormat?.type === 'json_schema') {
            body.output_config = { ...body.output_config,
                format: { type: 'json_schema', schema: params.responseFormat.json_schema.schema } };
        }

        // 工具 (包括 Computer Use)
        if (params.tools && params.tools.length > 0) {
            body.tools = this.convertTools(params.tools);

            if (params.toolChoice === 'required') {
                body.tool_choice = { type: 'any' };
            } else if (params.toolChoice === 'none') {
                body.tool_choice = { type: 'none' };
            } else if (typeof params.toolChoice === 'object' && 'function' in params.toolChoice) {
                body.tool_choice = {
                    type: 'tool',
                    name: params.toolChoice.function.name
                };
            }
        }

        // 元数据
        if (params.metadata) {
            body.metadata = params.metadata;
        }

        return body;
    }

    private configureThinking(body: Record<string, any>, params: ChatCompletionParams): void {
        const mode = params.thinking === undefined ? this.config.metadata?.thinkingMode
            : params.thinking ? 'enabled' : 'disabled';
        if (mode === 'disabled') { body.thinking = { type: 'disabled' }; return; }
        if (mode !== 'enabled') return;
        if (this.config.metadata?.reasoningTransport === 'adaptive') {
            body.thinking = { type: 'adaptive' };
            if (params.reasoningEffort) body.output_config = { effort: params.reasoningEffort };
            return;
        }
        const budget = params.thinkingBudget ?? this.config.metadata?.thinkingBudget
            ?? Math.min(10000, Math.floor(body.max_tokens / 2));
        if (!Number.isSafeInteger(budget) || budget < 1024 || budget >= body.max_tokens) {
            throw LLMError.fromResponse(this.name, 400, { message: 'Thinking budget must be at least 1024 and less than maxTokens' }, this.getModel(params));
        }
        body.thinking = { type: 'enabled', budget_tokens: budget };
        if (params.reasoningEffort) body.output_config = { effort: params.reasoningEffort };
    }

    /**
     * 构建 System 内容 (支持缓存)
     */
    private buildSystemContent(
        systemMessage: string,
        caching?: boolean | { ttl?: number }
    ): string | Array<{ type: string; text: string; cache_control?: { type: string } }> {
        if (!caching) {
            return systemMessage;
        }

        // 使用缓存格式
        return [{
            type: 'text',
            text: systemMessage,
            cache_control: { type: 'ephemeral' }
        }];
    }

    /**
     * 转换工具定义
     */
    private convertTools(tools: ToolDefinition[]): any[] {
        return tools
            .map(tool => {
            // Computer Use 工具
            if (tool.type === 'computer_20241022') {
                return {
                    type: 'computer_20241022',
                    name: 'computer',
                    display_width_px: tool.computer_use?.display_width || 1024,
                    display_height_px: tool.computer_use?.display_height || 768,
                    display_number: tool.computer_use?.display_number || 1
                };
            }

            // Bash 工具
            if (tool.type === 'bash_20241022') {
                return {
                    type: 'bash_20241022',
                    name: 'bash'
                };
            }

            // Text Editor 工具
            if (tool.type === 'text_editor_20241022') {
                return {
                    type: 'text_editor_20241022',
                    name: 'str_replace_editor'
                };
            }

            // 普通函数工具 — 兼容两种格式：
            //   common ToolDefinition: { function: { name, description, parameters } }
            //   legacy ToolDefinition: { name, description, parameters }
            return {
                name: tool.function?.name || tool.name || 'unknown',
                description: tool.function?.description || (tool as any).description || '',
                input_schema: tool.function?.parameters || (tool as any).parameters || { type: 'object', properties: {} },
            };
        });
    }

    /**
     * 分离 System 消息
     */
    private separateMessages(messages: ChatMessage[]): {
        systemMessage: string | null;
        userMessages: any[];
    } {
        let systemMessage: string | null = null;
        const userMessages: any[] = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                const content = typeof msg.content === 'string'
                    ? msg.content
                    : msg.content.map(p => p.type === 'text' ? p.text : '').join('\n');

                systemMessage = systemMessage
                    ? `${systemMessage}\n\n${content}`
                    : content;
            } else if (msg.role === 'tool') {
                // 工具结果
                userMessages.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: msg.tool_call_id,
                        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                    }]
                });
            } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                // Assistant message with tool_calls: convert to Anthropic content blocks
                const content = this.convertContent(msg.content);
                const contentBlocks: any[] = typeof content === 'string'
                    ? (content ? [{ type: 'text', text: content }] : [])
                    : content;
                for (const tc of msg.tool_calls) {
                    contentBlocks.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function?.name ?? tc.name,
                        input: (() => {
                            try {
                                return typeof tc.function?.arguments === 'string'
                                    ? JSON.parse(tc.function.arguments)
                                    : (tc.input ?? {});
                            } catch {
                                return {};
                            }
                        })(),
                    });
                }
                userMessages.push({ role: 'assistant', content: contentBlocks });
            } else {
                userMessages.push({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: this.convertContent(msg.content)
                });
            }
        }

        return { systemMessage, userMessages };
    }

    /**
     * 转换内容格式
     */
    private convertContent(content: ChatMessage['content']): any {
        if (typeof content === 'string') {
            return content;
        }

        return content.map(part => {
            switch (part.type) {
                case 'text':
                    const textPart: any = { type: 'text', text: part.text };
                    if ('cache_control' in part && part.cache_control) {
                        textPart.cache_control = part.cache_control;
                    }
                    return textPart;

                case 'image_url':
                case 'image':
                    // 处理 OpenAI 格式
                    if ('image_url' in part && part.image_url) {
                        const url = part.image_url.url;
                        if (url.startsWith('data:')) {
                            const [header, data] = url.split(',');
                            const mediaType = header.match(/data:(.*?);/)?.[1] || 'image/jpeg';
                            return {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: mediaType,
                                    data
                                }
                            };
                        }
                        return {
                            type: 'image',
                            source: { type: 'url', url }
                        };
                    }
                    // 处理 Anthropic 格式
                    if ('source' in part && part.source) {
                        return {
                            type: 'image',
                            source: part.source
                        };
                    }
                    return { type: 'text', text: '' };

                case 'file':
                case 'document':
                    // Anthropic 支持 PDF
                    const file = 'file' in part ? part.file : part.document;
                    if (file?.mime_type === 'application/pdf' && file.data) {
                        return {
                            type: 'document',
                            source: {
                                type: 'base64',
                                media_type: 'application/pdf',
                                data: file.data
                            }
                        };
                    }
                    return { type: 'text', text: `[Document: ${file?.filename || 'unknown'}]` };

                case 'tool_result':
                    return {
                        type: 'tool_result',
                        tool_use_id: part.tool_use_id,
                        content: part.content,
                        is_error: part.is_error
                    };

                case 'thinking':
                    return {
                        type: 'thinking',
                        thinking: part.thinking,
                        signature: part.signature,
                    };

                case 'tool_use':
                    return {
                        type: 'tool_use',
                        id: part.id,
                        name: part.name,
                        input: part.input,
                    };

                default:
                    return { type: 'text', text: '' };
            }
        });
    }

    // ============== 响应标准化 ==============

    protected normalizeResponse(response: any): ChatCompletionResponse {
        let content = '';
        let thinking = '';
        const toolCalls: any[] = [];

        for (const block of response.content || []) {
            if (block.type === 'text') {
                content += block.text;
            } else if (block.type === 'thinking') {
                thinking += block.thinking;
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    type: 'function',
                    function: {
                        name: block.name,
                        arguments: JSON.stringify(block.input)
                    }
                });
            }
        }

        return {
            id: response.id,
            model: response.model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content,
                    thinking: thinking || undefined,
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                },
                finish_reason: this.mapStopReason(response.stop_reason)
            }],
            usage: response.usage ? this.normalizeUsage(response.usage) : undefined,
            cache: response.usage?.cache_creation_input_tokens || response.usage?.cache_read_input_tokens ? {
                hit: (response.usage.cache_read_input_tokens || 0) > 0,
                cached_tokens: response.usage.cache_read_input_tokens
            } : undefined
        };
    }

    private normalizeUsage(usage: Record<string, number>) {
        const prompt = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
            + (usage.cache_creation_input_tokens ?? 0);
        const completion = usage.output_tokens ?? 0;
        return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
            cached_tokens: usage.cache_read_input_tokens,
            details: { reasoning_tokens: usage.thinking_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens } };
    }

    protected normalizeStreamEvent(
        event: any,
        _currentThinking: string,
        _currentContent: string,
        usage: Record<string, number> = {}
    ): ChatCompletionChunk | null {
        const type = event.type;

        switch (type) {
            case 'message_start':
                return {
                    id: event.message?.id,
                    model: event.message?.model,
                    usage: event.message?.usage ? this.normalizeUsage(usage) : undefined,
                    choices: [{
                        index: 0,
                        delta: { role: 'assistant' },
                        finish_reason: null
                    }]
                };

            case 'content_block_start':
                if (event.content_block?.type === 'tool_use') {
                    return {
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index: event.index || 0,
                                    id: event.content_block.id,
                                    type: 'function',
                                    function: {
                                        name: event.content_block.name,
                                        arguments: ''
                                    }
                                }]
                            },
                            finish_reason: null
                        }]
                    };
                }
                return null;

            case 'content_block_delta':
                const delta = event.delta;

                if (delta?.type === 'thinking_delta') {
                    return {
                        choices: [{
                            index: 0,
                            delta: { thinking: delta.thinking },
                            finish_reason: null
                        }]
                    };
                }

                if (delta?.type === 'text_delta') {
                    return {
                        choices: [{
                            index: 0,
                            delta: { content: delta.text },
                            finish_reason: null
                        }]
                    };
                }

                if (delta?.type === 'input_json_delta') {
                    return {
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index: event.index || 0,
                                    function: { arguments: delta.partial_json }
                                }]
                            },
                            finish_reason: null
                        }]
                    };
                }

                return null;

            case 'message_delta':
                return {
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: this.mapStopReason(event.delta?.stop_reason)
                    }],
                    usage: event.usage ? this.normalizeUsage(usage) : undefined
                };

            case 'message_stop':
                return null;

            default:
                return null;
        }
    }

    private mapStopReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | null {
        switch (reason) {
            case 'end_turn': return 'stop';
            case 'max_tokens': return 'length';
            case 'tool_use': return 'tool_calls';
            case 'stop_sequence': return 'stop';
            default: return null;
        }
    }
}
