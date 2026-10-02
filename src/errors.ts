// @file: driver-llm/errors.ts

/**
 * LLM 错误码
 */
export enum LLMErrorCode {
    // 网络错误
    NETWORK_ERROR = 'NETWORK_ERROR',
    TIMEOUT = 'TIMEOUT',
    
    // 认证错误
    INVALID_API_KEY = 'INVALID_API_KEY',
    UNAUTHORIZED = 'UNAUTHORIZED',
    
    // 限制错误
    RATE_LIMIT = 'RATE_LIMIT',
    QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
    CONTEXT_LENGTH_EXCEEDED = 'CONTEXT_LENGTH_EXCEEDED',
    
    // 请求错误
    INVALID_REQUEST = 'INVALID_REQUEST',
    MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
    CONTENT_FILTER = 'CONTENT_FILTER',
    
    // 服务错误
    SERVER_ERROR = 'SERVER_ERROR',
    SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
    
    // 其他
    UNKNOWN = 'UNKNOWN',
    ABORTED = 'ABORTED'
}

/**
 * LLM 错误详情
 */
export interface LLMErrorDetails {
    /** 错误码 */
    code: LLMErrorCode;

    /** Provider 标识 */
    provider: string;

    /** 目标模型 ID */
    model?: string;

    /** HTTP 状态码 */
    statusCode?: number;

    /** 原始错误 */
    cause?: unknown;

    /** 请求体 (用于调试) */
    requestBody?: any;

    /** 是否可重试 */
    retryable: boolean;

    /** 重试延迟建议 (ms) */
    retryAfter?: number;
}

/**
 * LLM 错误类
 */
export class LLMError extends Error {
    public readonly code: LLMErrorCode;
    public readonly provider: string;
    /** 目标模型 ID，由调用链上游注入 */
    public model?: string;
    public readonly statusCode?: number;
    public readonly cause?: unknown;
    public readonly retryable: boolean;
    public readonly retryAfter?: number;

    constructor(message: string, details: LLMErrorDetails) {
        super(message);
        this.name = 'LLMError';
        this.code = details.code;
        this.provider = details.provider;
        this.model = details.model;
        this.statusCode = details.statusCode;
        this.cause = details.cause;
        this.retryable = details.retryable;
        this.retryAfter = details.retryAfter;
    }
    
    /**
     * 从 HTTP 响应创建错误
     */
    static fromResponse(
        provider: string,
        statusCode: number,
        body: any,
        model?: string,
    ): LLMError {
        const { code, message, retryable, retryAfter } = this.parseErrorResponse(statusCode, body);

        const errorMsg = model
            ? `Model '${model}': ${message}`
            : message;

        return new LLMError(errorMsg, {
            code,
            provider,
            model,
            statusCode,
            cause: body,
            retryable,
            retryAfter,
        });
    }
    
    /**
     * 从异常创建错误
     */
    static fromException(provider: string, error: any): LLMError {
        // 处理中止
        if (error.name === 'AbortError') {
            return new LLMError('Request aborted', {
                code: LLMErrorCode.ABORTED,
                provider,
                cause: error,
                retryable: false
            });
        }
        
        // 处理超时
        if (error.name === 'TimeoutError' || error.message?.includes('timeout')) {
            return new LLMError('Request timed out', {
                code: LLMErrorCode.TIMEOUT,
                provider,
                cause: error,
                retryable: true
            });
        }
        
        // 处理网络错误
        if (error.name === 'TypeError' && error.message?.includes('fetch')) {
            return new LLMError('Network error', {
                code: LLMErrorCode.NETWORK_ERROR,
                provider,
                cause: error,
                retryable: true
            });
        }
        
        // 通用错误
        return new LLMError(error.message || 'Unknown error', {
            code: LLMErrorCode.UNKNOWN,
            provider,
            cause: error,
            retryable: true
        });
    }
    
    /**
     * 解析错误响应
     */
    private static parseErrorResponse(
        statusCode: number,
        body: any
    ): { code: LLMErrorCode; message: string; retryable: boolean; retryAfter?: number } {
        const errorMessage = body?.error?.message || body?.message || `HTTP ${statusCode}`;
        
        switch (statusCode) {
            case 400:
                return {
                    code: LLMErrorCode.INVALID_REQUEST,
                    message: errorMessage,
                    retryable: false
                };
                
            case 401:
                return {
                    code: LLMErrorCode.INVALID_API_KEY,
                    message: 'Invalid API key',
                    retryable: false
                };
                
            case 403:
                return {
                    code: LLMErrorCode.UNAUTHORIZED,
                    message: errorMessage,
                    retryable: false
                };
                
            case 404:
                return {
                    code: LLMErrorCode.MODEL_NOT_FOUND,
                    message: errorMessage,
                    retryable: false
                };
                
            case 429:
                return {
                    code: LLMErrorCode.RATE_LIMIT,
                    message: 'Rate limit exceeded',
                    retryable: true,
                    retryAfter: this.parseRetryAfter(body)
                };
                
            case 500:
            case 502:
            case 503:
            case 504:
                return {
                    code: LLMErrorCode.SERVER_ERROR,
                    message: errorMessage,
                    retryable: true
                };
                
            default:
                return {
                    code: LLMErrorCode.UNKNOWN,
                    message: errorMessage,
                    retryable: statusCode >= 500
                };
        }
    }
    
    private static parseRetryAfter(body: any): number | undefined {
        // 尝试从响应中提取重试时间
        const retryAfter = body?.error?.retry_after || body?.retry_after;
        if (typeof retryAfter === 'number') {
            return retryAfter * 1000; // 转换为毫秒
        }
        return undefined;
    }
}
