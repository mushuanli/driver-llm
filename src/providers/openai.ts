// @file: driver-llm/providers/openai.ts

import { BaseProvider } from './base';
import {
    LLMProviderConfig,
    ChatCompletionParams,
    ChatCompletionResponse,
    ChatCompletionChunk,
    ChatMessage,
    ProviderCapabilities
} from '../types';
import { parseSSEStream } from '../utils/stream';

/**
 * OpenAI Compatible Provider
 * 
 * 支持：OpenAI, DeepSeek, Groq, OpenRouter, Ollama 等
 */
export class OpenAIProvider extends BaseProvider {
    readonly name = 'openai';

    readonly capabilities: ProviderCapabilities = {
        vision: true,
        audioInput: true,
        audioOutput: true,
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
        batch: true,
        streaming: true
    };

    constructor(config: LLMProviderConfig) {
        super(config);
        if (!this.baseURL) {
            this.baseURL = 'https://api.openai.com';
        }

        // 根据 provider 调整能力
        this.adjustCapabilities(config.provider);
    }

    private resolveCompletionsUrl(): string {
        return this.resolveEndpointUrl(this.config.defaultPath ?? '/v1/chat/completions');
    }

    /**
     * 根据具体 provider 调整能力
     */
    private adjustCapabilities(provider: string): void {
        switch (provider) {
            case 'deepseek':
                this.capabilities.audioInput = false;
                this.capabilities.audioOutput = false;
                this.capabilities.caching = false;
                break;
            case 'groq':
                this.capabilities.audioInput = false;
                this.capabilities.audioOutput = false;
                this.capabilities.structuredOutput = false;
                break;
            case 'ollama':
                this.capabilities.audioInput = false;
                this.capabilities.audioOutput = false;
                this.capabilities.batch = false;
                break;
        }
    }

    protected getProviderFormat(): 'openai' | 'anthropic' | 'gemini' {
        return 'openai';
    }

    async create(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
        // 验证参数
        this.validateParams(params);

        // 预处理消息（处理附件）
        const processedParams = await this.preprocessMessages(params);

        const url = this.resolveCompletionsUrl();
        const body = this.buildRequestBody(processedParams);

        const response = await this.fetchJSON<any>(url, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: params.signal
        });

        return this.normalizeResponse(response);
    }
    
    /**
     * 流式请求
     */
    async *stream(params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
        // 验证参数
        this.validateParams(params);

        // 预处理消息
        const processedParams = await this.preprocessMessages(params);

        const url = this.resolveCompletionsUrl();
        const body = this.buildRequestBody({ ...processedParams, stream: true });

        const stream = await this.fetchStream(url, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: params.signal
        });

        for await (const data of parseSSEStream(stream)) {
            if (data === '[DONE]') break;

            try {
                const chunk = JSON.parse(data);
                yield this.normalizeChunk(chunk);
            } catch {
                // 忽略解析错误
            }
        }
    }

    // ============== 请求构建 ==============

    protected buildHeaders(): Record<string, string> {
        const headers = super.buildHeaders();
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        
        // OpenRouter 需要 Referer
        if (this.config.requiresReferer) {
            headers['HTTP-Referer'] = 'https://itookit.com';
            headers['X-Title'] = 'iTookit';
        }
        
        // Organization ID
        if (this.config.metadata?.organizationId) {
            headers['OpenAI-Organization'] = this.config.metadata.organizationId;
        }
        
        return headers;
    }
    
    protected buildRequestBody(params: ChatCompletionParams): Record<string, any> {
        const body: Record<string, any> = {
            model: this.getModel(params),
            messages: this.convertMessages(params.messages),
            stream: params.stream || false
        };
        
        // 基础参数
        if (params.temperature !== undefined) body.temperature = params.temperature;
        if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
        if (params.topP !== undefined) body.top_p = params.topP;
        if (params.stop !== undefined) body.stop = params.stop;
        if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
        if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
        if (params.seed !== undefined) body.seed = params.seed;
        if (params.user !== undefined) body.user = params.user;
        
        // 响应格式
        if (params.responseFormat) {
            body.response_format = params.responseFormat;
        }
        
        // 工具
        if (params.tools && params.tools.length > 0) {
            body.tools = params.tools;
            if (params.toolChoice) body.tool_choice = params.toolChoice;
            if (params.parallelToolCalls !== undefined) {
                body.parallel_tool_calls = params.parallelToolCalls;
            }
        }
        
        // Thinking mode — only for providers that declare capabilities.thinking.
        // Priority: model-level thinkingMode (from provider catalog) > caller params.
        //
        // thinkingMode='auto'     → omit thinking field (model/proxy uses adaptive default)
        // thinkingMode='disabled' → send thinking.type=disabled (DeepSeek-style explicit off)
        // thinkingMode='enabled'  → send thinking.type=enabled (force extended thinking)
        // thinkingMode unset      → fall back to params.thinking boolean logic:
        //   - params.thinking=true  → enabled
        //   - params.thinking=false → disabled ONLY for deepseek (it defaults thinking ON)
        //   - otherwise            → omit (adaptive)
        if (this.capabilities.thinking) {
            const thinkingMode = this.config.metadata?.thinkingMode as string | undefined;
            if (thinkingMode === 'auto') {
                // Explicitly omit — adaptive mode
            } else if (thinkingMode === 'enabled' || params.thinking === true) {
                body.thinking = { type: 'enabled' };
                if (params.reasoningEffort) {
                    body.reasoning_effort = params.reasoningEffort;
                }
            } else if (thinkingMode === 'disabled' ||
                       (params.thinking === false && this.config.provider === 'deepseek')) {
                body.thinking = { type: 'disabled' };
            }
            // All other cases: omit thinking field → adaptive/default mode
        }

        // 音频配置 (新增)
        if (params.modalities) {
            body.modalities = params.modalities;
        }

        if (params.audioOutput) {
            body.audio = {
                voice: params.audioOutput.voice || 'alloy',
                format: params.audioOutput.format || 'mp3'
            };
        }

        // 预测输出 (新增)
        if (params.prediction) {
            body.prediction = params.prediction;
        }

        // 服务层级 (新增)
        if (params.serviceTier) {
            body.service_tier = params.serviceTier;
        }

        // 元数据 (新增)
        if (params.metadata) {
            body.metadata = params.metadata;
        }

        // 流式选项
        if (params.stream) {
            body.stream_options = { include_usage: true };
        }
        
        return body;
    }
    
    protected convertMessages(messages: ChatMessage[]): any[] {
        return messages.map(msg => {
            const converted: any = {
                role: msg.role,
                content: msg.content
            };
            
            if (msg.name) converted.name = msg.name;
            if (msg.tool_call_id) converted.tool_call_id = msg.tool_call_id;
            if (msg.role === 'assistant' && msg.tool_calls?.length) converted.tool_calls = msg.tool_calls;
            if (msg.role === 'assistant' && msg.thinking) converted.reasoning_content = msg.thinking;
            
            return converted;
        });
    }
    
    // ============== 响应标准化 ==============
    
    protected normalizeResponse(response: any): ChatCompletionResponse {
        const choice = response.choices?.[0];
        const message = choice?.message || {};
        
        // 提取思考内容 (DeepSeek R1 使用 reasoning_content)
        let thinking: string | undefined;
        if (message.reasoning_content) {
            thinking = message.reasoning_content;
        }
        
        return {
            id: response.id,
            object: response.object,
            created: response.created,
            model: response.model,
            choices: [{
                index: choice?.index || 0,
                message: {
                    role: 'assistant',
                    content: message.content || '',
                    thinking,
                    tool_calls: message.tool_calls
                },
                finish_reason: choice?.finish_reason || 'stop'
            }],
            usage: response.usage ? {
                prompt_tokens: response.usage.prompt_tokens,
                completion_tokens: response.usage.completion_tokens,
                total_tokens: response.usage.total_tokens,
                cached_tokens: response.usage.prompt_tokens_details?.cached_tokens,
                audio_tokens: response.usage.prompt_tokens_details?.audio_tokens ? {
                    input: response.usage.prompt_tokens_details.audio_tokens,
                    output: response.usage.completion_tokens_details?.audio_tokens || 0
                } : undefined,
                details: response.usage.completion_tokens_details ? {
                    reasoning_tokens: response.usage.completion_tokens_details.reasoning_tokens,
                    accepted_prediction_tokens: response.usage.completion_tokens_details.accepted_prediction_tokens,
                    rejected_prediction_tokens: response.usage.completion_tokens_details.rejected_prediction_tokens
                } : undefined
            } : undefined,
            system_fingerprint: response.system_fingerprint,
            service_tier: response.service_tier
        };
    }

    protected normalizeChunk(chunk: any): ChatCompletionChunk {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta || {};

        // 处理思考内容
        let thinking: string | undefined;
        if (delta.reasoning_content) {
            thinking = delta.reasoning_content;
        }

        return {
            id: chunk.id,
            object: chunk.object,
            created: chunk.created,
            model: chunk.model,
            choices: [{
                index: choice?.index || 0,
                delta: {
                    role: delta.role,
                    content: delta.content,
                    thinking,
                    tool_calls: delta.tool_calls,
                    audio: delta.audio,
                    refusal: delta.refusal
                },
                finish_reason: choice?.finish_reason,
                logprobs: choice?.logprobs
            }],
            usage: chunk.usage,
            service_tier: chunk.service_tier
        };
    }
}
