# AGENT.md — workbuddy-api

## 项目定位

CodeBuddy 本地 API 代理服务。将 Vercel AI SDK / 任意 OpenAI 兼容客户端连接到 CodeBuddy 后端。

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
│   └── openai.js         # POST /v1/chat/completions
├── lib/                  # 工具：upstream, logger, normalize, prompt, sse, debug
└── providers/            # 上游 provider：base, codebuddy, registry
```

## 启动命令

```bash
npm run dev    # 开发，--watch 热重载
npm start      # 生产
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | OpenAI 兼容，支持 stream，思考档位原样透传 |
| GET  | `/v1/models` | 模型列表（含 supported_efforts / default_effort 档位口径） |
| GET  | `/v1/models/pi-catalog` | Pi 可直接使用的 provider 配置片段（`?provider=name`） |
| GET  | `/health` | 健康检查 |

## 环境变量

必须配置 `CODEBUDDY_API_KEY`，否则服务启动时会报错退出。

| 变量 | 必填 | 说明 |
|------|------|------|
| `CODEBUDDY_API_KEY` | 是 | CodeBuddy API Key |
| `CODEBUDDY_BASE_URL` | 否 | 默认 `https://www.codebuddy.ai` |
| `CODEBUDDY_MODELS` | 否 | 逗号分隔的模型别名，默认 `default-model` |
| `CODEBUDDY_TARGET_MODEL` | 否 | 实际上游模型名（别名未设映射时默认原样传递） |
| `DEFAULT_MODEL` | 否 | 默认模型 |
| `PORT` | 否 | 默认 3456 |
| `HOST` | 否 | 默认 127.0.0.1 |

## Provider 架构

唯一上游为 CodeBuddy（OpenAI 协议）——`provider` 基类 + CLI 指纹头（`buildCliHeaders()`）叠加在标准请求之上。

**CodeBuddy provider 要点：**
1. `src/providers/codebuddy.js` 继承 `OpenAIProvider`，重写 `resolveURL()`（/v2 路径）与 `buildHeaders()`（CLI 指纹头）
2. 在 `src/config.js` 中按 `CODEBUDDY_API_KEY` 条件实例化

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
- [docs/design-decisions.md](docs/design-decisions.md) — 关键设计决策（SSE 清洗、prompt 替换等）
- [docs/request-paths.md](docs/request-paths.md) — 请求链路详解
- [docs/provider-guide.md](docs/provider-guide.md) — Provider 架构详解

*（内容由AI生成，仅供参考）*
