# @itookit/driver-llm

独立模型通信模块：Provider 协议、流式解析、超时、取消、多模态编码和可替换重试策略。

- 发布产物零运行时依赖；不得依赖 common、ui-common、VFS、Session、Kernel 或 kernel-adapters/llm。
- 通信消息契约由本包定义；源码、测试和构建均不得依赖 llm-context 或相邻工作区源码。宿主负责把领域消息映射为通信 DTO。
- 通信契约归本包，原 llm-common 和 common 的 LLM 兼容转发均已删除。`/contracts` 仅类型和纯协议函数，不加载客户端。
- 配置、定价、默认 Agent、Skill、MCP 和 `/dev/llm` 管理归 kernel-adapters/llm。
- 网络、日志和重试决策通过实例配置注入；不得使用全局宿主服务。
- Codex 子进程仅在显式使用 Codex Provider 时延迟加载；浏览器由宿主注入 transport。
- 所有导出、类型声明与 ESM/CJS 必须在仓库外 tarball 消费者中验证。

验证：`pnpm --filter @itookit/driver-llm test`、`typecheck`、`build`。

模型选择归调用方：连接测试不得猜测模型；Codex 未指定模型时让宿主使用其配置，不内置命名模型默认值。

Provider 扩展通过 createProviderRegistry().snapshot() 或 ProviderFactory 实例注入；没有全局可变注册表。工厂返回结构化 LLMProviderInstance，无需继承内置类。厂商 thinking 默认由 responses 配置或宿主目录指定。

媒体端点支持 openai-images、volcengine-images、openai-speech、doubao-speech；额外适配器通过 createMediaAdapterRegistry().snapshot() 按实例注入。豆包原生鉴权、req_params 与 JSON 分段音频解析只在 media/ 中实现，不进入 Flow 或工具。付费请求只发一次，HTTP 200 仍校验每帧业务状态，失败不返回部分音频。诊断经注入 logger 记录 requestId、厂商 logid、错误码和字节数，不记录输入、音频、密钥或原始响应。

推理能力由模型 reasoning 与 reasoningByProtocol 声明；等级、API 值、关闭能力和预算按声明校验，不维护跨厂商固定枚举。Provider 连接测试只使用显式文本模型；媒体操作验证复用正式适配器。

目录刷新按显式能力字段、模态和 supported_parameters 映射，缺失保持未知（capabilitiesKnown=false），禁止按模型名猜测或默认勾选视觉/推理/工具。modelsPath:false 显式关闭在线目录，网络请求前返回 MODEL_CATALOG_UNSUPPORTED；否则目录路径优先 modelsPath，其次从声明的聊天路径派生 models，不按业务或厂商名称分支。
