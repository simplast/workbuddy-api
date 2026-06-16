---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 1eca7343fe74c65971d664cb7d303a44_4815474966e711f1aa625254006c9bbf
    ReservedCode1: uPdmawfAdNNBQxvnPU02slibBzFnASYiHZUF5R/9xjIwqlWtAulrGuyzAdIPeja3omCY+h8WZPKHHzdAh0m7a6Yn0nPwLh/peXi/Xf8Z+kLktAQjATQ9MuuiXQgT6jZxeWH29iIdy92jTfikhHYAfWDMRAMq0hAjTXMOGGJWDWodagfa1+1FKenue/8=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 1eca7343fe74c65971d664cb7d303a44_4815474966e711f1aa625254006c9bbf
    ReservedCode2: uPdmawfAdNNBQxvnPU02slibBzFnASYiHZUF5R/9xjIwqlWtAulrGuyzAdIPeja3omCY+h8WZPKHHzdAh0m7a6Yn0nPwLh/peXi/Xf8Z+kLktAQjATQ9MuuiXQgT6jZxeWH29iIdy92jTfikhHYAfWDMRAMq0hAjTXMOGGJWDWodagfa1+1FKenue/8=
---

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

## 环境变量（必需）

| 变量 | 必填 | 说明 |
|------|------|------|
| `CODEBUDDY_API_KEY` | 是 | CodeBuddy API Key |
| `CODEBUDDY_BASE_URL` | 否 | 默认 `https://www.codebuddy.ai` |
| `PORT` | 否 | 默认 3456 |
| `DEFAULT_MODEL` | 否 | 默认模型 |

**可选 provider（私有上游）:**

```bash
# NVIDIA（OpenAI + 限流）
NVIDIA_API_KEY=...
NVIDIA_MODELS=glm-5.1
NVIDIA_RPM=40

# 路由
DEFAULT_PROVIDER=codebuddy
```

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

- [docs/refactor-workbuddy-api.md](docs/refactor-workbuddy-api.md) — 重构进度与架构设计
- [docs/provider-guide.md](docs/provider-guide.md) — Provider 架构详解与新增指南
- [docs/design-decisions.md](docs/design-decisions.md) — 关键设计决策（SSE 清洗、Anthropic 转换等）

*（内容由AI生成，仅供参考）*
