/** Public model communication mechanisms. Host configuration and persistence live in kernel-adapters/llm. */

// 核心类
// ============================================

export { LLMDriver } from './core/driver';
export { testLLMConnection, testMultipleConnections } from './core/api';
export type { ConnectionTestResult } from './core/api';

// ============================================
// 错误处理
// ============================================

export { LLMError, LLMErrorCode } from './errors';
export type { LLMErrorDetails } from './errors';

// ============================================
// 类型定义
// ============================================

// 连接配置
export type {
    LLMConnection,
    LLMModel,
    LLMProvider,
} from './types/connection';

// 消息
export type {
    ChatMessage,
    MessageContent,
    MessageContentPart,
    MessageContentText,
    MessageContentImage,
    MessageContentAudio,
    MessageContentVideo,
    MessageContentFile,
    MessageContentToolResult,
    MessageContentCodeExecution,
    MessageContentCitation,
    Role,
    ToolCall,
    ToolDefinition,
    ComputerUseAction,
    MCPToolCall,
    Attachment,
    AttachmentType            // 新增
} from './types/message';

// Provider 配置
export type {
    LLMProviderConfig,
    LLMClientConfig,
    LLMHooks,
    ProviderCapabilities,
    CodexCLIConfig,
    CodexCommandRunner,
    CodexCommandResult,
    CodexAppServerTransport,
    CodexRPCMessage
} from './types/provider';

// 请求/响应
export type {
    ChatCompletionParams,
    ChatCompletionResponse,
    ChatCompletionChunk,
    AssistantMessage,
    ToolChoice,
    ResponseFormat,
    TokenUsage,
    Citation,
    FinishReason
} from './types/response';

// ============================================
// Provider 系统
// ============================================

export { BaseProvider } from './providers/base';
export { OpenAIProvider } from './providers/openai';
export { ResponsesProvider } from './providers/responses';
export { AnthropicProvider } from './providers/anthropic';
export { GeminiProvider } from './providers/gemini';
export { CodexProvider } from './providers/codex';
export { AsyncEventHub, rejectPending } from './runtime/async-event-hub';
export { JsonRpcLineTransport } from './runtime/json-rpc-transport';

export { registerProvider, getProvider, createProvider, getRegisteredProviders, isProviderRegistered, resolveProtocol } from './providers/registry';

// 工具函数
// ============================================

export {
    processAttachment,
    isSupportedVisionContent,
    isSupportedAudioContent,
    isSupportedVideoContent,
    isSupportedTextContent,        // 新增
    buildImageContent,
    buildAudioContent,
    buildVideoContent,
    buildFileContent,
    buildTextContent,              // 新增
    readTextSource,                // 新增
    attachmentToContentPart,
    processAttachments,
    expandMessageAttachments,      // 新增
    expandMessagesAttachments,     // 新增
    detectMediaType,
    SUPPORTED_MEDIA_TYPES
} from './utils/attachment';

export type { ProcessedAttachment } from './utils/attachment';

export {
    parseSSEStream,
    createCancellableStream,
    mergeStreams
} from './utils/stream';

export { NoopLLMLogger } from './utils/llm-logger';

// ============================================

export type * from './types';
export { API_PROTOCOLS, getPrimaryProtocol, getProviderProtocols, getProviderDefaultProtocol } from './types/protocol';
export { listProviderModels } from './providers/model-catalog';
