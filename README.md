# @itookit/driver-llm

独立的 TypeScript 模型通信客户端，支持 OpenAI Chat、Responses、Anthropic、Gemini 和可注入传输的 Codex。提供统一请求与响应、流式解析、多模态编码、超时和取消。

发布产物没有运行时或 peer 依赖。ESM、CommonJS 与类型声明均可直接使用；通信消息类型由本包定义，源码与构建均不依赖其他 `@itookit/*` 包。

## 安装和调用

```sh
npm install @itookit/driver-llm
```

```ts
import { LLMDriver } from '@itookit/driver-llm';

const client = new LLMDriver({
  provider: 'openai',
  protocol: 'openai-chat',
  apiKey: 'YOUR_API_KEY',
  apiBaseUrl: 'https://your-provider.example/v1',
  model: 'your-model',
});

try {
  const response = await client.chat.create({
    messages: [{ role: 'user', content: '你好' }],
  });
  console.log(response.choices[0]?.message.content);
} finally {
  await client.dispose();
}
```

供应商的地址、模型和协议由调用方提供。内置少量协议地址默认值；完整模型目录、定价和命名连接不属于通信客户端。

## 流式响应与取消

```ts
const abort = new AbortController();
const stream = await client.chat.create({
  messages: [{ role: 'user', content: '解释这个问题' }],
  stream: true,
  signal: abort.signal,
});
for await (const chunk of stream) {
  console.log(chunk.choices[0]?.delta.content ?? '');
}
// 在需要时调用 abort.abort()；最终调用 client.dispose()。
```

`timeout` 同时约束普通请求和流式等待；消费者提前结束流时清理请求。通信返回工具调用及 usage，工具执行、费用累加、历史保存和审批由调用方处理。

## 实例级扩展

`LLMClientConfig` 接受 `fetch`、`logger` 和 `retryPolicy`。每个客户端单独配置，不修改全局网络函数或日志服务。

```ts
const client = new LLMDriver({
  provider: 'openai', apiKey: 'key', model: 'your-model',
  fetch: yourFetch,
  logger: yourLogger,
  maxRetries: 3,
  retryPolicy: {
    shouldRetry: (error, attempt) => attempt < 3 && shouldRetry(error),
    delayMs: (_error, attempt) => 100 * attempt,
  },
});
```

`maxRetries` 保留旧 API 含义：最多尝试次数，设为 `1` 禁用重试。取消会中断重试等待。`logger` 提供 `debug/info/warn/error`；默认不输出日志。

注入的 `fetch` 用于模型请求；HTTP 附件读取和模型目录查询是独立辅助函数。需要自定义文件或资源读取时，调用方可以先把附件转换为内容块，或通过 `hooks.beforeRequest` 准备请求。

## 公共入口

| 入口 | 用途 |
|---|---|
| `@itookit/driver-llm` | 客户端、Provider、流与附件工具、错误和公开类型 |
| `@itookit/driver-llm/contracts` | 通信类型与纯协议函数；不加载客户端或子进程实现 |
| `@itookit/driver-llm/chain` | 可选顺序提示词组合 |

浏览器的 HTTP Provider 使用标准 Web API。Codex 默认在 Node 中延迟启动本地 CLI；浏览器或嵌入式宿主通过 `codex.transport` 或 `codex.runner` 注入执行能力。调用 `dispose()` 释放客户端持有的 Codex 资源。

## 从旧 device-llm 迁移

- `LLMDriver`、Provider、SSE、附件与通信类型改从 `driver-llm` 导入。
- `LLMChain` 改从 `driver-llm/chain` 导入。
- `LLMDeviceDriver`、`LLM_IOCTL`、默认 Agent、`.llm` 配置、费用、Skill 和 MCP 管理改从 `kernel-adapters/llm` 导入。
- 构造客户端时显式提供模型与供应商配置，不依赖 MindOS 的默认连接、定价目录或 VFS 初始化。


`@itookit/driver-llm/contracts` 也导出 `ILLMService`：以 connectionId 调用模型的服务端口。它只定义接口，连接仓储、默认连接和凭据管理由宿主实现；`LLMDriver` 是单客户端 API，不直接实现该命名连接服务。

模型选择：testLLMConnection 必须提供 model，或通过 providerDefinition.models 注入测试目录；缺失时返回 Model is required，不猜测厂商模型。Codex 优先使用请求 model，再使用客户端配置 model；两者缺失时不发送模型覆盖，由 Codex 宿主选择，响应不伪造已选模型名称。

## Provider 扩展与迁移

```ts
import { LLMDriver, createProviderRegistry } from '@itookit/driver-llm';

const registry = createProviderRegistry({ custom: YourProvider });
const client = new LLMDriver({ provider: 'custom', apiKey: 'key',
  providerFactory: registry.snapshot(),
});
```

每个注册表独立，snapshot 固定后续模型切换使用的实现。旧全局 registerProvider/getProvider/getRegisteredProviders/isProviderRegistered 已删除；对应操作使用实例 register/get/names。也可以直接注入 ProviderFactory，其返回值只需实现 LLMProviderInstance，不要求继承 BaseProvider。

厂商服务端默认思考行为通过 `responses: { defaultThinkingEnabled: true }` 或 customProviderDefaults 显式指定；通信模块不再内置 DeepSeek thinking 默认。MindOS 可选目录保留该厂商配置。

通信边界先校验成功 HTTP 响应与 SSE 对象结构，再执行各协议标准化；畸形 HTTP 结果明确失败，畸形 SSE 帧按既有行为跳过并继续读取后续事件。保留厂商扩展字段、Responses 文本 delta 和 OpenAI usage=null 兼容；新增校验不引入运行时依赖。

## 消息边界

`ChatCompletionParams`、`ChatMessage`、`MessageContentPart` 和工具通信类型由驱动定义。调用方组装历史与上下文，再映射为这些请求类型；驱动不导入上下文引擎或会话模型。已有消息结构兼容时可直接传入，无需额外的运行时包装。

普通消息、内容分段和工具 schema 可作为 JSON 数据传入。`signal` 和二进制 `attachments` 是可选的本地调用能力，JSON 序列化前必须移除或转换。网络、日志与重试函数通过客户端配置单独注入。
