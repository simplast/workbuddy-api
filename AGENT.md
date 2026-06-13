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
- **上游**: `https://www.codebuddy.ai/v2/chat/completions`（仅支持流式）
- **默认端口**: 3456

## 目录结构

```
.
├── src/
│   ├── index.js              # 主入口：Express 路由注册
│   ├── config.js             # 环境变量配置（.env）
│   ├── models.js             # 模型列表动态加载（local_storage 缓存 > product config > 用户自定义）
│   ├── test.js               # 本地测试脚本
│   ├── routes/
│   │   ├── openai.js         # POST /v1/chat/completions 处理
│   │   └── anthropic.js      # POST /v1/messages 处理（流式+非流式）
│   ├── lib/
│   │   ├── headers.js        # CLI 请求头伪装
│   │   ├── upstream.js       # 上游请求构造 + NVIDIA 路由
│   │   ├── logger.js         # 请求日志（console + JSONL）
│   │   ├── prompt.js         # System prompt 替换 + 内容过滤
│   │   └── sse.js            # SSE 流解析工具
│   └── convert/
│       └── anthropic.js      # Anthropic ↔ OpenAI 纯格式转换
├── logs/                     # 请求日志（requests.jsonl + last-request.json）
├── system-prompt.txt         # 自定义 system prompt，启动时加载替换上游
├── codebuddy-system-prompt.txt  # CodeBuddy 原始 system prompt 参考
├── package.json
└── .env                      # 环境变量（不提交）
```

## 启动命令

```bash
npm run dev    # 开发，--watch 热重载
npm start      # 生产
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | OpenAI 兼容端点，支持 stream: true/false |
| POST | `/v1/messages` | Anthropic Messages API 兼容端点 |
| GET  | `/v1/models` | 模型列表 |
| GET  | `/health` | 健康检查 |

## 环境变量（.env）

| 变量 | 必填 | 说明 |
|------|------|------|
| `CODEBUDDY_API_KEY` | 是 | CodeBuddy API Key（Bearer token） |
| `CODEBUDDY_BASE_URL` | 否 | 后端地址，默认 `https://www.codebuddy.ai` |
| `PORT` | 否 | 监听端口，默认 3456 |
| `HOST` | 否 | 监听地址，默认 127.0.0.1 |
| `DEFAULT_MODEL` | 否 | 默认模型 |
| `NVIDIA_BASE_URL` | 否 | NVIDIA API 地址 |
| `NVIDIA_API_KEY` | 否 | NVIDIA API Key |
| `NVIDIA_MODELS` | 否 | 需要路由到 NVIDIA 的模型名，逗号分隔 |
| `NVIDIA_TARGET_MODEL` | 否 | NVIDIA 真实模型名 |

## 关键设计决策

### 模块架构

代码按职责拆分为 5 个目录：
- **routes/** — 请求处理（路由级逻辑）
- **lib/** — 可复用工具（headers, upstream, logger, prompt, sse）
- **convert/** — 纯格式转换（无副作用）

`index.js` 仅负责 Express app 初始化和路由注册。

### 强制流式上游

CodeBuddy 后端**只支持流式**。非流式请求由 proxy 聚合上游 SSE chunks 后返回完整 JSON。

### System Prompt 替换

`system-prompt.txt` 存在时，所有请求的 system 消息会被替换为该文件内容。目的：规避上游内容审核。

### 内容清洗

历史消息中 role=assistant 且 content 包含"敏感内容"的记录会被自动过滤。

### 请求头伪装

构建与 CodeBuddy CLI 完全一致的请求头，包含 Stainless SDK 头、Zipkin B3 追踪、双认证（X-API-Key + Authorization Bearer）等，确保不被上游拒绝。

### 模型加载优先级

1. `~/.codebuddy/local_storage/` 中的云端缓存（支持 base64+gzip 压缩格式）
2. CLI 包目录下的 `product.internal.json` / `product.json`
3. 用户自定义 `~/.codebuddy/models.json`

模型列表每 60 秒自动刷新一次。

### NVIDIA 模型路由

`config.nvidia.models` 中配置的模型会路由到 NVIDIA API 而非 CodeBuddy。通过 `lib/upstream.js` 的 `fetchUpstream()` 统一处理，OpenAI 和 Anthropic 两个端点均支持。

## 使用示例

```js
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

const local = createOpenAI({
  baseURL: 'http://127.0.0.1:3456/v1',
  apiKey: 'dummy',  // proxy 已注入真实 token
});

const result = await generateText({
  model: local.chat('default-model-lite'),
  messages: [{ role: 'user', content: 'Hello' }],
});
```

## 注意事项

- `.env` 中的 `CODEBUDDY_API_KEY` 是必须的，启动时若缺失会直接 `process.exit(1)`
- 非流式 Anthropic 请求不会自动展开 `tool_choice: any` 的补全逻辑，仅做格式映射
- 日志目录 `logs/` 不会被自动清理，`requests.jsonl` 会持续增长
- 流式请求有 120 秒超时看门狗，超时会主动断开连接
*（内容由AI生成，仅供参考）*
