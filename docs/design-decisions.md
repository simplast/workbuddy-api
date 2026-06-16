# 关键设计决策

> 核心原则：**路由路径 ≡ 协议**，`/v1/chat/completions` 走 OpenAI 协议，`/v1/messages` 走 Anthropic 协议。provider 层只负责 URL、请求头、模型名映射。具体适配逻辑（prompt 替换、CLI 指纹头等）仅在 CodeBuddy 链路上生效。

## 强制流式上游（CodeBuddy 专属）

CodeBuddy 后端**只支持流式**。当客户端以 CodeBuddy 为上游发起非流式请求时，proxy 会强制在内部以流式请求上游（`stream: true` + `stream_options: { include_usage: true }`），再聚合 SSE chunks 返回完整 JSON。

**其他 provider（如 NVIDIA）**尊重客户端的 `stream` 标志，不强制更改。

## System Prompt 替换（CodeBuddy 专属）

`system-prompt.txt` 存在时，**仅在 CodeBuddy 链路上**替换/插入 system 消息。目的：规避 CodeBuddy 内容审核。

其他 provider 的 system 消息**原封不动**转发给上游。

## 内容清洗（CodeBuddy 专属）

历史消息中 `role=assistant` 且 `content` 包含"敏感内容"的记录会被过滤——同样只在 CodeBuddy 链路上生效。

## OpenAI SSE 流空字段清洗（CodeBuddy 专属）

`normalizeSSEData()`（在 `lib/sse.js` 中）仅在 CodeBuddy 链路的流式响应中剥离空字段：
- `reasoning_content: ""`
- `content: ""`
- `function_call` 空值（`null`/`undefined` 或 name+arguments 均为空字符串）
- `tool_calls: []`
- `refusal: ""`
- `extra_fields: null`/`undefined`（条件为 `== null`，与其他字段的 `=== ""` 不同）
- `finish_reason: ""` → `null`

CodeBuddy 上游会在 SSE chunk 中填充这些空字段，清洗后恢复为标准 OpenAI 格式。

非 CodeBuddy 的 OpenAI 请求**不做任何 SSE 级别的解析或修改**。

## OpenAI 非标准消息修正（CodeBuddy 专属）

`normalizeOpenAIMessages()` 修正非标准 OpenAI 消息——assistant content 为 text block 数组而非 string 时，合并为单个字符串。仅在 CodeBuddy 链路上执行。

## Anthropic 端点：纯透传

Anthropic 端点 (`/v1/messages`) 为**纯字节级透传**：请求 body 原样转发（provider 层仅做模型名映射），上游响应逐字节 pipe 回客户端。

- **不再做** Anthropic↔OpenAI 双向格式转换
- **不再做** pseudo-XML tool call 检测
- **不再做** thinking ↔ reasoning_content 互转

路由路径本身就声明了协议。如果上游 provider 不支持 Anthropic Messages 格式，请求会在上游自然失败，不由 proxy 拦截。

## 请求头伪装（CodeBuddy 专属）

在 CodeBuddy 链路上构建与 CLI 一致的请求头：
- Stainless SDK 头（`x-stainless-arch`, `x-stainless-lang`, `x-stainless-os` 等）
- Zipkin B3 追踪头（`X-Trace-ID`, `b3`, `X-B3-TraceId` 等）
- 双认证（`X-API-Key` + `Authorization Bearer`）
- 会话 ID（`X-Conversation-ID`, `X-Conversation-Message-ID` 等）

CLI 版本探测为懒加载（首次请求时执行，不阻塞启动）。

其他 provider 使用标准协议头（由基类 `buildHeaders()` 注入）。

## 模型加载优先级

1. `~/.codebuddy/local_storage/` 中的云端缓存（支持 base64+gzip 压缩格式）
2. CLI 包目录下的 `product.internal.json` / `product.json`
3. 用户自定义 `~/.codebuddy/models.json`

模型列表每 60 秒自动刷新一次。空结果有 60 秒退避，避免频繁重试 IO。

## 日志管理

- `logs/requests.jsonl` — 请求日志，超 10MB 自动轮转
- `logs/last-request.json` / `logs/last-request-anthropic.json` — 最近一次请求体
- `logs/last-response.json` / `logs/last-response-anthropic.json` — 最近一次响应摘要
- `logs/requests/` — per-request 调试文件，自动清理（7天 + 1000文件上限）

## 超时与断开处理

- 所有流式请求有 120 秒超时看门狗，超时主动断开连接
- 客户端中途断开也会取消 upstream 读取（对所有链路生效）
