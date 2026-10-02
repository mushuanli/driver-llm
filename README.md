# @itookit/driver-llm

独立的 TypeScript 模型通信客户端，支持 OpenAI Chat、Responses、Anthropic、Gemini 和可注入传输的 Codex。提供统一请求与响应、流式解析、多模态编码、超时和取消。

发布产物没有运行时或 peer 依赖。ESM、CommonJS 与类型声明均可直接使用；消息声明在构建时内联，不需要安装其他 `@itookit/*` 包。

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

