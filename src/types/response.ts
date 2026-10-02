// @file: common/interfaces/llm/completion.ts
// ChatCompletion 请求/响应类型（提供商无关）。

import type { ChatMessage, ToolDefinition, ToolCall } from './message';

// ─── Request ──────────────────────────────────────────────────────────────────

export type ToolChoice =
    | 'none' | 'auto' | 'required'
    | { type: 'function'; function: { name: string } }
    | { type: 'any' }
    | { type: 'tool'; name: string };

export type ResponseFormat =
    | { type: 'text' }
    | { type: 'json_object' }
    | { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };

export interface ChatCompletionParams {
    /** Internal transport attempt limit; not sent to providers. */
    _maxAttempts?: number;
    messages: ChatMessage[];
    model?: string;
    stream?: boolean;

    // Generation
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stop?: string | string[];
    seed?: number;
    n?: number;

    // Extended thinking (Claude / o-series)
    thinking?: boolean;
    thinkingBudget?: number;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';

    // Tools
    tools?: ToolDefinition[];
    toolChoice?: ToolChoice;
    parallelToolCalls?: boolean;

    // Output format
    responseFormat?: ResponseFormat;
    prediction?: { type: 'content'; content: string };

    // Multimodal
    audioInput?: { voice?: string; format?: string };
    audioOutput?: { voice?: string; format?: string };

    // Provider features
    caching?: boolean;
    codeExecution?: boolean;
    webSearch?: boolean;
    retrieval?: boolean;

    // Cancellation
    signal?: AbortSignal;

    // Provider-specific fields
    user?: string;
    modalities?: string[];
    serviceTier?: string;
    metadata?: Record<string, any>;

    /** Internal: session label for log file naming (e.g. chat file name) */
    _label?: string;
}

// ─── Response ─────────────────────────────────────────────────────────────────

export type FinishReason =
    | 'stop' | 'length' | 'tool_calls' | 'content_filter'
    | 'end_turn' | 'max_tokens' | 'stop_sequence'
    | 'tool_use' | 'error' | null;

export interface TokenUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    thinking_tokens?: number;
    cached_tokens?: number;
    audio_tokens?: { input?: number; output?: number } | number;
    details?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface Citation {
    /** 展示文本（查询词或标题）；无 text 时可用 title 兜底 */
    text: string;
    /**
     * 来源机制：内置 web_search → 'web_search'，Gemini grounding → 'grounding'，
     * MCP server → 'mcp'，客户端 WebSearchTool → 'client_tool'。
     * 保留 string 而非判别联合，避免新增来源时破坏既有实现。
     */
    source?: string;
    /** 引用标题（Gemini grounding 等场景）；text 缺省时用于展示 */
    title?: string;
    page?: number;
    url?: string;
}

export interface AssistantMessage {
    role: 'assistant';
    content: string | null;
    thinking?: string;
    tool_calls?: ToolCall[];
    audio?: { id?: string; data?: string; transcript?: string };
    parsed?: unknown;
    refusal?: string | null;
    code_execution?: { outputs?: unknown[] };
}

export interface ChatCompletionResponse {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices: Array<{
        index: number;
        message: AssistantMessage;
        finish_reason: FinishReason;
        logprobs?: unknown;
    }>;
    usage?: TokenUsage;
    system_fingerprint?: string;
    service_tier?: string;
    cache?: { read?: number; write?: number; hit?: boolean; cached_tokens?: number; [key: string]: unknown };
    citations?: Citation[];
}

// ─── Streaming ────────────────────────────────────────────────────────────────

export interface ChatCompletionChunk {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    service_tier?: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string | null;
            thinking?: string;
            tool_calls?: Partial<ToolCall>[];
            audio?: { id?: string; data?: string; transcript?: string };
            refusal?: string | null;
        };
        finish_reason: FinishReason;
        logprobs?: unknown;
    }>;
    usage?: TokenUsage;
    system_fingerprint?: string;
    /** 联网搜索结果引用（如内置 web_search / grounding 检索），通常只在终态 chunk 携带。 */
    citations?: Citation[];
}
