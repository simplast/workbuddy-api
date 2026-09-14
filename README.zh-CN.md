# workbuddy-api

[English](./README.md)

本地代理服务，将 OpenAI 兼容客户端（Vercel AI SDK、任意 `POST /v1/chat/completions` 客户端）连接到 CodeBuddy。

## 快速开始

需要 Node.js ≥ 18。

```bash
npm install
cp .env.example .env   # 编辑 .env 填入 CODEBUDDY_API_KEY
npm run dev            # http://127.0.0.1:3456
```

## 端点

| 方法 | 路径 | 说明 |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API |
| `GET` | `/v1/models` | 模型列表（从 WorkBuddy product config 读取，含思考档位） |
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

CodeBuddy 为唯一上游：

| 提供商 | 协议 | 备注 |
|----------|----------|-------|
| **CodeBuddy** | OpenAI `/v2/chat/completions` | CLI 请求头指纹、提示词替换 |

## 环境变量

必须配置 `CODEBUDDY_API_KEY`。

| 变量 | 必填 | 默认值 | 说明 |
|----------|----------|---------|-------------|
| `CODEBUDDY_API_KEY` | 是 | — | 启用 CodeBuddy 提供商 |
| `CODEBUDDY_BASE_URL` | 否 | `https://www.codebuddy.ai` | 也可用 `https://copilot.tencent.com`（内部） |
| `CODEBUDDY_MODELS` | 否 | `default` | 逗号分隔的模型别名列表 |
| `CODEBUDDY_TARGET_MODEL` | 否 | （与别名相同） | 实际上游模型名称 |
| `CODEBUDDY_CLI_VERSION` | 否 | `2.110.0` | 覆盖自动检测的版本号 |
| `DEFAULT_MODEL` | 否 | （无） | 请求未指定模型时的默认值 |
| `PORT` | 否 | `3456` | |
| `HOST` | 否 | `127.0.0.1` | |

## 架构

```
POST /v1/chat/completions
  └─ handleChatCompletions() → handleCodeBuddyRequest()  （完整适配栈）
      ├─ fetchUpstream(body)
      │   ├─ provider.resolveURL()    → /v2/chat/completions
      │   ├─ provider.buildHeaders()  → CLI 指纹请求头
      │   └─ provider.preRequest()    → 模型别名 → 真实名称
      ├─ stream:true  → SSE 字段清洗 + 管道输出给客户端
      └─ stream:false → 聚合 SSE → 单个 JSON 响应
```

- **CodeBuddy 路径**：提示词替换、内容过滤、强制流式、SSE 字段清洗、CLI 指纹请求头

详见 [请求路径](docs/request-paths.md) 和 [设计决策](docs/design-decisions.md)。

## 模型列表

模型列表从 WorkBuddy 桌面端缓存的云端 product config（`~/.workbuddy/cache/acc-product-config-v3.json`，取 craft agent 的模型白名单）加载，每 60 秒刷新一次，无需单独调用 API。该缓存不存在时依次回退到 `~/.codebuddy/local_storage/`、CLI 包内配置，最后是随代码发布的 `src/builtin-models.json`。

内置兜底列表由脚本生成，不要手改——重新生成用 `node scripts/sync-builtin-models.js`，校验是否同步用 `--check`。

## 适配说明

本代理会对请求做以下规范化处理，确保与上游兼容：

- `tool_calls[].function.arguments` 自动从对象转为 JSON 字符串
- `tool_choice` 自动从对象格式转为字符串名称
- `assistant.content` 自动从文本块数组合并为字符串
- `reasoning_content` 保留回传（DeepSeek thinking_mode 规范要求）

## 许可证

MIT
