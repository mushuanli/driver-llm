// Transport-independent model service port, implemented by host adapters.

import type { ChatCompletionParams, ChatCompletionResponse, ChatCompletionChunk } from './response';
import type { ConnectionMeta, LLMProvider } from './connection';

/**
 * LLM 调用服务接口。
 *
 * 对 LLMDeviceDriver 的轻量封装，屏蔽设备驱动的 open/write/readStream 模式，
 * Exposes a provider-independent resource port for process programs.
 *
 * 设计要点：
 * 1. 通过 connectionId 引用连接，不接触 apiKey
 * 2. 同步调用返回完整响应，流式调用返回 AsyncIterable
 * 3. 错误转为标准 LLMError（含可重试标志和 retryAfter）
 * 4. Provider 差异由底层 LLMDeviceDriver 抹平
 */
export interface ILLMService {
    // ── 对话调用 ──

    /**
     * 同步调用 LLM，等待完整响应。
     *
     * @param connectionId 使用的 LLM 连接 ID
     * @param request      对话请求参数
     */
    chat(connectionId: string, request: ChatCompletionParams): Promise<ChatCompletionResponse>;

    /**
     * 流式调用 LLM，返回 AsyncIterable。
     *
     * 边生成边消费，工具调用块完整时可立即执行（流式工具并行）。
     */
    chatStream(connectionId: string, request: ChatCompletionParams): AsyncIterable<ChatCompletionChunk>;

    /**
     * 中止指定连接当前正在进行的请求。
     */
    abort(connectionId: string): void;

    // ── 连接查询 ──

    /**
     * 获取连接元信息（不含 apiKey）。
     */
    getConnection(connectionId: string): Promise<ConnectionMeta | undefined>;

    /**
     * 获取默认连接元信息。
     */
    getDefaultConnection(): Promise<ConnectionMeta | null>;

    /**
     * 列出所有可用连接。
     */
    listConnections(): Promise<ConnectionMeta[]>;

    // ── 工具函数 ──

    /**
     * 获取单个 Provider 定义（不含 apiKey，含模型定价）。
     */
    getProvider(providerId: string): Promise<LLMProvider | undefined>;

    /**
     * 估算文本的 token 数量（近似值，无需 API 调用）。
     */
    estimateTokens(connectionId: string, text: string): number;
}
