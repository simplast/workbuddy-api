# 关键设计决策

> 核心原则：**唯一链路** — `POST /v1/chat/completions` 固定走 CodeBuddy OpenAI 协议适配栈。所有适配逻辑（prompt 替换、CLI 指纹头等）都在这一条链路上生效。
>
> **历史**：曾支持 NVIDIA 直连透传与 Anthropic `/v1/messages` 端点，均已删除。

## 强制流式上游

CodeBuddy 后端**只支持流式**。当客户端发起非流式请求时，proxy 会强制在内部以流式请求上游（`stream: true` + `stream_options: { include_usage: true }`），再聚合 SSE chunks 返回完整 JSON。

## System Prompt 替换

`system-prompt.txt` 存在时替换/插入 system 消息。目的：规避 CodeBuddy 内容审核。

## 内容清洗

历史消息中 `role=assistant` 且 `content` 包含"敏感内容"的记录会被过滤。

## OpenAI SSE 流空字段清洗

`normalizeSSEData()`（在 `lib/sse.js` 中）在流式响应中剥离空字段：
- `reasoning_content: ""`
- `content: ""`
- `function_call` 空值（`null`/`undefined` 或 name+arguments 均为空字符串）
- `tool_calls: []`
- `refusal: ""`
- `extra_fields: null`/`undefined`（条件为 `== null`）
- `finish_reason: ""` → `null`

CodeBuddy 上游会在 SSE chunk 中填充这些空字段，清洗后恢复为标准 OpenAI 格式。

## OpenAI 非标准消息修正

`normalizeOpenAIMessages()` 修正非标准 OpenAI 消息——assistant content 为 text block 数组而非 string 时，合并为单个字符串。

## 请求头伪装

构建与 CLI 一致的请求头：
- Stainless SDK 头（`x-stainless-arch`, `x-stainless-lang`, `x-stainless-os` 等）
- Zipkin B3 追踪头（`X-Trace-ID`, `b3`, `X-B3-TraceId` 等）
- 双认证（`X-API-Key` + `Authorization Bearer`）
- 会话 ID（`X-Conversation-ID`, `X-Conversation-Message-ID` 等）

CLI 版本探测为懒加载（首次请求时执行，不阻塞启动）。

## 模型加载优先级

1. `~/.codebuddy/local_storage/` 中的云端缓存（支持 base64+gzip 压缩格式）
2. CLI 包目录下的 `product.internal.json` / `product.json`
3. 用户自定义 `~/.codebuddy/models.json`

模型列表每 60 秒自动刷新一次。空结果有 60 秒退避，避免频繁重试 IO。

## 日志管理

- `logs/requests.jsonl` — 请求日志，超 10MB 自动轮转
- `logs/last-request.json` — 最近一次请求体
- `logs/last-response.json` — 最近一次响应摘要
- `logs/requests/` — per-request 调试文件，自动清理（7天 + 1000文件上限）

## 超时与断开处理

- 所有流式请求有 120 秒超时看门狗，超时主动断开连接
- 客户端中途断开也会取消 upstream 读取
