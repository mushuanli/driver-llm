/** Runtime-neutral provider port; factories need no inheritance from a built-in client. */
export interface LLMProviderInstance {
    readonly name: string;
    readonly capabilities: ProviderCapabilities;
    create(params: ChatCompletionParams): Promise<ChatCompletionResponse>;
    stream(params: ChatCompletionParams): AsyncIterable<import('./response').ChatCompletionChunk>;
    dispose(): Promise<void>;
}
export type ProviderConstructor = new (config: LLMProviderConfig) => LLMProviderInstance;
export type ProviderFactory = (config: LLMProviderConfig, defaults?: Record<string, import('./connection').LLMProvider>) => LLMProviderInstance;

export interface LLMLogSink {
    debug(message: string, details?: unknown): void;
    info(message: string, details?: unknown): void;
    warn(message: string, details?: unknown): void;
    error(message: string, details?: unknown): void;
}
export interface RetryPolicy {
    shouldRetry?(error: Error, attempt: number): boolean;
    delayMs?(error: Error, attempt: number): number;
}

// @file: driver-llm/types/provider.ts

import { LLMConnection } from './connection';
import { ChatCompletionParams, ChatCompletionResponse } from './response';
import type { ApiProtocol } from './connection';

/**
 * Provider 配置（传给 BaseProvider）
 */
export interface LLMProviderConfig {
    logger?: LLMLogSink;
    fetch?: typeof globalThis.fetch;
    /** Provider key */
    provider: string;
    
    /** API Key */
    apiKey: string;
    
    /** API 地址（Provider 根域） */
    apiBaseUrl?: string;

    /**
     * 覆盖内置默认路径（如 "/api/v1/chat/completions"）。
     * 未设置时各 Provider 实现使用自身默认值。
     */
    defaultPath?: string;

    /**
     * Anthropic Messages 兼容路径（相对于 apiBaseUrl）。
     * 如 "/anthropic"，完整 URL = apiBaseUrl + anthropicPath。
     * AnthropicProvider 在以 anthropic-messages 协议请求时使用此路径。
     */
    anthropicPath?: string;

    /**
     * OpenAI Responses API 兼容路径（相对于 apiBaseUrl）。
     * 如 DeepSeek 的 "/responses"，完整 URL = apiBaseUrl + responsesPath。
     * ResponsesProvider 在以 openai-responses 协议请求时使用此路径。
     */
    responsesPath?: string;

    /** API 协议类型；显式设置时优先于 implementation + URL 推断 */
    protocol?: ApiProtocol;

    /** 默认模型 */
    model?: string;

    // ===== 能力标识 =====
    /** 是否支持思考过程 */
    supportsThinking?: boolean;
    
    /** 是否需要 Referer */
    requiresReferer?: boolean;
    
    /** 支持的模态 */
    supportedModalities?: Array<'text' | 'image' | 'audio' | 'video'>;
    
    /** 支持的特性 */
    capabilities?: ProviderCapabilities;

    /**
     * Responses API 推理行为配置（仅 openai-responses 协议生效）。
     * defaultThinkingEnabled = 服务端默认开启思考（如 DeepSeek），用户显式关闭
     * thinking 时需发送 reasoning.effort='none' 才能关闭。
     */
    responses?: {
        defaultThinkingEnabled?: boolean;
    };
    
    // ===== 请求配置 =====
    /** 额外 HTTP 头 */
    headers?: Record<string, string>;

    /** 额外元数据 */
    metadata?: Record<string, any>;

    /** 生命周期钩子（透传自 LLMClientConfig） */
    hooks?: LLMHooks;

    // ===== MCP 配置 (新增) =====
    

    /** Codex CLI provider options (provider = "codex"). */
    codex?: CodexCLIConfig;
}

export interface CodexCommandResult {
    stdout: string;
    stderr?: string;
}

/** Injectable command runner keeps the provider testable and host-runtime agnostic. */
export interface CodexCommandRunner {
    run(command: string, args: string[], options?: { signal?: AbortSignal; cwd?: string }): Promise<CodexCommandResult>;
    /** Stream stdout chunks. Implementations should reject if the process exits unsuccessfully. */
    stream?(command: string, args: string[], options?: { signal?: AbortSignal; cwd?: string }): AsyncIterable<string>;
}

export interface CodexCLIConfig {
    /** Preferred app-server transport. When omitted, a local stdio app-server is started lazily. */
    transport?: CodexAppServerTransport;
    /** Use the legacy one-shot exec adapter instead of app-server. */
    mode?: 'app-server' | 'exec';
    /** CLI executable. Defaults to `codex`. */
    command?: string;
    /** Working directory passed to the CLI process. */
    cwd?: string;
    /** Extra arguments inserted before the prompt. */
    args?: string[];
    /** Override process execution (primarily for embedded runtimes/tests). */
    runner?: CodexCommandRunner;
}

export interface CodexRPCMessage {
    method: string;
    params?: any;
    id?: string | number;
}

/** Runtime-neutral Codex app-server JSON-RPC transport. */
export interface CodexAppServerTransport {
    request<T = any>(method: string, params?: any): Promise<T>;
    events(): AsyncIterable<CodexRPCMessage>;
    respond(id: string | number, result: any): Promise<void>;
    close?(): Promise<void>;
}

/**
 * Provider 能力定义
 */
export interface ProviderCapabilities {
    /** 视觉/图像理解 */
    vision?: boolean;
    /** 音频输入 */
    audioInput?: boolean;
    /** 音频输出 */
    audioOutput?: boolean;
    /** 视频理解 */
    video?: boolean;
    /** 文档/PDF 处理 */
    documents?: boolean;
    /** 工具调用 */
    tools?: boolean;
    /** 并行工具调用 */
    parallelTools?: boolean;
    /** 结构化输出 */
    structuredOutput?: boolean;
    /** JSON 模式 */
    jsonMode?: boolean;
    /** 思考/推理 */
    thinking?: boolean;
    /** 代码执行 */
    codeExecution?: boolean;
    /** Computer Use */
    computerUse?: boolean;
    /** MCP 协议 */
    mcp?: boolean;
    /** Prompt Caching */
    caching?: boolean;
    /** Batch API */
    batch?: boolean;
    /** 流式响应 */
    streaming?: boolean;
}


/**
 * 生命周期钩子 - 增强版
 */
export interface LLMHooks {
    /** 请求前处理 */
    beforeRequest?: (params: ChatCompletionParams) => Promise<ChatCompletionParams>;

    /** 响应后处理 */
    afterResponse?: (response: ChatCompletionResponse) => Promise<ChatCompletionResponse>;

    /** 错误处理 */
    onError?: (error: Error, params: ChatCompletionParams) => Promise<void>;

    /** 流式块处理 (新增) */
    onStreamChunk?: (chunk: import('./response').ChatCompletionChunk) => void;

    /** 工具调用前 (新增) */
    beforeToolCall?: (toolCall: import('./message').ToolCall) => Promise<import('./message').ToolCall>;

    /** 工具调用后 (新增) */
    afterToolCall?: (toolCall: import('./message').ToolCall, result: any) => Promise<any>;

    /** HTTP 响应头捕获（用于 LLM 故障排查日志） */
    onResponseHeaders?: (headers: Record<string, string>, status: number) => void;
}

/**
 * LLMDriver 构造配置
 */
export interface LLMClientConfig {
    /** Instance factory, typically created by ProviderRegistry.snapshot(). */
    providerFactory?: ProviderFactory;
    responses?: LLMProviderConfig['responses'];
    protocol?: ApiProtocol;
    fetch?: typeof globalThis.fetch;
    logger?: LLMLogSink;
    retryPolicy?: RetryPolicy;
    // ===== 方式 A: 传入连接对象（运行时可能被调用方注入 apiKey/model/protocol 等解析字段） =====
    connection?: LLMConnection & { apiKey?: string; model?: string; protocol?: string };
    
    // ===== 方式 B: 直接传参 =====
    provider?: string;
    apiKey?: string;
    apiBaseUrl?: string;
    model?: string;
    
    // ===== 能力开关 =====
    supportsThinking?: boolean;
    requiresReferer?: boolean;
    
    // ===== 请求配置 =====
    /** 最大重试次数 */
    maxRetries?: number;
    
    /** 重试延迟 (ms) */
    retryDelay?: number;
    
    /** 请求超时 (ms) */
    timeout?: number;
    
    /** 额外 HTTP 头 */
    headers?: Record<string, string>;
    
    // ===== 扩展 =====
    /** 生命周期钩子 */
    hooks?: LLMHooks;

    /** 自定义 Provider 定义 */
    customProviderDefaults?: Record<string, import('./connection').LLMProvider>;
    
    // ===== 新增配置 =====
    
    /** MCP 配置 */

    /** Local Codex CLI configuration (used when provider is `codex`). */
    codex?: CodexCLIConfig;
    
    /** 默认音频配置 */
    audio?: {
        inputFormat?: string;
        outputFormat?: string;
        voice?: string;
    };
    
    /** 默认缓存配置 */
    caching?: {
        enabled?: boolean;
        ttl?: number;
    };
    
    /** 调试模式 */
    debug?: boolean;
}
