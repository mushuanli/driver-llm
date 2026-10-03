// @file: driver-llm/providers/base.ts

import { noopLog } from '../utils/logger';
import type { LLMLogSink } from '../types/provider';

import {
    LLMProviderConfig,
    ChatCompletionParams,
    ChatCompletionResponse,
    ChatCompletionChunk,
    ProviderCapabilities,
    LLMHooks,
} from '../types';
import { LLMError } from '../errors';
import { processAttachments } from '../utils/attachment';

/**
 * Provider 基类
 * 
 * 职责：
 * 1. 定义统一的 API 接口
 * 2. 提供通用的请求/响应处理
 * 3. 标准化不同 Provider 的输出格式
 */
export abstract class BaseProvider {
    /** Provider 名称 */
    abstract readonly name: string;

    /** Provider 能力 */
    abstract readonly capabilities: ProviderCapabilities;

    protected config: LLMProviderConfig;
    protected readonly log: LLMLogSink;
    protected baseURL: string;
    protected defaultModel: string;
    protected hooks?: LLMHooks;

    constructor(config: LLMProviderConfig) {
        this.config = config;
        this.log = config.logger ?? noopLog;
        this.baseURL = this.resolveBaseURL(config);
        this.defaultModel = config.model || '';
        this.hooks = config.hooks;
    }
    
    /**
     * 非流式请求
     */
    abstract create(params: ChatCompletionParams): Promise<ChatCompletionResponse>;
    
    /**
     * 流式请求
     */
    abstract stream(params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk>;

    /**
     * 释放 Provider 持有的资源（子进程、常驻传输等）。默认空实现。
     */
    async dispose(): Promise<void> {}

    // ============== 能力检查 (新增) ==============

    /**
     * 检查是否支持某能力
     */
    supportsCapability(capability: keyof ProviderCapabilities): boolean {
        return this.capabilities[capability] === true;
    }

    /**
     * 验证请求参数
     */
    validateParams(params: ChatCompletionParams): void {
        // 检查音频
        if (params.audioInput && !this.supportsCapability('audioInput')) {
            throw new Error(`Provider ${this.name} does not support audio input`);
        }

        if (params.audioOutput && !this.supportsCapability('audioOutput')) {
            throw new Error(`Provider ${this.name} does not support audio output`);
        }

        // 检查工具
        if (params.tools?.length && !this.supportsCapability('tools')) {
            throw new Error(`Provider ${this.name} does not support tools`);
        }

        // 检查结构化输出
        if (params.responseFormat?.type === 'json_schema' && !this.supportsCapability('structuredOutput')) {
            throw new Error(`Provider ${this.name} does not support structured output`);
        }

        // 检查代码执行
        if (params.codeExecution && !this.supportsCapability('codeExecution')) {
            throw new Error(`Provider ${this.name} does not support code execution`);
        }

        // 检查思考模式
        if (params.thinking && !this.supportsCapability('thinking')) {
            throw new Error(`Provider ${this.name} does not support thinking mode`);
        }
    }

    // ============== 消息预处理 (新增) ==============

    /**
     * 预处理消息 - 处理附件
     */
    protected async preprocessMessages(params: ChatCompletionParams): Promise<ChatCompletionParams> {
        const processedMessages = await Promise.all(
            params.messages.map(async (msg) => {
                // 如果有 attachments 字段，转换为 content parts
                if (msg.attachments && msg.attachments.length > 0) {
                    const attachmentParts = await processAttachments(
                        msg.attachments,
                        this.getProviderFormat()
                    );

                    // 合并到 content
                    const existingContent = typeof msg.content === 'string'
                        ? [{ type: 'text' as const, text: msg.content }]
                        : msg.content;

                    return {
                        ...msg,
                        content: [...existingContent, ...attachmentParts],
                        attachments: undefined // 移除已处理的附件
                    };
                }
                return msg;
            })
        );

        return { ...params, messages: processedMessages };
    }

    /**
     * 获取 Provider 格式标识
     */
    protected getProviderFormat(): 'openai' | 'anthropic' | 'gemini' {
        return 'openai';
    }

    // ============== 通用方法 ==============

    protected resolveBaseURL(config: LLMProviderConfig): string {
        if (config.apiBaseUrl) {
            return config.apiBaseUrl.replace(/\/+$/, ''); // 移除尾部斜杠
        }
        return '';
    }

    /**
     * Append defaultPath to baseURL, but skip if baseURL already ends with it.
     * Prevents double-suffix when a custom baseURL already contains the full path.
     */
    protected resolveEndpointUrl(defaultPath: string): string {
        const base = this.trimBase();
        if (defaultPath && base.endsWith(defaultPath)) return base;
        const version = defaultPath.match(/^\/v\d+(?:beta\d*)?(?=\/|$)/)?.[0];
        if (version && base.endsWith(version)) return base + defaultPath.slice(version.length);
        return base + defaultPath;
    }

    /** Strip trailing slashes from baseURL. */
    protected trimBase(): string {
        return this.baseURL.replace(/\/+$/, '');
    }

    /** Snapshot response headers into a plain object for logging */
    private headersSnapshot(response: Response): Record<string, string> {
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        return headers;
    }

    /**
     * 构建请求头
     */
    protected buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.config.headers
        };
        
        return headers;
    }
    
    /**
     * 获取实际使用的模型
     */
    protected getModel(params: ChatCompletionParams): string {
        return params.model || this.defaultModel;
    }
    
    /**
     * 发送 HTTP 请求
     */
    protected async fetchJSON<T>(
        url: string,
        options: RequestInit
    ): Promise<T> {
        const response = await (this.config.fetch ?? globalThis.fetch)(url, options);

        // Capture response headers for troubleshooting
        this.hooks?.onResponseHeaders?.(this.headersSnapshot(response), response.status);

        if (!response.ok) {
            const text = await response.text();
            let body: any;
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
            let requestBody: any;
            try { requestBody = JSON.parse(options.body as string); } catch { requestBody = options.body; }
            this.log.error('[LLM] HTTP error (non-stream)', {
                provider: this.name,
                url,
                status: response.status,
                statusText: response.statusText,
                responseHeaders: this.headersSnapshot(response),
                responseBody: body,
                requestBody,
            });
            throw LLMError.fromResponse(this.name, response.status, body);
        }

        return response.json();
    }

    /**
     * 发送流式请求
     */
    protected async fetchStream(
        url: string,
        options: RequestInit
    ): Promise<ReadableStream<Uint8Array>> {
        const response = await (this.config.fetch ?? globalThis.fetch)(url, options);

        // Capture response headers for troubleshooting
        this.hooks?.onResponseHeaders?.(this.headersSnapshot(response), response.status);

        if (!response.ok) {
            const text = await response.text();
            let body: any;
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
            let requestBody: any;
            try { requestBody = JSON.parse(options.body as string); } catch { requestBody = options.body; }
            this.log.error('[LLM] HTTP error (stream)', {
                provider: this.name,
                url,
                status: response.status,
                statusText: response.statusText,
                responseHeaders: this.headersSnapshot(response),
                responseBody: body,
                requestBody,
            });
            throw LLMError.fromResponse(this.name, response.status, body);
        }
        
        if (!response.body) {
            throw new Error('Response body is null');
        }
        
        return response.body;
    }
}
