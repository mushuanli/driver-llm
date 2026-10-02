# @itookit/driver-llm

独立模型通信模块：Provider 协议、流式解析、超时、取消、多模态编码和可替换重试策略。

- 发布产物零运行时依赖；不得依赖 common、ui-common、VFS、Session、Kernel 或 kernel-adapters/llm。
- 消息契约在开发时 type import llm-context；构建必须内联这些声明，消费者不安装 llm-context。
- 通信契约归本包，llm-common 保留兼容转发。`/contracts` 仅类型和纯协议函数，不加载客户端。
- 配置、定价、默认 Agent、Skill、MCP 和 `/dev/llm` 管理归 kernel-adapters/llm。
- 网络、日志和重试决策通过实例配置注入；不得使用全局宿主服务。
- Codex 子进程仅在显式使用 Codex Provider 时延迟加载；浏览器由宿主注入 transport。
- 所有导出、类型声明与 ESM/CJS 必须在仓库外 tarball 消费者中验证。

验证：`pnpm --filter @itookit/driver-llm test`、`typecheck`、`build`。
