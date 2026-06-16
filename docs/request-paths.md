# 3 条请求链路详解

项目共有 3 条端到端请求路径。两条在 `/v1/chat/completions`（OpenAI 协议，按 provider 分流），一条在 `/v1/messages`（Anthropic 协议，纯透传）。

## 链路一览

| # | 入口路径 | 目标 provider | 处理模式 | 代表实现 |
|---|---------|--------------|---------|---------|
| 1 | `/v1/chat/completions` | 非 CodeBuddy（如 NVIDIA） | **纯透传** | `handlePassthroughRequest` |
| 2 | `/v1/chat/completions` | CodeBuddy | **完整适配栈** | `handleCodeBuddyRequest` |
| 3 | `/v1/messages` | 任意 | **纯透传** | `handleMessages` |

---

## 链路 1：OpenAI + 非 CodeBuddy Provider（纯透传）

**入口**：`POST /v1/chat/completions` → `handleChatCompletions()` → `handlePassthroughRequest()`

**适用场景**：NVIDIA 等标准 OpenAI 兼容 provider。

### 请求流

```
客户端 body           ── 完全原样──▶
  │
  ▼
handleChatCompletions(req, res)
  │
  ├── model = req.body.model || config.defaultModel
  ├── provider = providerFor(model)      ← 选 provider（如 NVIDIA）
  │                                        provider.protocol === 'openai'
  │
  └── handlePassthroughRequest()
        │
        ├── body = { ...req.body, model }   ← 仅确保 model 字段存在
        │                                    其他字段（stream、temperature、
        │                                    messages、tools）完全不变
        │
        └── fetchUpstream(body)             ← provider 层：
                                              ├─ preRequestAsync()  （如获取限流令牌）
                                              ├─ preRequest()       （模型名 alias 映射）
                                              ├─ resolveURL()       （如 https://integrate.api.nvidia.com/v1/chat/completions）
                                              └─ buildHeaders()     （Authorization: Bearer）
```

### 响应流

```
upstream Response (ReadableStream)
  │
  ├── 若 ok == false → 按原始 HTTP 状态和响应文本直接返回给客户端
  │                    return res.status(upstream.status).send(errText)
  │
  └── 若 ok == true → 逐字节 pipe 给客户端
         │
         ├── 流式（客户端 stream:true）→ Content-Type: text/event-stream
         ├── 非流式（客户端 stream:false）→ Content-Type: application/json
         │
         ├── 120 秒无数据超时 → 取消 reader
         ├── 客户端断开 → upstream.body.cancel()
         │
         └── res.write(value) → 每个 chunk 原样写出
               不解析 JSON
               不修改字段
               不做 SSE 归一化
```

### 关键代码位置

| 组件 | 文件 | 行号 |
|------|------|------|
| 分流判断 | `src/routes/openai.js` | 第 20-31 行 |
| 纯透传实现 | `src/routes/openai.js` | `handlePassthroughRequest` |
| provider 选择 | `src/lib/upstream.js` | `providerFor()` |
| 上游调度 | `src/lib/upstream.js` | `fetchUpstream()` |

### 受影响的行为点

- **不做** `normalizeOpenAIMessages()` — assistant content 若为数组，保持原样
- **不做** `replaceSystemPrompt()` — system 消息原样传递
- **不做** `filterContentMessages()` — "敏感内容"消息不被过滤
- **不强制** `stream: true` — 尊重客户端的 stream 标志
- **不调用** `normalizeSSEData()` — SSE 字段（包括空字段）原样透传
- **不做** SSE→JSON 聚合 — 非流式请求由上游自行返回完整 JSON

---

## 链路 2：OpenAI + CodeBuddy Provider（完整适配栈）

**入口**：`POST /v1/chat/completions` → `handleChatCompletions()` → `handleCodeBuddyRequest()`

**适用场景**：CodeBuddy 后端。需要 CLI 指纹头、prompt 绕过内容审核、SSE 空字段清洗。

### 请求流

```
客户端 body
  │
  ├── model = req.body.model || config.defaultModel
  ├── provider = providerFor(model)      ← 返回 CodeBuddyProvider
  │                                        provider.name === 'codebuddy'
  │
  └── handleCodeBuddyRequest()
        │
        ├── upstreamBody = {
        │     ...req.body,
        │     model,
        │     stream: true,                        ← 强制流式
        │     stream_options: { include_usage: true }   ← 强制 usage
        │   }
        │
        ├── if (upstreamBody.messages)
        │     ├── normalizeOpenAIMessages(messages)      ← 修正非标准格式
        │     ├── replaceSystemPrompt(messages)          ← 替换/插入 system
        │     └── messages = filterContentMessages(messages)  ← 过滤敏感内容
        │
        └── fetchUpstream(upstreamBody)
              │
              ├── CodeBuddyProvider.resolveURL()
              │     → https://<base>/v2/chat/completions   ← 路径不同
              │
              └── CodeBuddyProvider.buildHeaders()
                    ├─ Stainless SDK 头
                    ├─ Zipkin B3 追踪头
                    ├─ 双认证（X-API-Key + Authorization）
                    └─ 会话 ID（X-Conversation-*）
```

### 响应流（流式 — 客户端 `stream:true`）

```
upstream SSE stream
  │
  └── pipeCodeBuddyStream()
        │
        ├── 逐行读取 SSE
        │     每行匹配 /^data:\s?(.*)$/
        │
        ├── dataStr === '[DONE]' → 写入 [DONE] 标志
        │
        ├── dataStr !== '[DONE]' → normalizeSSEData(dataStr)
        │                            ├─ 删除 reasoning_content: ""
        │                            ├─ 删除 content: ""
        │                            ├─ 删除空 function_call
        │                            ├─ 删除 tool_calls: []
        │                            ├─ 删除 refusal: ""
        │                            ├─ 删除 extra_fields: null
        │                            └─ finish_reason: "" → null
        │
        ├── 120 秒看门狗超时
        ├── 客户端断开 → reader.cancel()
        │
        ├── 流结束但 [DONE] 未发送且未中断 → 补发 [DONE]
        │
        └── 调试聚合：fullContent / fullReasoning / toolCalls 等
              仅用于日志，不影响响应
```

### 响应流（非流式 — 客户端 `stream:false`）

```
upstream SSE stream
  │
  └── aggregateCodeBuddyNonStream()
        │
        ├── readSSEStream(reader, callback)   ← 读取所有 chunks
        │
        ├── aggregateSSEChunks.handleChunk()  ← 聚合每个 chunk：
        │                                        ├─ 累加 delta.content → fullContent
        │                                        ├─ 累加 delta.reasoning_content → fullReasoning
        │                                        └─ 聚合 delta.tool_calls → toolCalls[]
        │
        ├── 构造标准 OpenAI 响应：
        │     {
        │       id, object: 'chat.completion', created, model,
        │       choices: [{ index:0, message:{...}, finish_reason }],
        │       usage: { prompt_tokens, completion_tokens, total_tokens }
        │     }
        │     message 里会注入 reasoning_content 和 tool_calls
        │
        └── res.json(...) → 返回完整 JSON 给客户端
```

### 关键代码位置

| 组件 | 文件 | 行号 |
|------|------|------|
| 分流判断 | `src/routes/openai.js` | 第 20-31 行 |
| CodeBuddy handler | `src/routes/openai.js` | `handleCodeBuddyRequest` |
| 流式处理 | `src/routes/openai.js` | `pipeCodeBuddyStream` |
| 非流式聚合 | `src/routes/openai.js` | `aggregateCodeBuddyNonStream` |
| CLI 指纹头 | `src/providers/codebuddy.js` | `buildHeaders()` + `buildCliHeaders()` |
| /v2 路径 | `src/providers/codebuddy.js` | `resolveURL()` |
| SSE 空字段清洗 | `src/lib/sse.js` | `normalizeSSEData()` |
| SSE chunk 聚合 | `src/lib/sse.js` | `aggregateSSEChunks()` |
| prompt 替换 | `src/lib/prompt.js` | `replaceSystemPrompt()` |
| 内容清洗 | `src/lib/prompt.js` | `filterContentMessages()` |
| 消息标准化 | `src/lib/normalize.js` | `normalizeOpenAIMessages()` |

---

## 链路 3：Anthropic 端点（纯透传）

**入口**：`POST /v1/messages` → `handleMessages()`

**适用场景**：所有发送到 Anthropic Messages API 的请求。上游 provider 必须实现 Anthropic 协议（`protocol: 'anthropic'`）。

### 请求流

```
客户端 Anthropic 格式 body
  │
  ├── model = body.model || config.defaultModel
  │
  ├── fetchUpstream({ ...body, model })
  │     │
  │     ├── providerFor(model) 选择 provider
  │     │     → provider.resolveURL() 返回 https://<base>/v1/messages
  │     │
  │     ├── provider.preRequest({ ...body, model })
  │     │     → 仅做模型名 alias → 真实名映射
  │     │
  │     └── provider.buildHeaders()
  │           → Authorization: Bearer <api-key>
  │
  └── 发送请求，body 为原始 Anthropic 格式（含 system、thinking、tool_use 等块）
        不做 Anthropic↔OpenAI 转换
```

### 响应流

```
upstream Response (ReadableStream)
  │
  ├── ok == false → 原始状态码 + 原始文本透传给客户端
  │
  └── ok == true → 逐字节 pipe 给客户端
        │
        ├── 流式 → Content-Type: text/event-stream
        ├── 非流式 → Content-Type: application/json
        │
        ├── 120 秒看门狗超时
        ├── 客户端断开 → upstream.body.cancel()
        │
        └── 不做任何字段转换（不再做 OpenAI delta → Anthropic block 的转换）
              不再检测 pseudo-XML tool call
              不再做 thinking ↔ reasoning_content 互转
              不再做 finish_reason ↔ stop_reason 映射
```

### 关键代码位置

| 组件 | 文件 | 行号 |
|------|------|------|
| 主 handler | `src/routes/anthropic.js` | `handleMessages` |
| provider 选择 | `src/lib/upstream.js` | `providerFor()`（内部被 `fetchUpstream` 调用） |
| 上游调度 | `src/lib/upstream.js` | `fetchUpstream()` |

> **历史**：原实现中 `/v1/messages` 走完整 Anthropic↔OpenAI 双向转换（请求侧把 thinking/image/tool_use 块转为 OpenAI reasoning_content/image_url/tool_calls；响应侧把 OpenAI delta 转为 Anthropic content blocks）。该方案用于让 CodeBuddy 后端为 Claude Code 客户端提供服务，但随着架构简化，该路径改为纯透传。转换代码的残留文件（`src/convert/anthropic.js`、`src/convert/anthropic-response.js`）不再被路由层引用。

---

## 3 条链路对比总表

| 维度 | 链路 1<br>OpenAI + 非 CodeBuddy | 链路 2<br>OpenAI + CodeBuddy | 链路 3<br>Anthropic |
|------|-------------------------------|-----------------------------|-------------------|
| 入口路径 | `/v1/chat/completions` | `/v1/chat/completions` | `/v1/messages` |
| 分流条件 | `provider.name !== 'codebuddy'` | `provider.name === 'codebuddy'` | 路径本身 |
| 协议 | OpenAI Chat Completions | OpenAI Chat Completions | Anthropic Messages |
| 请求 body 修改 | 仅模型名映射 | prompt 替换 + 内容清洗 + 强制 stream | 仅模型名映射 |
| 响应修改 | 无（字节级透传） | SSE 空字段清洗；非流式聚合为 JSON | 无（字节级透传） |
| 请求头 | 基础 Authorization | CLI 指纹 + 双认证 + 追踪头 | 基础 Authorization |
| 超时/断开 | 120 秒看门狗；断开传播 | 120 秒看门狗；断开传播 | 120 秒看门狗；断开传播 |
| 代表 provider | NVIDIA、其他标准 OpenAI 兼容服务 | CodeBuddy | 原生 Anthropic 兼容服务 |
