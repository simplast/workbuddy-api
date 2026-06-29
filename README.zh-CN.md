# workbuddy-api

[English](./README.md)

本地代理服务,将 OpenAI 兼容客户端(Vercel AI SDK、任意 `POST /v1/chat/completions` 客户端)连接到 CodeBuddy 及其他 AI 提供商,同时支持 Anthropic Messages API 格式。

## 快速开始

需要 Node.js ≥ 18。

```bash
npm install
cp .env.example .env   # 编辑 .env 填入 API Key
npm run dev            # http://127.0.0.1:3456
```

## 端点

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `GET` | `/v1/models` | 模型列表(从 CodeBuddy CLI 缓存读取) |
| `GET` | `/health` | 健康检查 |

## 使用示例

```js
import { createOpenAI } from "@ai-sdk/openai";

const local = createOpenAI({
  baseURL: "http://127.0.0.1:3456/v1",
  apiKey: "dummy", // proxy 已注入真实 token
});

const result = await local.chat("default").generate("Hello");
```

## 提供商

两种提供商类型,各自对应一种协议:

| 提供商 | 协议 | 备注 |
|----------|----------|-------|
| **CodeBuddy** | OpenAI `/v2/chat/completions` | CLI 请求头指纹、提示词替换 |
| **NVIDIA** | OpenAI `/v1/chat/completions` | 令牌桶限流、429 退避 |

新增提供商:在 `src/providers/` 中继承 `OpenAIProvider` 或 `AnthropicProvider` 创建子类。详见 [提供商指南](docs/provider-guide.md)。

## 环境变量

至少配置一个提供商的 API Key。

| 变量 | 必填 | 默认值 | 说明 |
|----------|----------|---------|-------------|
| `CODEBUDDY_API_KEY` | 至少一个 | — | 启用 CodeBuddy 提供商 |
| `NVIDIA_API_KEY` | 至少一个 | — | 启用 NVIDIA 提供商 |
| `CODEBUDDY_BASE_URL` | 否 | `https://www.codebuddy.ai` | 也可用 `https://copilot.tencent.com`(内部) |
| `CODEBUDDY_MODELS` | 否 | `default` | 逗号分隔的模型别名列表 |
| `CODEBUDDY_TARGET_MODEL` | 否 | (与别名相同) | 实际上游模型名称 |
| `CODEBUDDY_CLI_VERSION` | 否 | `2.110.0` | 覆盖自动检测的版本号 |
| `NVIDIA_BASE_URL` | 否 | `https://integrate.api.nvidia.com/v1` | |
| `NVIDIA_MODELS` | 否 | (无) | 逗号分隔的模型别名列表 |
| `NVIDIA_TARGET_MODEL` | 否 | `z-ai/glm-5.1` | |
| `NVIDIA_RPM` | 否 | `40` | 每分钟请求数限制 |
| `NVIDIA_BURST` | 否 | `5` | 令牌桶突发容量 |
| `DEFAULT_PROVIDER` | 否 | 首个已配置的提供商 | 模型未命中时的回退提供商 |
| `DEFAULT_MODEL` | 否 | (无) | 请求未指定模型时的默认值 |
| `PORT` | 否 | `3456` | |
| `HOST` | 否 | `127.0.0.1` | |

## 架构

```
POST /v1/chat/completions
  ├─ handleChatCompletions()
  │   ├─ providerFor(model)  →  选择提供商
  │   ├─ isCodeBuddy?
  │   │   ├─ YES → handleCodeBuddyRequest()  (完整适配栈)
  │   │   └─ NO  → handlePassthroughRequest() (纯透传)
  │   └─ fetchUpstream(body)
  │       ├─ provider.resolveURL()
  │       ├─ provider.buildHeaders()
  │       └─ provider.preRequest()  (模型别名 → 真实名称)
  │
  POST /v1/messages
    └─ handleMessages() → 纯字节级透传
```

- **CodeBuddy 路径**: 提示词替换、内容过滤、强制流式、SSE 字段清洗、CLI 指纹请求头
- **透传路径**: 原始请求体 → 上游 → 原始字节 → 客户端
- **Anthropic 路径**: 协议由路由路径声明,不做格式转换

详见 [请求路径](docs/request-paths.md) 和 [设计决策](docs/design-decisions.md)。

## 模型列表

模型列表从 CodeBuddy CLI 本地缓存 `~/.codebuddy/local_storage/` 加载,每 60 秒刷新一次,无需单独调用 API。

## 适配说明

本代理会对请求做以下规范化处理,确保与上游兼容:

- `tool_calls[].function.arguments` 自动从对象转为 JSON 字符串
- `tool_choice` 自动从对象格式转为字符串名称
- `assistant.content` 自动从文本块数组合并为字符串
- `reasoning_content` 保留回传(DeepSeek thinking_mode 规范要求)

## 许可证

MIT
