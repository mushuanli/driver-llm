// Public communication configuration contracts; llm-common forwards these definitions.

/**
 * 模型用途分类。决定模型出现在哪些选择器、用哪个主图标。
 * - `chat`      — 对话 / 文本生成（默认，未设置时视为 chat）
 * - `image`     — 文生图（如 Seedream、DALL·E）
 * - `video`     — 视频生成（如 Seedance、Sora）
 * - `audio`     — 语音合成 / 识别（如 TTS、Whisper）
 * - `embedding` — 向量嵌入（如 text-embedding）
 */
export type ModelCategory = 'chat' | 'image' | 'video' | 'audio' | 'embedding';


export interface LLMModel {
    id: string;
    name: string;
    icon?: string;
    /** 模型用途分类，缺省视为 'chat'。 */
    category?: ModelCategory;
    /** Preferred protocol when the Connection does not explicitly override it. */
    preferredProtocol?: ApiProtocol;
    contextWindow?: number;
    maxOutput?: number;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    /**
     * 控制该模型的 thinking 字段发送策略：
     * - 'auto'     不发送 thinking 字段，由模型/代理自适应（默认，适用于不明确支持 disabled 的代理模型）
     * - 'enabled'  发送 thinking.type=enabled（明确开启 extended thinking）
     * - 'disabled' 发送 thinking.type=disabled（适用于 DeepSeek 等默认开启 thinking 的模型）
     * 未设置时行为同 'auto'。
     */
    thinkingMode?: 'auto' | 'enabled' | 'disabled';
    supportsTools?: boolean;
    supportsAudio?: boolean;
    supportsVideo?: boolean;
    supportsStructuredOutput?: boolean;
    inputPricePerMillion?: number;
    outputPricePerMillion?: number;
    /** cache 写入价格，USD/M tokens（仅支持 prompt caching 的 provider） */
    cacheWritePricePerMillion?: number;
    /** cache 读取价格，USD/M tokens */
    cacheReadPricePerMillion?: number;
}


// ─── DailyCost ───────────────────────────────────────────────────────────────

/** 单日用量开销记录，按日期 key 索引，用于统计和图表 */
export interface DailyCost {
    /** ISO 日期字符串 YYYY-MM-DD */
    date: string;
    /** 输入 token 数 */
    inputTokens: number;
    /** 输出 token 数 */
    outputTokens: number;
    /** 费用（美元） */
    cost: number;
    /** 请求次数 */
    requests: number;
}


// ─── ModelTier ────────────────────────────────────────────────────────────────

/**
 * 模型质量层级。
 * - `optimal`  — 最高质量，用于规划/推理（默认）
 * - `standard` — 常规质量，用于大多数日常工作
 * - `fast`     — 低成本，用于简单/廉价任务
 */
export type ModelTier = 'optimal' | 'standard' | 'fast';


// ─── ApiProtocol ──────────────────────────────────────────────────────────────

/**
 * API 协议类型。同一厂商可提供多种协议端点
 * （如 DeepSeek 同时支持 OpenAI Chat Completions 和 Anthropic Messages 格式）。
 *
 * - `openai-chat`        — OpenAI Chat Completions API (/v1/chat/completions)
 * - `openai-responses`   — OpenAI Responses API (/responses，input items + output[])
 * - `anthropic-messages` — Anthropic Messages API (/v1/messages)
 * - `gemini-generate`    — Google Gemini generateContent API
 *
 * 未设置时由 `resolveProtocol()` 按 URL + provider 名自动推断，向后兼容。
 */
export type ApiProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate';


// ─── Provider ────────────────────────────────────────────────────────────────

export type LLMProviderImplementation =
    | 'openai-compatible'
    | 'anthropic'
    | 'gemini'
    | 'custom';


/**
 * 云提供商 — 认证 + 模型目录的唯一权威来源。
 *
 * 完整版（含 apiKey）仅在 LLMDeviceDriver 内部流通；
 * 对外通过 `getProviders()` 返回无 apiKey 版本。
 */
export interface LLMProvider {
    /** Provider 唯一标识（如 'anthropic'、'gemini'、'deepseek'） */
    id: string;
    name: string;
    implementation: LLMProviderImplementation;
    /** Explicit protocol support; omitted for legacy inferred configurations. */
    supportedProtocols?: ApiProtocol[];
    defaultProtocol?: ApiProtocol;
    /** Model catalog URL or path override, using the implementation's catalog format. */
    modelsPath?: string;
    /** Gemini Generate endpoint path override. */
    geminiPath?: string;
    chatPath?: string;
    /**
     * Provider 根域地址，不含路径（如 "https://api.deepseek.com"）。
     * Provider 实现类会在此基础上拼接 defaultPath 或内置默认路径。
     */
    baseURL: string;
    /**
     * 覆盖 Provider 实现类的内置默认 API 路径。
     * 仅当与默认值不同时填写，否则省略：
     * - openai-compatible 默认：/v1/chat/completions
     * - anthropic 默认：/v1/messages
     * - gemini 默认：/v1beta/models
     */
    defaultPath?: string;
    /**
     * 该 Provider 支持的 Anthropic Messages API 兼容路径（相对于 baseURL）。
     * 如 "/anthropic"，完整 URL = baseURL + anthropicPath。
     * 填写后 Connection 可以选择 anthropic-messages 协议使用此端点。
     */
    anthropicPath?: string;
    /**
     * 该 Provider 支持的 OpenAI Responses API 兼容路径（相对于 baseURL）。
     * 如 DeepSeek 的 "/responses"，完整 URL = baseURL + responsesPath
     * （DeepSeek Responses API 的 base_url 为 https://api.deepseek.com）。
     * 填写后 Connection 可以选择 openai-responses 协议使用此端点。
     */
    responsesPath?: string;
    /**
     * API Key — 认证凭据，存储于 Provider 层（而非 Connection 层）。
     * 仅在 LLMDeviceDriver 内部流通；对外 `getProviders()` 会剥离此字段。
     */
    apiKey?: string;
    /** 该 Provider 支持的全部模型（模型目录唯一来源，不在 Connection 中存储） */
    models: LLMModel[];
    icon?: string;
    authMethod?: 'bearer' | 'api-key' | 'query-param';
    supportsThinking?: boolean;
    requiresReferer?: boolean;
    capabilities?: {
        vision?: boolean;
        audioInput?: boolean;
        audioOutput?: boolean;
        tools?: boolean;
        thinking?: boolean;
        streaming?: boolean;
        /**
         * 是否支持「服务端内置联网搜索」（server-side web search）。
         * true = 可通过请求参数触发厂商内置检索（如 DeepSeek/OpenAI Responses 的
         * `web_search` 工具、Gemini 的 `googleSearch`），结果经 `citations[]` 回传。
         * false / undefined = 无内置检索，联网能力需靠客户端统一工具（WebSearchTool）
         * 或 MCP server 实现。
         */
        serverSideWebSearch?: boolean;
    };
    /**
     * Responses API 推理行为配置（仅 openai-responses 协议生效）。
     * defaultThinkingEnabled = 服务端默认开启思考（如 DeepSeek），此时用户显式
     * 关闭 thinking（params.thinking=false）需发送 reasoning.effort='none' 才能关闭。
     */
    responses?: {
        defaultThinkingEnabled?: boolean;
    };
    /**
     * true = 内置 Provider（由 constants.ts 定义）。
     * false / undefined = 用户新建的自定义 Provider，可以删除。
     */
    isBuiltin?: boolean;
    /**
     * Provider 是否启用。false = 禁用（所有绑定此 Provider 的 Connection 均不可用）。
     * 未设置视为 true。
     */
    enabled?: boolean;
    /**
     * Provider 默认温度（0-2），所有绑定此 Provider 的 Connection 继承此值。
     * Connection.temperature 可覆盖此默认值。
     */
    defaultTemperature?: number;
    /**
     * 整个 Provider 每日开销统计（所有 Connection 汇总）。
     * key 为 ISO 日期字符串 YYYY-MM-DD。
     */
    dailyCosts?: Record<string, DailyCost>;
}


// ─── Connection ───────────────────────────────────────────────────────────────

/**
 * 连接配置 — 引用 Provider 的命名配置，不持有 apiKey。
 *
 * 职责：命名 + 引用 Provider + 可选 tier 覆盖。
 * 认证（apiKey）由 Provider 统一管理。
 */
export interface LLMConnection {
    id: string;
    name: string;
    /** 引用 LLMProvider.id */
    providerId: string;
    /**
     * Tier → model ID 覆盖，优先级高于 Provider.defaultTiers。
     * 不填则直接使用 Provider.defaultTiers。
     */
    tiers?: Partial<Record<ModelTier, string>>;
    /**
     * API 协议类型。同一厂商可通过不同 URL 提供多种协议（如 DeepSeek 的
     * openai-chat 端点和 anthropic-messages 端点）。
     *
     * 未设置时由 `resolveProtocol()` 按 URL + provider 名自动推断，向后兼容。
     */
    protocol?: ApiProtocol;
    metadata?: {
        isSystemDefault?: boolean;
        thinkingBudget?: number;
        reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
        /** Connection overrides keyed by model ID. */
        modelReasoningEfforts?: Record<string, 'low' | 'medium' | 'high' | 'xhigh'>;
        mcpServers?: string[];
        caching?: boolean;
        headers?: Record<string, string>;
        [key: string]: unknown;
    };
    /**
     * Connection 是否启用。false = 禁用（不出现在选择器中，不可用于发起请求）。
     * 未设置视为 true。
     */
    enabled?: boolean;
    status?: 'active' | 'error' | 'untested';
    /**
     * 温度参数（0-2），覆盖 Provider.defaultTemperature。
     * 未设置则使用 Provider 的默认温度。
     */
    temperature?: number;
    /**
     * 本连接每日开销统计，key 为 ISO 日期字符串 YYYY-MM-DD。
     * 与 Provider.dailyCosts 独立——Provider 存储所有 Connection 的汇总。
     */
    dailyCosts?: Record<string, DailyCost>;
    lastTestedAt?: number;
    lastTestResult?: boolean;
    createdAt?: number;
    updatedAt?: number;

    // ── 向后兼容字段（迁移旧数据时读取，新数据不再写入） ────────────────

    /**
     * 覆盖 Provider.baseURL。用于同一厂商多协议端点场景
     * （如 DeepSeek openai-chat 用 /v1，anthropic-messages 用 /anthropic）。
     * 未设置则使用 Provider.baseURL。
     */
    baseURL?: string;
}


// ─── ConnectionMeta (safe, no apiKey) ─────────────────────────────────────────

/**
 * 安全连接元数据 — 供 AgentExecutor、UI 等外部模块使用。
 * hasApiKey 反映关联 Provider 是否配置了 apiKey。
 */
export interface ConnectionMeta {
    id: string;
    name: string;
    /** Provider ID */
    providerId: string;
    /** 已解析的 optimal 层级模型 ID（tiers.optimal → provider.models[0]） */
    model: string;
    /** Tier 映射（继承自 Connection.tiers 或 Provider.defaultTiers） */
    tiers?: Partial<Record<ModelTier, string>>;
    /** 关联 Provider 是否已配置 apiKey */
    hasApiKey: boolean;
    /**
     * 此连接是否可用（Connection.enabled && Provider.enabled 均为 true）。
     * false = 连接或其 Provider 被禁用，不可发起请求。
     */
    enabled: boolean;
    metadata?: Record<string, unknown>;
    status?: 'active' | 'error' | 'untested';
    /** 已解析的温度值（connection.temperature ?? provider.defaultTemperature） */
    temperature?: number;
    /** 本连接每日开销统计 */
    dailyCosts?: Record<string, DailyCost>;
    /** API 协议类型；未设置时由 resolveProtocol() 自动推断 */
    protocol?: ApiProtocol;
}


// ─── ConnectionTestResult ─────────────────────────────────────────────────────

export interface ConnectionTestResult {
    success: boolean;
    message: string;
    latency?: number;
    model?: string;
}


/** Unsaved Provider configuration used by settings requests. */
export interface ProviderConnectionTestParams {
    provider: string;
    apiKey?: string;
    baseURL?: string;
    model?: string;
    protocol?: ApiProtocol;
    providerDefinition?: LLMProvider;
}
