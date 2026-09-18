# 请求链路详解

项目只有一条端到端请求路径：`POST /v1/chat/completions`（OpenAI 协议），上游固定为 CodeBuddy。

> **历史**：曾存在另外两条链路——OpenAI 非 CodeBuddy provider 纯透传（NVIDIA）与 Anthropic `/v1/messages` 端点，均已删除。`src/routes/anthropic.js`、`src/providers/nvidia.js` 不再存在。

## 请求流

**入口**：`POST /v1/chat/completions` → `handleChatCompletions()` → `handleCodeBuddyRequest()`

```
客户端 body
  │
  ├── model = req.body.model || config.defaultModel
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
        ├── tool_choice 非字符串 → 强制 "auto"
        ├── tools 中的 JSON Schema 清洗（删除 anyOf/const/$schema）
        │
        ├── if (upstreamBody.messages)
        │     ├── normalizeOpenAIMessages(messages)      ← 修正非标准格式 +
        │     │                                             reasoning_content → reasoning
        │     ├── replaceSystemPrompt(messages)          ← 替换/插入 system
        │     └── messages = filterContentMessages(messages)  ← 过滤敏感内容
        │
        ├── 注入 thinking 参数（reasoning_effort，按模型前缀）
        │
        ├── web_search 单工具请求拦截 → 直接调 CodeBuddy search API
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

## 响应流（流式 — 客户端 `stream:true`）

```
upstream SSE stream
  │
  └── pipeCodeBuddyStream()
        │
        ├── 逐行读取 SSE，每行匹配 /^data:\s?(.*)$/
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

## 响应流（非流式 — 客户端 `stream:false`）

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

## 关键代码位置

| 组件 | 文件 |
|------|------|
| 主 handler | `src/routes/openai.js` — `handleCodeBuddyRequest` |
| 流式处理 | `src/routes/openai.js` — `pipeCodeBuddyStream` |
| 非流式聚合 | `src/routes/openai.js` — `aggregateCodeBuddyNonStream` |
| CLI 指纹头 | `src/providers/codebuddy.js` — `buildHeaders()` + `buildCliHeaders()` |
| /v2 路径 | `src/providers/codebuddy.js` — `resolveURL()` |
| SSE 空字段清洗 | `src/lib/sse.js` — `normalizeSSEData()` |
| SSE chunk 聚合 | `src/lib/sse.js` — `aggregateSSEChunks()` |
| prompt 替换 | `src/lib/prompt.js` — `replaceSystemPrompt()` |
| 内容清洗 | `src/lib/prompt.js` — `filterContentMessages()` |
| 消息标准化 | `src/lib/normalize.js` — `normalizeOpenAIMessages()` / `normalizeReasoningField()` |
| 上游调度 | `src/lib/upstream.js` — `fetchUpstream()` |
