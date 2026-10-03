import { decodeWireObject, parseWireEvent } from '../utils/wire-decoder';
// @file: driver-llm/providers/gemini.ts

import { BaseProvider } from './base';
import {
    LLMProviderConfig,
    ChatCompletionParams,
    ChatCompletionResponse,
    ChatCompletionChunk,
    ChatMessage,
    ProviderCapabilities,
} from '../types';
import type { Citation } from '../types';
import { parseSSEStream } from '../utils/stream';

/**
 * Google Gemini Provider
 * 
 * 特点：
 * 1. 使用 generateContent API
 * 2. 支持 thinking mode (Gemini 2.0+)
 * 3. 支持多模态 (图片、音频、视频、PDF)
 * 4. 支持代码执行
 * 5. 支持 Google Search grounding
 */
export class GeminiProvider extends BaseProvider {
    readonly name = 'gemini';

    readonly capabilities: ProviderCapabilities = {
        vision: true,
        audioInput: true,       // Gemini 支持音频输入
        audioOutput: false,     // 暂不支持音频输出
        video: true,            // Gemini 支持视频理解
        documents: true,        // 支持 PDF
        tools: true,
        parallelTools: true,
        structuredOutput: true,
        jsonMode: true,
        thinking: true,         // Gemini 2.0+ 支持
        codeExecution: true,    // Gemini 特有
        computerUse: false,
        mcp: false,
        caching: true,          // Context caching
        batch: false,
        streaming: true
    };

    constructor(config: LLMProviderConfig) {
        super(config);
        if (!this.baseURL) {
            this.baseURL = 'https://generativelanguage.googleapis.com';
        }
    }

    private resolveModelsBase(): string {
        return this.resolveEndpointUrl(this.config.defaultPath ?? '/v1beta/models');
    }

    protected getProviderFormat(): 'openai' | 'anthropic' | 'gemini' {
        return 'gemini';
    }

    async create(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
        this.validateParams(params);
        const processedParams = await this.preprocessMessages(params);

        const model = this.getModel(processedParams);
        const url = `${this.resolveModelsBase()}/${model}:generateContent?key=${this.config.apiKey}`;
        const body = this.buildRequestBody(processedParams);

        const response = await this.fetchJSON<unknown>(url, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: params.signal
        });

        return this.normalizeResponse(decodeWireObject(response, 'candidates'), model);
    }

    async *stream(params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
        this.validateParams(params);
        const processedParams = await this.preprocessMessages(params);

        const model = this.getModel(processedParams);
        const url = `${this.resolveModelsBase()}/${model}:streamGenerateContent?alt=sse&key=${this.config.apiKey}`;
        const body = this.buildRequestBody(processedParams);

        const stream = await this.fetchStream(url, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(body),
            signal: params.signal
        });

        for await (const data of parseSSEStream(stream)) {
            try {
                const event = parseWireEvent(data);
                const chunk = this.normalizeChunk(event, model);
                if (chunk) yield chunk;
            } catch {
                // 忽略解析错误
            }
        }
    }

    // ============== 请求构建 ==============

    protected buildHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json'
            // API key 在 URL 中
        };
    }

    protected buildRequestBody(params: ChatCompletionParams): Record<string, any> {
        const { systemInstruction, contents } = this.convertMessages(params.messages);

        const body: Record<string, any> = {
            contents
        };

        // System instruction (支持缓存)
        if (systemInstruction) {
            body.systemInstruction = this.buildSystemInstruction(systemInstruction, params.caching);
        }

        // Generation config
        const generationConfig: Record<string, any> = {};

        if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
        if (params.maxTokens !== undefined) generationConfig.maxOutputTokens = params.maxTokens;
        if (params.topP !== undefined) generationConfig.topP = params.topP;
        if (params.stop !== undefined) {
            generationConfig.stopSequences = Array.isArray(params.stop) ? params.stop : [params.stop];
        }

        // 响应格式 - 结构化输出
        if (params.responseFormat) {
            if (params.responseFormat.type === 'json_object') {
                generationConfig.responseMimeType = 'application/json';
            } else if (params.responseFormat.type === 'json_schema') {
                generationConfig.responseMimeType = 'application/json';
                generationConfig.responseSchema = params.responseFormat.json_schema.schema;
            }
        }

        if (Object.keys(generationConfig).length > 0) {
            body.generationConfig = generationConfig;
        }

        // Thinking mode (Gemini 2.0+)
        if (params.thinking) {
            body.generationConfig = body.generationConfig || {};
            body.generationConfig.thinkingConfig = {
                thinkingBudget: params.thinkingBudget || 8000
            };
        }

        // 工具配置
        const tools = this.buildTools(params);
        if (tools.length > 0) {
            body.tools = tools;
        }

        // 工具选择
        if (params.toolChoice && params.tools?.length) {
            body.toolConfig = this.buildToolConfig(params.toolChoice);
        }

        // 安全设置 (可选)
        if (params.metadata?.safetySettings) {
            body.safetySettings = params.metadata.safetySettings;
        }

        return body;
    }

    /**
     * 构建 System Instruction (支持缓存)
     */
    private buildSystemInstruction(
        systemInstruction: string,
        caching?: boolean | { ttl?: number }
    ): any {
        const instruction: any = {
            parts: [{ text: systemInstruction }]
        };

        // Gemini 的缓存通过 cachedContent 实现，这里标记意图
        if (caching) {
            instruction.cacheControl = { type: 'ephemeral' };
        }

        return instruction;
    }

    /**
     * 构建工具列表
     */
    private buildTools(params: ChatCompletionParams): any[] {
        const tools: any[] = [];

        // 函数工具
        if (params.tools && params.tools.length > 0) {
            const functionDeclarations = params.tools
                .filter(tool => tool.type === 'function' && tool.function)
                .map(tool => ({
                    name: tool.function!.name,
                    description: tool.function!.description,
                    parameters: this.convertJsonSchemaToGemini(tool.function!.parameters ?? {})
                }));

            if (functionDeclarations.length > 0) {
                tools.push({ functionDeclarations });
            }
        }

        // 代码执行工具
        if (params.codeExecution) {
            tools.push({
                codeExecution: typeof params.codeExecution === 'object'
                    ? params.codeExecution
                    : {}
            });
        }

        // Google Search grounding
        if (params.webSearch) {
            tools.push({
                googleSearch: typeof params.webSearch === 'object'
                    ? params.webSearch
                    : {}
            });
        }

        return tools;
    }

    /**
     * 构建工具配置
     */
    private buildToolConfig(toolChoice: ChatCompletionParams['toolChoice']): any {
        if (toolChoice === 'none') {
            return { functionCallingConfig: { mode: 'NONE' } };
        }
        if (toolChoice === 'auto') {
            return { functionCallingConfig: { mode: 'AUTO' } };
        }
        if (toolChoice === 'required') {
            return { functionCallingConfig: { mode: 'ANY' } };
        }
        if (typeof toolChoice === 'object' && 'function' in toolChoice) {
            return {
                functionCallingConfig: {
                    mode: 'ANY',
                    allowedFunctionNames: [toolChoice.function.name]
                }
            };
        }
        return { functionCallingConfig: { mode: 'AUTO' } };
    }

    /**
     * 转换 JSON Schema 到 Gemini 格式
     * Gemini 使用 OpenAPI 3.0 schema 格式
     */
    private convertJsonSchemaToGemini(schema: Record<string, any>): Record<string, any> {
        if (!schema) return {};

        // Gemini 不支持某些 JSON Schema 特性，需要转换
        const converted = { ...schema };

        // 移除不支持的字段
        delete converted.$schema;
        delete converted.$id;
        delete converted.$ref;
        delete converted.definitions;

        return converted;
    }

    /**
     * 转换消息格式
     */
    private convertMessages(messages: ChatMessage[]): {
        systemInstruction: string | null;
        contents: any[];
    } {
        let systemInstruction: string | null = null;
        const contents: any[] = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                const text = typeof msg.content === 'string'
                    ? msg.content
                    : msg.content.map(p => p.type === 'text' ? (p as any).text : '').join('\n');

                systemInstruction = systemInstruction
                    ? `${systemInstruction}\n\n${text}`
                    : text;
            } else if (msg.role === 'tool') {
                // 工具结果
                contents.push({
                    role: 'user',
                    parts: [{
                        functionResponse: {
                            name: msg.name || 'unknown',
                            response: {
                                result: typeof msg.content === 'string'
                                    ? msg.content
                                    : JSON.stringify(msg.content)
                            }
                        }
                    }]
                });
            } else {
                contents.push({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: this.convertParts(msg.content)
                });
            }
        }

        return { systemInstruction, contents };
    }

    /**
     * 转换内容部分
     */
    private convertParts(content: ChatMessage['content']): any[] {
        if (typeof content === 'string') {
            return [{ text: content }];
        }

        return content.map(part => {
            switch (part.type) {
                case 'text':
                    return { text: (part as any).text };

                case 'image_url':
                case 'image':
                    return this.convertImagePart(part);

                case 'input_audio':
                case 'audio':
                    return this.convertAudioPart(part);

                case 'video':
                    return this.convertVideoPart(part);

                case 'file':
                case 'document':
                    return this.convertFilePart(part);

                case 'tool_result':
                    return {
                        functionResponse: {
                            name: (part as any).tool_use_id || 'unknown',
                            response: {
                                result: (part as any).content
                            }
                        }
                    };

                default:
                    return { text: '' };
            }
        }).filter(p => p !== null);
    }

    /**
     * 转换图片部分
     */
    private convertImagePart(part: any): any {
        // OpenAI 格式
        if (part.image_url) {
            const url = part.image_url.url;
            if (url.startsWith('data:')) {
                const [header, data] = url.split(',');
                const mimeType = header.match(/data:(.*?);/)?.[1] || 'image/jpeg';
                return {
                    inlineData: {
                        mimeType,
                        data
                    }
                };
            }
            return {
                fileData: {
                    fileUri: url,
                    mimeType: 'image/jpeg'
                }
            };
        }

        // Anthropic/通用格式
        if (part.source) {
            if (part.source.type === 'base64') {
                return {
                    inlineData: {
                        mimeType: part.source.media_type || 'image/jpeg',
                        data: part.source.data
                    }
                };
            }
            if (part.source.type === 'url') {
                return {
                    fileData: {
                        fileUri: part.source.url,
                        mimeType: part.source.media_type || 'image/jpeg'
                    }
                };
            }
        }

        return { text: '[Image]' };
    }

    /**
     * 转换音频部分
     */
    private convertAudioPart(part: any): any {
        if (part.input_audio) {
            // 映射格式到 MIME 类型
            const formatToMime: Record<string, string> = {
                'wav': 'audio/wav',
                'mp3': 'audio/mp3',
                'flac': 'audio/flac',
                'opus': 'audio/ogg',
                'pcm16': 'audio/pcm'
            };

            return {
                inlineData: {
                    mimeType: formatToMime[part.input_audio.format] || 'audio/wav',
                    data: part.input_audio.data
                }
            };
        }

        return { text: '[Audio]' };
    }

    /**
     * 转换视频部分
     */
    private convertVideoPart(part: any): any {
        if (part.video) {
            if (part.video.source === 'base64' && part.video.data) {
                return {
                    inlineData: {
                        mimeType: part.video.mime_type || 'video/mp4',
                        data: part.video.data
                    }
                };
            }
            if (part.video.source === 'url' && part.video.url) {
                return {
                    fileData: {
                        fileUri: part.video.url,
                        mimeType: part.video.mime_type || 'video/mp4'
                    }
                };
            }
            if (part.video.source === 'file_id' && part.video.file_id) {
                return {
                    fileData: {
                        fileUri: part.video.file_id
                    }
                };
            }
        }

        return { text: '[Video]' };
    }

    /**
     * 转换文件部分
     */
    private convertFilePart(part: any): any {
        const file = part.file || part.document;
        if (!file) return { text: '[File]' };

        // Base64 数据
        if (file.source === 'base64' || file.data) {
            return {
                inlineData: {
                    mimeType: file.mime_type || 'application/octet-stream',
                    data: file.data
                }
            };
        }

        // URL
        if (file.source === 'url' || file.url) {
            return {
                fileData: {
                    fileUri: file.url,
                    mimeType: file.mime_type || 'application/octet-stream'
                }
            };
        }

        return { text: `[File: ${file.filename || 'unknown'}]` };
    }

    // ============== 响应标准化 ==============

    protected normalizeResponse(response: any, model: string): ChatCompletionResponse {
        const candidate = response.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        let content = '';
        let thinking = '';
        const toolCalls: any[] = [];
        let codeExecution: any = undefined;
        const citations: Citation[] = [];

        for (const part of parts) {
            // 文本内容
            if (part.text) {
                content += part.text;
            }

            // 思考内容 (Gemini 2.0+)
            if (part.thought) {
                thinking += part.thought;
            }

            // 函数调用
            if (part.functionCall) {
                toolCalls.push({
                    id: `call_${Date.now()}_${toolCalls.length}`,
                    type: 'function',
                    function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args || {})
                    }
                });
            }

            // 代码执行结果
            if (part.executableCode) {
                codeExecution = {
                    code: part.executableCode.code,
                    language: part.executableCode.language || 'python'
                };
            }

            if (part.codeExecutionResult) {
                codeExecution = codeExecution || {};
                if (part.codeExecutionResult.outcome === 'OUTCOME_OK') {
                    codeExecution.output = part.codeExecutionResult.output;
                } else {
                    codeExecution.error = part.codeExecutionResult.output;
                }
            }
        }

        // 提取 grounding 引用 → 统一 Citation 形状（与 Responses / 客户端工具对齐）
        if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
            for (const chunk of response.candidates[0].groundingMetadata.groundingChunks) {
                if (chunk.web) {
                    const title = chunk.web.title ?? chunk.web.uri ?? 'Web search';
                    citations.push({
                        text: title,
                        title: chunk.web.title,
                        url: chunk.web.uri,
                        source: 'grounding',
                    });
                }
            }
        }

        return {
            id: `gemini-${Date.now()}`,
            model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content,
                    thinking: thinking || undefined,
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                    code_execution: codeExecution
                },
                finish_reason: this.mapFinishReason(candidate?.finishReason)
            }],
            usage: response.usageMetadata ? {
                prompt_tokens: response.usageMetadata.promptTokenCount || 0,
                completion_tokens: response.usageMetadata.candidatesTokenCount || 0,
                total_tokens: response.usageMetadata.totalTokenCount || 0,
                thinking_tokens: response.usageMetadata.thoughtsTokenCount,
                cached_tokens: response.usageMetadata.cachedContentTokenCount
            } : undefined,
            citations: citations.length > 0 ? citations : undefined
        };
    }

    protected normalizeChunk(event: any, model: string): ChatCompletionChunk | null {
        const candidate = event.candidates?.[0];
        if (!candidate) return null;

        const parts = candidate.content?.parts || [];

        let content = '';
        let thinking = '';
        const toolCalls: any[] = [];

        for (const part of parts) {
            if (part.text) {
                content += part.text;
            }
            if (part.thought) {
                thinking += part.thought;
            }
            if (part.functionCall) {
                toolCalls.push({
                    index: toolCalls.length,
                    id: `call_${Date.now()}_${toolCalls.length}`,
                    type: 'function',
                    function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args || {})
                    }
                });
            }
        }

        // 如果没有任何内容，跳过
        if (!content && !thinking && toolCalls.length === 0) {
            return null;
        }

        return {
            id: `gemini-${Date.now()}`,
            model,
            choices: [{
                index: 0,
                delta: {
                    content: content || undefined,
                    thinking: thinking || undefined,
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                },
                finish_reason: this.mapFinishReason(candidate.finishReason)
            }],
            usage: event.usageMetadata ? {
                prompt_tokens: event.usageMetadata.promptTokenCount || 0,
                completion_tokens: event.usageMetadata.candidatesTokenCount || 0,
                total_tokens: event.usageMetadata.totalTokenCount || 0
            } : undefined
        };
    }

    /**
     * 映射结束原因
     */
    private mapFinishReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
        switch (reason) {
            case 'STOP':
                return 'stop';
            case 'MAX_TOKENS':
                return 'length';
            case 'SAFETY':
            case 'RECITATION':
            case 'BLOCKLIST':
                return 'content_filter';
            case 'TOOL_CODE':
            case 'FUNCTION_CALL':
                return 'tool_calls';
            default:
                return null;
        }
    }
}
