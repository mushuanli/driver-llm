// @file: driver-llm/core/driver.ts

import {
    LLMClientConfig,
    LLMProviderConfig,
    ChatCompletionParams,
    ChatCompletionResponse,
    ChatCompletionChunk
} from '../types';
import { BaseProvider } from '../providers/base';
import { createProvider } from '../providers/registry';
import { LLMError } from '../errors';
import { RequestCancellation } from './request-cancellation';
import { DEFAULT_MAX_RETRIES, DEFAULT_RETRY_DELAY, DEFAULT_TIMEOUT } from '../defaults';
import { expandMessagesAttachments } from '../utils/attachment';
import { noopLog } from '../utils/logger';

/**
 * LLM Driver - 统一的 LLM API 客户端
 * 
 * 职责：
 * 1. 封装各 Provider 的 API 调用
 * 2. 统一消息格式和响应结构
 * 3. 处理重试和超时
 * 4. 处理流式响应
 * 5. 自动展开 ChatMessage.attachments 为 multipart content
 */
export class LLMDriver {
    private readonly log: import('../types/provider').LLMLogSink;
    private provider: BaseProvider;
    private readonly providerConfig: LLMProviderConfig;
    private readonly modelProviders = new Map<string, BaseProvider>();
    private config: Required<Pick<LLMClientConfig, 'maxRetries' | 'retryDelay' | 'timeout'>> & LLMClientConfig;
    
    constructor(config: LLMClientConfig) {
        this.log = config.logger ?? noopLog;
        // 1. 解析配置（优先使用 connection 对象）
        const provider = config.connection?.providerId || config.provider;
        const apiKey = config.connection?.apiKey || config.apiKey;
        const apiBaseUrl = config.connection?.baseURL || config.apiBaseUrl;
        const model = config.connection?.model || config.model;
        
        // 2. 校验必填项
        if (!provider) {
            throw new Error('LLMDriver requires provider (either directly or via connection)');
        }
        if (!apiKey && provider !== 'codex') {
            throw new Error('LLMDriver requires apiKey (either directly or via connection)');
        }
        
        // 3. 构建 Provider 配置
        const providerConfig: LLMProviderConfig = {
            provider,
            apiKey: apiKey || '',
            apiBaseUrl,
            model,
            protocol: config.connection?.protocol ?? config.protocol,
            supportsThinking: config.supportsThinking,
            requiresReferer: config.requiresReferer,
            headers: config.headers,
            metadata: config.connection?.metadata,
            hooks: config.hooks,
            fetch: config.fetch,
            codex: config.codex,
        };
        
        // 4. 保存配置
        this.config = {
            maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
            retryDelay: config.retryDelay ?? DEFAULT_RETRY_DELAY,
            timeout: config.timeout ?? DEFAULT_TIMEOUT,
            ...config
        };
        
        // 5. 创建 Provider
        this.providerConfig = providerConfig;
        this.provider = createProvider(providerConfig, config.customProviderDefaults);
        
        // ✅ 简洁调用
        this.log.debug('LLMDriver initialized', {
            provider,
            model,
            timeout: this.config.timeout
        });
    }
    
    /**
     * Chat API
     */
    get chat() {
        return {
            create: this.createChatCompletion.bind(this)
        };
    }
    
    /**
     * 获取当前 Provider 名称
     */
    get providerName(): string {
        return this.provider.name;
    }
    
    /**
     * 获取当前模型
     */
    get currentModel(): string | undefined {
        return this.config.model;
    }

    /**
     * 释放 Provider 持有的资源（如 Codex app-server 子进程）。
     */
    async dispose(): Promise<void> {
        await Promise.all([this.provider, ...this.modelProviders.values()].map(provider => provider.dispose()));
    }

    /**
     * 推断当前 provider 的格式标识，用于 attachment 展开
     */
    private providerFormat(provider: BaseProvider): 'openai' | 'anthropic' | 'gemini' {
        if (provider.name.includes('anthropic')) return 'anthropic';
        if (provider.name.includes('gemini')) return 'gemini';
        return 'openai';
    }

    private providerForModel(model?: string): BaseProvider {
        if (!model || model === this.providerConfig.model || this.providerConfig.provider === 'codex') return this.provider;
        let provider = this.modelProviders.get(model);
        if (!provider) {
            provider = createProvider({ ...this.providerConfig, model }, this.config.customProviderDefaults);
            this.modelProviders.set(model, provider);
        }
        return provider;
    }

    // ============== 主入口 ==============
    
    /**
     * 创建聊天完成（支持流式和非流式）
     * 
     * 会自动将消息中的 `attachments` 字段展开为对应的 multipart content parts，
     * 使上层调用方无需手动调用 `processAttachments` 或 `expandMessageAttachments`。
     */
    async createChatCompletion(params: ChatCompletionParams & { stream: true }): Promise<AsyncGenerator<ChatCompletionChunk>>;
    async createChatCompletion(params: ChatCompletionParams & { stream?: false }): Promise<ChatCompletionResponse>;
    async createChatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResponse | AsyncGenerator<ChatCompletionChunk>> {
        const requestId = Date.now().toString(36);
        
        // ✅ 简洁调用
        this.log.debug('Chat request', {
            requestId,
            model: params.model || this.currentModel,
            stream: !!params.stream,
            messageCount: params.messages.length
        });

        const modelEffort = this.providerConfig.metadata?.modelReasoningEfforts?.[params.model || this.providerConfig.model || ''];
        let finalParams: ChatCompletionParams = { ...params, reasoningEffort: params.reasoningEffort ?? modelEffort };
        const requestProvider = this.providerForModel(params.model);

        // ── 自动展开 attachments ──
        const hasAttachments = finalParams.messages.some(m => m.attachments && m.attachments.length > 0);
        // Codex consumes original local image paths through `codex exec --image`.
        if (hasAttachments && this.providerName !== 'codex') {
            try {
                finalParams.messages = await expandMessagesAttachments(
                    finalParams.messages,
                    this.providerFormat(requestProvider),
                );
                this.log.debug('Attachments expanded', { requestId });
            } catch (err: any) {
                this.log.warn('Failed to expand attachments, sending messages as-is', {
                    requestId,
                    error: err.message,
                });
            }
        }

        if (this.config.hooks?.beforeRequest) {
            finalParams = await this.config.hooks.beforeRequest(finalParams);
        }
        
        const cancellation = new RequestCancellation(this.providerName, this.config.timeout, finalParams.signal);
        finalParams.signal = cancellation.controller.signal;

        try {
            finalParams.signal.throwIfAborted();
            if (finalParams.stream) {
                // 流式响应
                const stream = requestProvider.stream(finalParams);
                this.log.debug('Stream started', { requestId });
                return this.wrapStreamWithTimeout(stream, cancellation, requestId);
            } else {
                const startTime = Date.now();
                const response = await this.executeWithRetry(
                    () => requestProvider.create(finalParams),
                    requestId, finalParams.signal, 1, finalParams._maxAttempts ?? this.config.maxRetries
                );
                cancellation.dispose();
                
                // ✅ 简洁调用
                this.log.info('Chat success', {
                    requestId,
                    model: response.model,
                    latency: Date.now() - startTime,
                    tokens: response.usage?.total_tokens
                });
                
                if (this.config.hooks?.afterResponse) {
                    return this.config.hooks.afterResponse(response);
                }
                return response;
            }
        } catch (error: any) {
            cancellation.dispose();
            error = cancellation.error(error);

            // 转换为 LLMError
            const llmError = error instanceof LLMError
                ? error
                : LLMError.fromException(this.providerName, error);

            // 注入模型名，用于友好错误提示
            if (!llmError.model && this.currentModel) {
                llmError.model = this.currentModel;
                llmError.message = `Model '${this.currentModel}': ${llmError.message}`;
            }

            this.log.error('Chat failed', {
                requestId,
                code: llmError.code,
                message: llmError.message,
                model: llmError.model || this.currentModel,
            });

            if (this.config.hooks?.onError) {
                await this.config.hooks.onError(llmError, finalParams);
            }

            throw llmError;
        }
    }
    
    // ============== 重试逻辑 ==============
    
    private async executeWithRetry<T>(
        fn: () => Promise<T>,
        requestId: string,
        signal: AbortSignal,
        attempt = 1,
        maxAttempts = this.config.maxRetries
    ): Promise<T> {
        try {
            signal.throwIfAborted();
            return await fn();
        } catch (error: any) {
            const llmError = error instanceof LLMError
                ? error
                : LLMError.fromException(this.providerName, error);
            
            // 检查是否可重试
            const shouldRetry = !signal.aborted && attempt < maxAttempts
                && (this.config.retryPolicy?.shouldRetry?.(llmError, attempt) ?? llmError.retryable);
            
            if (shouldRetry) {
                // 计算延迟（指数退避）
                const delay = this.config.retryPolicy?.delayMs?.(llmError, attempt) ?? (llmError.retryAfter || 
                    (this.config.retryDelay * Math.pow(2, attempt - 1)));
                
                // ✅ 简洁调用
                this.log.warn('Retrying', {
                    requestId,
                    attempt,
                    maxRetries: this.config.maxRetries,
                    delay
                });
                
                await this.sleep(delay, signal);
                return this.executeWithRetry(fn, requestId, signal, attempt + 1, maxAttempts);
            }
            
            throw llmError;
        }
    }
    
    // ============== 流式包装 ==============
    
    private async *wrapStreamWithTimeout(
        stream: AsyncGenerator<ChatCompletionChunk>,
        cancellation: RequestCancellation,
        requestId: string
    ): AsyncGenerator<ChatCompletionChunk> {
        let chunkCount = 0;
        try {
            for await (const chunk of stream) {
                cancellation.controller.signal.throwIfAborted();
                cancellation.reset();
                chunkCount++;
                this.config.hooks?.onStreamChunk?.(chunk);
                yield chunk;
            }
            cancellation.controller.signal.throwIfAborted();
            this.log.debug('Stream completed', { requestId, chunkCount });
        } catch (error) {
            throw cancellation.error(error);
        } finally {
            cancellation.dispose();
        }
    }
    
    // ============== 工具方法 ==============
    
    private sleep(ms: number, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
            signal.addEventListener('abort', abort, { once: true });
        });
    }
}
