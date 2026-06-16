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
│   │   ├── upstream.js       # Provider 调度器：根据 model alias 选 provider 并发起 fetch
│   │   ├── logger.js         # 请求日志（console + JSONL，10MB 自动轮转）
│   │   ├── normalize.js      # OpenAI 非标准消息格式修正（assistant 数组 content → string）
│   │   ├── prompt.js         # System prompt 替换（含插入）+ 内容过滤
│   │   ├── sse.js            # SSE 工具（normalizeSSEData, sseEvent, readSSEStream, aggregateSSEChunks）
│   │   ├── debug.js          # 调试日志管理（requestId, dumpRequest, dumpResponse, logResponseSummary, save*DebugLog）
│   │   └── debug-cleanup.js  # per-request 调试文件自动清理（7天 + 1000文件上限）
│   ├── providers/            # 上游 provider 架构（详见下方"Provider 架构"章节）
│   │   ├── base.js           # Provider 基类 + OpenAIProvider / AnthropicProvider
│   │   ├── codebuddy.js      # CodeBuddy：OpenAI + CLI 请求头伪装
│   │   ├── nvidia.js         # NVIDIA：OpenAI + 令牌桶限流 + 429 指数退避
│   │   └── registry.js       # ProviderRegistry：按 model alias 路由
│   └── convert/
│       ├── anthropic.js          # Anthropic→OpenAI 请求转换（thinking→reasoning、image→image_url、cache_control 清理）
│       └── anthropic-response.js # OpenAI→Anthropic 响应转换（mapStopReason, extractPseudoXMLToolCalls, formatAnthropicContent, buildAnthropicDebugResp）
├── docs/                      # 子文档（踩坑记录等）
├── logs/                     # 请求日志（requests.jsonl 10MB轮转 + last-*.json + requests/ per-request调试文件自动清理）
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
| `NVIDIA_RPM` | 否 | NVIDIA API 速率限制（每分钟请求数），默认 40 |
| `NVIDIA_BURST` | 否 | NVIDIA API 突发请求上限，默认 5 |

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

`system-prompt.txt` 存在时，所有请求的 system 消息会被替换为该文件内容。如果请求中没有 system 消息，会自动插入。目的：规避上游内容审核。

### 内容清洗

历史消息中 role=assistant 且 content 包含"敏感内容"的记录会被自动过滤。

### OpenAI SSE 流空字段清洗

`normalizeSSEData()`（在 `lib/sse.js` 中）在 OpenAI 端点的流式响应中剥离空的 vendor 字段（`reasoning_content: ""`、`content: ""`、`function_call` 空值、`tool_calls: []`、`refusal: ""`、`extra_fields` 空值、`finish_reason: ""`）。CodeBuddy 上游会在 SSE chunk 中填充这些空字段，下游转换器（如 ccswitch）会将其当作有效数据解析，产生无效的 Anthropic content blocks。清洗后 SSE 流为标准 OpenAI 格式，下游可正确转换。

### OpenAI 非标准消息修正

`normalizeOpenAIMessages()` 修正 ccswitch 等代理工具产生的非标准 OpenAI 消息——assistant content 为 text block 数组而非 string 时，合并为单个字符串。

### Anthropic 端点完整双向转换

Anthropic 端点 (`/v1/messages`) 完成完整的 Anthropic→OpenAI→Anthropic 双向转换，可直接供 Claude Code 使用，无需依赖 ccswitch：
- 请求侧：thinking 块→reasoning_content，image 块→image_url multimodal，tool_use→tool_calls，cache_control 清理（含 tool 角色深拷贝清理）
- 响应侧：reasoning_content→thinking content block，tool_calls→tool_use content block，pseudo-XML tool call 检测解析（仅非流式），finish_reason→stop_reason 完整映射

### 请求头伪装

构建与 CodeBuddy CLI 完全一致的请求头，包含 Stainless SDK 头、Zipkin B3 追踪、双认证（X-API-Key + Authorization Bearer）等，确保不被上游拒绝。CLI 版本探测为懒加载（首次请求时执行，不阻塞启动）。

### 模型加载优先级

1. `~/.codebuddy/local_storage/` 中的云端缓存（支持 base64+gzip 压缩格式）
2. CLI 包目录下的 `product.internal.json` / `product.json`
3. 用户自定义 `~/.codebuddy/models.json`

模型列表每 60 秒自动刷新一次。空结果有 60 秒退避，避免频繁重试 IO。

## Provider 架构

项目以**两条基准协议路线**（OpenAI Chat Completions、Anthropic Messages）为骨架。所有上游 provider 必须基于其中一条协议，不能发明第三种线缆格式。私有 provider（如 CodeBuddy、NVIDIA）通过**装饰器模式**叠加在基类上：

```
Provider (基类，protocol: 'openai' | 'anthropic')
  ├── resolveURL()                    # 标准端点 URL
  ├── buildHeaders(body) → headers    # 标准协议头（Authorization）
  ├── resolveModel(alias) → real      # 模型名映射
  ├── preRequest(body) → body         # 同步：body 改写
  ├── preRequestAsync(body)           # 异步：限流等待
  └── on429() / onSuccess()           # 状态反馈

OpenAIProvider     extends Provider  (协议头: Bearer)
AnthropicProvider  extends Provider  (协议头: Bearer; URL: /v1/messages)

CodeBuddyProvider  extends OpenAIProvider   # + CLI 请求头伪装（Stainless SDK / B3 trace / X-Conversation-* 等）
NvidiaProvider     extends OpenAIProvider   # + 令牌桶限流（40 RPM / burst 5）+ 429 指数退避
```

### 新增私有 provider

1. 在 `src/providers/<name>.js` 创建子类，继承 `OpenAIProvider` 或 `AnthropicProvider`
2. 覆盖需要的钩子：`buildHeaders()` / `preRequest()` / `preRequestAsync()` / `on429()`
3. 在 `src/config.js` 中按 `process.env.<NAME>_API_KEY` 条件实例化并 push 到 `providers` 数组

`ProviderRegistry.resolveForModel(model)` 按 model alias 顺序匹配；未命中时回退到 `DEFAULT_PROVIDER`。

### Provider 配置（环境变量）

```
# 启用 codebuddy（OpenAI + CLI 头）
CODEBUDDY_API_KEY=...
CODEBUDDY_MODELS=default-model,glm-5.1     # 模型 alias 列表（客户端调用时使用的名字）
CODEBUDDY_TARGET_MODEL=actual-model        # 可选：所有 alias 映射到同一个上游模型

# 启用 nvidia（OpenAI + 限流）
NVIDIA_API_KEY=...
NVIDIA_MODELS=glm-5.1
NVIDIA_TARGET_MODEL=z-ai/glm-5.1           # 简写 alias 时使用的默认上游模型
NVIDIA_RPM=40
NVIDIA_BURST=5

# 路由
DEFAULT_PROVIDER=codebuddy
```

### 关键不变量

- `Provider.protocol` 只能是 `'openai'` 或 `'anthropic'`（基类构造时强制校验）
- 私有 provider **不重写** `resolveURL` 改变线缆协议（CodeBuddy 例外：路径从 `/v1` 改为 `/v2/chat/completions` 但仍是 Chat Completions 协议）
- 路由层（`routes/openai.js`、`routes/anthropic.js`）只与协议打交道，**不感知**私有 provider 的存在
- 限流、头部伪装等副作用全部在 provider 内部，对调用方透明

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
- 日志目录 `logs/`：`requests.jsonl` 超 10MB 自动轮转；`logs/requests/` 下 per-request 调试文件自动清理（7天 + 1000文件上限）
- 流式请求有 120 秒超时看门狗，超时会主动断开连接；客户端中途断开也会取消 upstream 读取
## 踩坑记录

详见 [docs/lessons-001-sse-empty-fields.md](docs/lessons-001-sse-empty-fields.md) — SSE 流空字段导致下游解析器崩溃

*（内容由AI生成，仅供参考）*
