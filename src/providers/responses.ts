import { decodeWireObject, parseWireEvent } from '../utils/wire-decoder';
// @file: driver-llm/providers/responses.ts

import { BaseProvider } from './base';
import {
    LLMProviderConfig,
    ChatCompletionParams,
    ChatCompletionResponse,
    ChatCompletionChunk,
    ProviderCapabilities,
    ToolChoice,
} from '../types';
import type { ChatMessage, ToolCall, Citation } from '../types';
import { parseEventStream } from '../utils/stream';

/**
 * OpenAI Responses API Provider
 *
 * 新一代接口（DeepSeek / OpenAI 均提供）：
 * - 端点：POST {base}/responses
 * - 请求用 `input` items + `instructions`（替代 messages 数组的 system role）
 * - 响应用 `output[]` items（无 choices），文本在 output[].content[].text
 * - 工具 schema 扁平化（{type,name,description,parameters}，无 function 嵌套）
 * - 流式用语义化 SSE 事件（event: 行 + data: JSON，无 [DONE]）
 *
 * DeepSeek 模式（config.responses.defaultThinkingEnabled）额外兼容：
 * - `reasoning.effort` 控制思考（none/minimal/low/medium/high/xhigh/max，默认开启）
 * - `web_search` / `web_search_2025_08_26` 内置联网搜索工具（服务端执行）
 * - `tool_choice` 支持 none/auto/required/指定工具
 * - 不支持的参数被服务端静默忽略（无状态 API，previous_response_id 等不可用）
 *
 * 内部将外部统一的 ChatCompletionParams 双向转换为 Responses 格式。
 */
export class ResponsesProvider extends BaseProvider {
    readonly name = 'responses';

    readonly capabilities: ProviderCapabilities = {
        vision: true,
        audioInput: false,
        audioOutput: false,
        video: false,
        documents: true,
        tools: true,
        parallelTools: true,
        structuredOutput: true,
        jsonMode: true,
        thinking: true,
        codeExecution: false,
        computerUse: false,
        mcp: false,
        caching: true,
        batch: false,
        streaming: true,
    };

    /** 是否为 DeepSeek Responses API 模式（能力位 responses.defaultThinkingEnabled 控制 reasoning 兼容行为） */
    constructor(config: LLMProviderConfig) {
        super(config);
        if (!this.baseURL) {
            this.baseURL = 'https://api.deepseek.com';
        }
    }

    protected getProviderFormat(): 'openai' | 'anthropic' | 'gemini' {
        return 'openai';
    }

    /** DeepSeek / OpenAI 均使用 Bearer Token 认证 */
    protected buildHeaders(): Record<string, string> {
        const headers = super.buildHeaders();
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        return headers;
    }

    private resolveResponsesUrl(): string {
        return this.resolveEndpointUrl(this.config.defaultPath ?? '/responses');
    }

    // ============== 主入口 ==============

    async create(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
        this.validateParams(params);

        const url = this.resolveResponsesUrl();
        const body = this.buildResponsesBody(params);

        const response = await this.fetchJSON<unknown>(url, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: params.signal,
        });

        return this.normalizeResponse(decodeWireObject(response, 'output'));
    }

    async *stream(params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
        this.validateParams(params);

        const url = this.resolveResponsesUrl();
        const body = this.buildResponsesBody({ ...params, stream: true });

        const raw = await this.fetchStream(url, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: params.signal,
        });

        const aggregator = new StreamAggregator();
        for await (const { event, data } of parseEventStream(raw)) {
            const payload = this.safeJson(data);
            if (!payload) continue;

            // 终态事件 — 刷新 usage / citations 后结束（内容已逐 delta 发出，此处补 usage/finish/citations）
            if (event === 'response.completed' || event === 'response.incomplete' || event === 'response.failed') {
                // DeepSeek 终态事件把完整 response 对象嵌套在 payload.response 下
                // （usage / output 均在 response.*），OpenAI 兼容形状则在顶层。
                const usage = payload.usage ?? payload.response?.usage;
                if (usage) aggregator.usage = this.normalizeUsage(usage);
                // 内置 web_search 结果在终态 response.output 中（web_search_call item）
                const output = payload.output ?? payload.response?.output ?? [];
                const citations = collectCitations(output);
                if (citations.length) aggregator.citations = citations;
                const final = aggregator.finalize(event === 'response.failed');
                if (final) yield final;
                break;
            }

            const chunk = this.handleStreamEvent(event, payload, aggregator);
            if (chunk) yield chunk;
        }
    }

    // ============== 请求构建 ==============

    private buildResponsesBody(params: ChatCompletionParams): Record<string, any> {
        const { instructions, input } = this.convertMessagesToInput(params.messages);
        const body: Record<string, any> = {
            model: this.getModel(params),
            input,
        };
        if (instructions) body.instructions = instructions;
        if (params.stream) body.stream = true;
        if (params.temperature !== undefined) body.temperature = params.temperature;
        if (params.maxTokens !== undefined) body.max_output_tokens = params.maxTokens;
        if (params.topP !== undefined) body.top_p = params.topP;
        if (params.stop !== undefined) body.stop = params.stop;
        if (params.user !== undefined) body.user = params.user;
        if (params.metadata) body.metadata = params.metadata;

        if (params.tools && params.tools.length > 0) {
            body.tools = this.convertToolsToFlat(params.tools);
            if (params.toolChoice) body.tool_choice = this.convertToolChoice(params.toolChoice);
            if (params.parallelToolCalls !== undefined) body.parallel_tool_calls = params.parallelToolCalls;
        }
        // 内置联网搜索工具（DeepSeek / OpenAI Responses 服务端执行）
        if (params.webSearch) {
            body.tools = [...(body.tools ?? []), { type: 'web_search' }];
        }
        if (params.responseFormat) {
            body.text = this.convertResponseFormat(params.responseFormat);
        }

        // reasoning.effort — 思考模式配置（DeepSeek Responses API 兼容）
        const reasoning = this.resolveReasoning(params);
        if (reasoning) body.reasoning = reasoning;

        return body;
    }

    /**
     * 解析 reasoning 配置（DeepSeek Responses API 兼容）。
     *
     * DeepSeek effort 取值：none / minimal / low / medium / high / xhigh / max，
     * 其中 `none` 关闭思考模式；本系统暴露的 low / medium / xhigh 均为支持值。
     * 优先级：params.reasoningEffort > connection metadata.reasoningEffort > params.thinking。
     * - thinking=false 且 defaultThinkingEnabled（服务端默认开启思考）→ effort='none'
     * - metadata.thinkingMode='disabled'（模型级）→ effort='none'
     * - 其余情况不传 reasoning → 使用模型默认思考行为（默认开启）
     */
    private resolveReasoning(params: ChatCompletionParams): { effort: string } | undefined {
        const effort = params.reasoningEffort
            ?? (this.config.metadata?.reasoningEffort as string | undefined);
        if (effort) return { effort };
        const thinkingMode = this.config.metadata?.thinkingMode as string | undefined;
        // 服务端默认开启思考的厂商（如 DeepSeek）需显式 effort='none' 才能关闭；
        // 默认关闭思考的厂商（OpenAI 等）无需传 reasoning。
        if (this.config.responses?.defaultThinkingEnabled
            && (params.thinking === false || thinkingMode === 'disabled')) {
            return { effort: 'none' };
        }
        return undefined;
    }

    /** 统一 ToolChoice → Responses API tool_choice 格式。 */
    private convertToolChoice(choice: ToolChoice): any {
        if (typeof choice === 'string') return choice;
        if (choice.type === 'function' && choice.function?.name) {
            return { type: 'function', name: choice.function.name };
        }
        if (choice.type === 'tool' && choice.name) {
            return { type: 'function', name: choice.name };
        }
        // Anthropic 风格 "any" → Responses 强制调用工具
        if (choice.type === 'any') return 'required';
        return choice;
    }

    /**
     * 将统一 ChatMessage[] 转为 Responses input items。
     * - system 消息 → 提取为 instructions（顶层字段）
     * - user/assistant → { type: 'message', role, content }
     * - tool 结果 → { type: 'function_call_output', call_id, output }
     * - assistant 历史 tool_calls → { type: 'function_call', call_id, name, arguments }
     */
    private convertMessagesToInput(messages: ChatMessage[]): { instructions: string; input: any[] } {
        const instructions = messages
            .filter(m => m.role === 'system')
            .map(m => typeof m.content === 'string' ? m.content : '')
            .filter(Boolean)
            .join('\n');

        const items: any[] = [];
        for (const msg of messages) {
            if (msg.role === 'system') continue;

            if (msg.role === 'tool') {
                items.push({
                    type: 'function_call_output',
                    call_id: msg.tool_call_id ?? '',
                    output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                });
                continue;
            }

            if (msg.role === 'assistant' && msg.tool_calls?.length) {
                for (const call of msg.tool_calls) {
                    items.push({
                        type: 'function_call',
                        call_id: call.id,
                        name: call.function?.name ?? '',
                        arguments: call.function?.arguments ?? '',
                    });
                }
                continue;
            }

            items.push({
                type: 'message',
                role: msg.role,
                content: this.convertContent(msg.content),
            });
        }

        // Keep input items for gateways that do not accept the string shorthand.
        return { instructions, input: items };
    }

    private convertContent(content: unknown): any[] {
        if (typeof content === 'string') {
            return content ? [{ type: 'input_text', text: content }] : [];
        }
        if (Array.isArray(content)) {
            return content.map(part => {
                const p = part as any;
                if (p.type === 'image_url') {
                    const image = p.image_url;
                    return { type: 'input_image', image_url: typeof image === 'string' ? image : image?.url,
                        ...(typeof image === 'object' && image?.detail ? { detail: image.detail } : {}) };
                }
                return { type: 'input_text', text: p.text ?? '' };
            });
        }
        return [];
    }

    /** 统一工具定义（嵌套 function）→ Responses 扁平 schema。 */
    private convertToolsToFlat(tools: any[]): any[] {
        return tools.map(tool => {
            // 内置 web_search 工具（DeepSeek / OpenAI 服务端执行）直接透传
            if (tool?.type === 'web_search' || tool?.type === 'web_search_2025_08_26') {
                return { type: tool.type };
            }
            const fn = tool.function ?? tool;
            const flat: Record<string, unknown> = {
                type: tool.type ?? 'function',
                name: fn.name,
                description: fn.description,
                parameters: fn.parameters,
            };
            if (fn.strict !== undefined) flat.strict = fn.strict;
            return flat;
        });
    }

    private convertResponseFormat(format: any): any {
        if (format.type === 'json_schema') {
            return {
                format: { type: 'json_schema', name: format.json_schema?.name, schema: format.json_schema?.schema },
            };
        }
        return { format: { type: format.type === 'json_object' ? 'json_object' : 'text' } };
    }

    // ============== 响应标准化 ==============

    private normalizeResponse(response: any): ChatCompletionResponse {
        const output: any[] = response.output ?? [];
        const text = collectText(output);
        const toolCalls = collectToolCalls(output);
        const thinking = collectReasoning(output);
        const citations = collectCitations(output);

        return {
            id: response.id,
            object: response.object ?? 'response',
            created: response.created_at,
            model: response.model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: text,
                    ...(thinking ? { thinking } : {}),
                    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: this.mapFinishReason(response.status),
            }],
            usage: response.usage ? this.normalizeUsage(response.usage) : undefined,
            citations: citations.length ? citations : undefined,
        };
    }

    private mapFinishReason(status: string): any {
        switch (status) {
            case 'completed': return 'stop';
            case 'incomplete': return 'length';
            case 'failed': return 'error';
            default: return null;
        }
    }

    private normalizeUsage(usage: any): any {
        return {
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            cached_tokens: usage.input_tokens_details?.cached_tokens,
            thinking_tokens: usage.output_tokens_details?.reasoning_tokens,
            details: {
                reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
            },
        };
    }

    // ============== 流式事件处理 ==============

    private handleStreamEvent(
        event: string | undefined,
        payload: any,
        agg: StreamAggregator,
    ): ChatCompletionChunk | undefined {
        const delta: any = {};
        let finish: any = null;

        switch (event) {
            case 'response.created':
                agg.id = payload.id;
                break;
            case 'response.output_text.delta':
                agg.text += payload.delta ?? '';
                delta.content = payload.delta;
                break;
            case 'response.reasoning_text.delta':
                agg.thinking += payload.delta ?? '';
                delta.thinking = payload.delta;
                break;
            case 'response.function_call_arguments.delta':
                agg.accumulateTool(payload.item_id, payload.delta);
                break;
            case 'response.function_call_arguments.done':
                delta.tool_calls = agg.flushTool(payload.item_id);
                break;
            case 'response.output_item.done':
                if (payload.item?.type === 'function_call') {
                    delta.tool_calls = [{
                        id: payload.item.call_id,
                        type: 'function',
                        function: {
                            name: payload.item.name,
                            arguments: payload.item.arguments ?? '',
                        },
                    }];
                }
                break;
            case 'response.completed':
                if (payload.usage ?? payload.response?.usage) {
                    agg.usage = this.normalizeUsage(payload.usage ?? payload.response?.usage);
                }
                finish = 'stop';
                break;
            case 'response.incomplete':
                finish = 'length';
                break;
            default:
                return undefined;
        }

        if (delta.content === undefined && delta.thinking === undefined
            && delta.tool_calls === undefined && finish === null) {
            return undefined;
        }

        return {
            id: payload.id ?? agg.id,
            object: 'chat.completion.chunk',
            choices: [{
                index: 0,
                delta,
                finish_reason: finish,
            }],
            usage: agg.usage,
        };
    }

    private safeJson(data: string): any | undefined {
        try {
            return parseWireEvent(data);
        } catch {
            return undefined;
        }
    }
}

// ─── 流式聚合辅助 ────────────────────────────────────────────────────────────

class StreamAggregator {
    id?: string;
    text = '';
    thinking = '';
    usage?: any;
    citations?: Citation[];
    private toolArgs = new Map<string, string>();

    accumulateTool(itemId: string | undefined, delta: string): void {
        if (!itemId) return;
        this.toolArgs.set(itemId, (this.toolArgs.get(itemId) ?? '') + delta);
    }

    flushTool(itemId: string | undefined): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | undefined {
        if (!itemId || !this.toolArgs.has(itemId)) return undefined;
        const argumentsStr = this.toolArgs.get(itemId)!;
        this.toolArgs.delete(itemId);
        return [{ id: itemId, type: 'function', function: { name: '', arguments: argumentsStr } }];
    }

    finalize(failed: boolean): ChatCompletionChunk | undefined {
        // 终态 chunk：内容已通过 output_text.delta 逐条发出，这里补 usage / finish_reason / citations。
        return {
            id: this.id,
            object: 'chat.completion.chunk',
            choices: [{
                index: 0,
                delta: {},
                finish_reason: failed ? 'error' : 'stop',
            }],
            usage: this.usage,
            ...(this.citations?.length ? { citations: this.citations } : {}),
        };
    }
}

// ─── output[] 提取辅助 ───────────────────────────────────────────────────────

function collectText(output: any[]): string {
    const parts: string[] = [];
    for (const item of output) {
        if (item.type === 'message') {
            for (const content of item.content ?? []) {
                if (content.type === 'output_text' && typeof content.text === 'string') {
                    parts.push(content.text);
                }
            }
        }
    }
    return parts.join('');
}

function collectToolCalls(output: any[]): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const item of output) {
        if (item.type === 'function_call') {
            calls.push({
                id: item.call_id,
                type: 'function',
                function: {
                    name: item.name,
                    arguments: item.arguments ?? '',
                },
            });
        }
    }
    return calls;
}

function collectReasoning(output: any[]): string | undefined {
    const parts: string[] = [];
    for (const item of output) {
        if (item.type === 'reasoning') {
            for (const content of item.content ?? []) {
                if (typeof content.text === 'string') parts.push(content.text);
            }
        }
    }
    return parts.length ? parts.join('') : undefined;
}

/**
 * 提取 web_search_call 输出 item → 统一 citations 承载。
 *
 * 与 Gemini 的 grounding 引用对齐：上层通过 `response.citations[]` 统一消费
 * 联网搜索来源，无需区分厂商实现（内置工具 / grounding / MCP）。
 */
function collectCitations(output: any[]): Citation[] {
    const citations: Citation[] = [];
    for (const item of output) {
        if (item.type !== 'web_search_call') continue;
        const action = item.action ?? {};
        citations.push({
            text: citationText(item, action),
            source: 'web_search',
            url: item.url ?? action.url,
        });
    }
    return citations;
}

/**
 * citation 展示文本：优先真实查询词，否则动作友好标签。
 *
 * DeepSeek 的 `search` 动作把查询词放在 `action.queries`（复数数组），
 * 且混有 `ws_call_id=...` 伪条目；OpenAI 兼容形状则是 `search_query` / `action.query`。
 */
function citationText(item: any, action: any): string {
    const queries = Array.isArray(action.queries)
        ? action.queries.filter((q: unknown) =>
            typeof q === 'string' && q.trim() !== '' && !q.startsWith('ws_call_id='))
        : [];
    if (queries.length) return queries.join('；');
    const single = item.search_query ?? action.query;
    if (typeof single === 'string' && single.trim() !== '') return single;
    return actionLabel(action.type as string);
}

/** web_search_call 动作 → 友好中文标签。 */
function actionLabel(type: string): string {
    switch (type) {
        case 'search': return '搜索';
        case 'open_page': return '打开链接';
        case 'find_in_page': return '页内查找';
        default: return '联网搜索';
    }
}
