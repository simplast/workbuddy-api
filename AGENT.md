# AGENT.md — workbuddy-api

## 项目定位

CodeBuddy 本地 API 代理服务。将 Vercel AI SDK / 任意 OpenAI 兼容客户端连接到 CodeBuddy 后端，同时支持 Anthropic Messages API 格式。

## 技术栈

- **运行时**: Node.js (ESM)
- **框架**: Express 5.x
- **依赖**: express, dotenv
- **默认端口**: 3456

## 目录结构

```
src/
├── index.js              # Express 路由注册
├── config.js             # 环境变量配置
├── routes/
│   ├── openai.js         # POST /v1/chat/completions
│   └── anthropic.js      # POST /v1/messages
├── lib/                  # 工具：upstream, logger, normalize, prompt, sse, debug
├── providers/            # 上游 provider：base, codebuddy, nvidia, registry
└── convert/              # 格式转换：anthropic, anthropic-response
```

## 启动命令

```bash
npm run dev    # 开发，--watch 热重载
npm start      # 生产
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | OpenAI 兼容，支持 stream |
| POST | `/v1/messages` | Anthropic Messages API |
| GET  | `/v1/models` | 模型列表 |
| GET  | `/health` | 健康检查 |

## 环境变量

至少需要配置一个 provider 的 API Key（`CODEBUDDY_API_KEY` 或 `NVIDIA_API_KEY`），否则服务启动时会报错退出。

| 变量 | 必填 | 说明 |
|------|------|------|
| `CODEBUDDY_API_KEY` | 至少一个 | CodeBuddy API Key（启用 CodeBuddy provider） |
| `NVIDIA_API_KEY` | 至少一个 | NVIDIA API Key（启用 NVIDIA provider） |
| `CODEBUDDY_BASE_URL` | 否 | 默认 `https://www.codebuddy.ai` |
| `CODEBUDDY_MODELS` | 否 | 逗号分隔的模型别名，默认 `default-model` |
| `CODEBUDDY_TARGET_MODEL` | 否 | 实际上游模型名（别名未设映射时默认原样传递） |
| `NVIDIA_BASE_URL` | 否 | 默认 `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_MODELS` | 否 | 逗号分隔的模型别名 |
| `NVIDIA_TARGET_MODEL` | 否 | 实际上游模型名，默认 `z-ai/glm-5.1` |
| `NVIDIA_RPM` | 否 | 每分钟请求限制，默认 `40` |
| `NVIDIA_BURST` | 否 | 令牌桶突发容量，默认 `5` |
| `DEFAULT_PROVIDER` | 否 | 未命中模型时的回退 provider，默认优先 codebuddy |
| `DEFAULT_MODEL` | 否 | 默认模型 |
| `PORT` | 否 | 默认 3456 |
| `HOST` | 否 | 默认 127.0.0.1 |

## Provider 架构

两条基准协议路线：`openai` 和 `anthropic`。私有 provider（CodeBuddy、NVIDIA）是"补丁"——在协议之上叠加自定义头、模型别名、限流。

**新增私有 provider：**
1. 创建 `src/providers/<name>.js` 子类，继承 `OpenAIProvider` 或 `AnthropicProvider`
2. 覆盖钩子：`buildHeaders()` / `preRequest()` / `preRequestAsync()` / `on429()`
3. 在 `src/config.js` 中按 `process.env.<NAME>_API_KEY` 条件实例化

## 使用示例

```js
import { createOpenAI } from '@ai-sdk/openai';

const local = createOpenAI({
  baseURL: 'http://127.0.0.1:3456/v1',
  apiKey: 'dummy',  // proxy 已注入真实 token
});

const result = await local.chat('default-model-lite').generate('Hello');
```

## 更多文档

- [docs/codebuddy-thinking-analysis.md](docs/codebuddy-thinking-analysis.md) — CodeBuddy thinking/reasoning 机制逆向分析（`reasoning_effort` vs `thinking` 参数格式）
- [docs/design-decisions.md](docs/design-decisions.md) — 关键设计决策（SSE 清洗、Anthropic 转换等）
- [docs/request-paths.md](docs/request-paths.md) — 3 条请求链路详解
- [docs/provider-guide.md](docs/provider-guide.md) — Provider 架构详解与新增指南

*（内容由AI生成，仅供参考）*
