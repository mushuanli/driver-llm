# @itookit/driver-llm

独立的 TypeScript 模型通信客户端，支持 OpenAI Chat、Responses、ChatGPT 订阅 OAuth、Anthropic、Gemini 和可注入传输的 Codex。提供统一请求与响应、流式解析、多模态编码、超时和取消。

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

注入的 `fetch` 用于模型请求；模型目录辅助函数可通过第二个参数注入 `fetch` 和 `signal`。HTTP 附件读取是独立辅助函数。需要自定义文件或资源读取时，调用方可以先把附件转换为内容块，或通过 `hooks.beforeRequest` 准备请求。

## ChatGPT 订阅 OAuth（0.3.1）

`ConnectionMeta.credentialsReady` 是宿主可选的认证可用性投影，允许 UI 统一表示 API Key、OAuth 和本地连接，不包含凭据。

`provider: 'chatgpt'` 使用官方 Sign in with ChatGPT 的订阅授权，协议仍为 `openai-responses`，不接受 API key 代替 OAuth 会话。宿主负责浏览器登录、PKCE、身份验证、账号选择、凭据存储和刷新令牌轮换；driver 只注入通信端口，无登录服务器或文件系统依赖。

自定义 Provider ID 可在 `customProviderDefaults` 中声明 `implementation:'chatgpt'`，并显式提供 `defaultProtocol:'openai-responses'`、`baseURL:'https://api.openai.com/v1'`、模型目录及同一个 `chatgpt.session`。这一实现类型始终应用订阅通道限制，不能用覆盖协议绕过。

```ts
import { LLMDriver, createChatGPTAuthSession, listChatGPTModels } from '@itookit/driver-llm';

// credentialStore and renewAndSaveCredentials are supplied by the host.
// Bind this session to one validated account/workspace registration.
const session = createChatGPTAuthSession({
  read: () => credentialStore.readAccessToken(),
  refresh: () => renewAndSaveCredentials(),
});
const chatgpt = { session };
const models = await listChatGPTModels(chatgpt);
const selected = models.find(model => model.id === userSelectedModel);
if (!selected) throw new Error('Select an available account model');

const client = new LLMDriver({ provider: 'chatgpt', chatgpt, model: selected.id });
try {
  const response = await client.chat.create({ messages: [{ role: 'user', content: '你好' }] });
  console.log(response.choices[0]?.message.content);
} finally {
  await client.dispose();
}
```

`read` / `refresh` 返回 `{ accessToken, scopes, expiresAt? }`。`scopes` 必须来自实际 token 响应且含 `resource.invoke`、`chatgpt.tokens.use.direct`；`expiresAt` 是 Unix 毫秒。宿主在 `refresh` 返回前原子保存新凭据（含轮换的 refresh token），并保留账号绑定。driver 不解析或验证 ID token；宿主须完成此步骤。账号切换使用新 session，并重新读取该账号模型目录。

同一账号的多个 driver 和目录请求应复用同一 session：过期或首次 401 合并刷新，最多重新发送一次未通过认证的请求。取消一个等待者不取消共享刷新。401 重试后仍失败、额度不足、流中失败和传输中断均不隐式重发生成；自定义 `retryPolicy` 可以覆盖这一默认，请勿对已开始的生成盲目重试。

请求固定到公共 `https://api.openai.com/v1/responses`，禁止重定向；`store:false`、`stream:true`、完整 `input` 历史由驱动生成。同步 `create` 在内部消费 SSE，并从 `response.completed` 返回完整输出；未完成、失败或提前 EOF 均抛出 `ChatGPTError`，可检查 `reason`。普通 Responses Provider 的 incomplete 行为保留。

订阅通道省略 `temperature`、`topP`、`maxTokens`、`stop`、`user` 和 `metadata`，不保证这些控制生效；system 内容转成 instructions，函数工具放入固定 `functions` namespace。首版支持文本、`image_url` 输入、函数工具和模型允许的 web search；拒绝音视频、文件内容、托管 MCP、代码执行和图像生成工具。图像生成、TTS 等业务需要其他支持对应操作的连接。

`listChatGPTModels` 使用同一 OAuth 会话读取账号目录，仅保留 `visibility:'list'`，按服务器顺序返回 `slug` 和 `display_name`；目录结果不推断模态、工具权限或定价。原目录接口也可使用 `listProviderModels(provider, { chatgpt, fetch, signal })`。模型是否真正可用仍以该账号实际推理结果为准。

依据 [OpenAI 官方推理文档](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)、[登录与权限](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) 和 [令牌说明](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)。适用范围及接入资格由官方规则决定；库的测试使用模拟 HTTP，不代表真实账号授权验收。

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

Anthropic Messages 的 `thinking: false` 显式发送 disabled；未指定时保留服务端默认，模型默认可通过 connection metadata.thinkingMode 注入，单次请求优先。开启手动思考时默认预算为输出上限的一半（最多 10000），显式预算必须至少 1024 且小于 maxTokens。JSON Schema 映射为 output_config.format；不支持通用 json_object 模式，请选择支持该模式的协议或由提示词约束并在宿主校验 JSON。

Anthropic 用量包含普通输入、缓存读取和缓存创建 token；流式请求合并 message_start 与后续累计 usage，message_stop 不覆盖真实结束原因。SSE 服务端错误明确抛出 LLMError；Responses 的 incomplete 保留 length。

## 消息边界

`ChatCompletionParams`、`ChatMessage`、`MessageContentPart` 和工具通信类型由驱动定义。调用方组装历史与上下文，再映射为这些请求类型；驱动不导入上下文引擎或会话模型。已有消息结构兼容时可直接传入，无需额外的运行时包装。

普通消息、内容分段和工具 schema 可作为 JSON 数据传入。`signal` 和二进制 `attachments` 是可选的本地调用能力，JSON 序列化前必须移除或转换。网络、日志与重试函数通过客户端配置单独注入。


### Media operations

`LLMMediaClient.generate` and `LLMDriver.generateMedia` support `image.generate` and
`speech.synthesize` through explicit OpenAI-compatible media endpoints. Declare both
`provider.media[operation]` (adapter/path) and `model.operations[operation]` (modalities,
formats and voices). Category and audio/vision flags do not imply generation support.
Pure validation is exported from `/contracts`. Optional sizes, qualities, counts,
speeds and instructions must also match the declared capability.

The response contains binary assets; hosts must persist bytes outside durable journals.
Responses are limited to 64 MiB, image URL results require an explicit HTTPS host allowlist, and paid requests are
never automatically retried. Media transport defaults to 120 seconds, configured through
`LLMClientConfig.mediaTimeout` independently of chat. Pass a signal for cancellation.
Legacy image endpoints explicitly opt into `responseFormat: 'b64_json'` and
`outputFormatParameter: false`. Capability declarations are not live paid API probes.

## 媒体协议与模型目录

`LLMMediaClient` 统一提供 `image.generate` 和 `speech.synthesize`。Provider 的 `media` 选择 `openai-images`、`volcengine-images`、`openai-speech` 或 `doubao-speech`；模型的 `operations` 声明具体输入/输出模态、格式、音色与范围。

豆包原生语音端点示例：

```ts
media: {
  'speech.synthesize': {
    adapter: 'doubao-speech',
    path: '/api/v3/tts/unidirectional',
    sampleRate: 24000,
  },
}
```

调用方传入已授权的模型资源 ID、音色及 API Key。适配器生成 X-Api 请求头、映射 req_params，并校验所有 JSON 音频分段；HTTP 或业务错误、取消和空音频均拒绝整个结果，不返回部分音频、不自动重试。支持 MP3、Opus（请求映射为 ogg_opus）和 PCM；语速 0.5–2 映射为原生 speech_rate。诊断使用注入 logger，记录请求身份、厂商 logid、错误码及结果大小，不记录正文和凭据。协议依据[豆包单向流式 HTTP 文档](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)。

目录查询保留明确的 supportsXXX/capabilities、输入输出模态、supported_parameters 和有效 operations；没有能力字段时返回 capabilitiesKnown=false，不根据模型名称补全。modelsPath 优先于从聊天路径派生的目录地址。目录读取不会探测付费生成能力，模型可用性仍需调用方核对权限及具体请求要求。


## Text probes and model reasoning

Provider connection probes require a caller-selected text model. Media verification is a separate explicit operation with a matching request; it uses the production media path and never retries a paid generation. Codex without an explicit model or effort inherits its host settings. Probe results include operation, model, requestId, stage (`validation`, `transport` or `response`), safe error codes and latency. A fetch rejection is `NETWORK_ERROR` at the transport stage without an invented HTTP status; recognized nested DNS/TCP/TLS causes are exposed as `transportCode`. Browser transport errors alone cannot distinguish CORS from network failure. Previews up to 8 MiB use the existing typed byte contract.

Model `reasoning` declares supported effort IDs, optional wire values, default effort, `canDisable`, budget bounds and protocol transport. `reasoningByProtocol` narrows the contract for a gateway protocol; `false` disables reasoning on that route. Unknown declarations remain unknown, while explicit invalid selections fail before transport. The catalog reader accepts explicit `effort.supported_levels/default_level` metadata without guessing from model names. Legacy requests without a declaration retain their previous compatibility behavior.

`createMediaAdapterRegistry().snapshot()` injects additional implementations through `LLMClientConfig.mediaAdapterFactory` or `LLMMediaClientConfig.adapterFactory`. External endpoints declare `operation` and may pin `adapterVersion`; registration is scoped to a runtime and snapshots cannot be changed by later registrations. The host owns authorization, storage and reconciliation.

The `volcengine-images` adapter uses the native image path and requests Base64 explicitly. URL mode is opt-in via `responseFormat: 'url'` and `assetHosts`; downloads use HTTPS, bounded reads, no inference credentials and no redirects. Native and downloaded images check their requested format. Doubao Opus requests use 48 kHz independently of the default MP3/PCM sample rate.
