# 关键设计决策

## 强制流式上游

CodeBuddy 后端**只支持流式**。非流式请求由 proxy 聚合上游 SSE chunks 后返回完整 JSON。

## System Prompt 替换

`system-prompt.txt` 存在时，所有请求的 system 消息会被替换为该文件内容。如果请求中没有 system 消息，会自动插入。目的：规避上游内容审核。

## 内容清洗

历史消息中 `role=assistant` 且 `content` 包含"敏感内容"的记录会被自动过滤。

## OpenAI SSE 流空字段清洗

`normalizeSSEData()`（在 `lib/sse.js` 中）在 OpenAI 端点的流式响应中剥离空的 vendor 字段：
- `reasoning_content: ""`
- `content: ""`
- `function_call` 空值
- `tool_calls: []`
- `refusal: ""`
- `extra_fields` 空值
- `finish_reason: ""`

CodeBuddy 上游会在 SSE chunk 中填充这些空字段，下游转换器（如 ccswitch）会将其当作有效数据解析，产生无效的 Anthropic content blocks。清洗后 SSE 流为标准 OpenAI 格式，下游可正确转换。

## OpenAI 非标准消息修正

`normalizeOpenAIMessages()` 修正 ccswitch 等代理工具产生的非标准 OpenAI 消息——assistant content 为 text block 数组而非 string 时，合并为单个字符串。

## Anthropic 端点完整双向转换

Anthropic 端点 (`/v1/messages`) 完成完整的 Anthropic→OpenAI→Anthropic 双向转换，可直接供 Claude Code 使用，无需依赖 ccswitch：

### 请求侧
- thinking 块 → reasoning_content
- image 块 → image_url multimodal
- tool_use → tool_calls
- cache_control 清理（含 tool 角色深拷贝清理）

### 响应侧
- reasoning_content → thinking content block
- tool_calls → tool_use content block
- pseudo-XML tool call 检测解析（仅非流式）
- finish_reason → stop_reason 完整映射

## 请求头伪装

构建与 CodeBuddy CLI 完全一致的请求头，包含：
- Stainless SDK 头（`x-stainless-arch`, `x-stainless-lang`, `x-stainless-os`, 等）
- Zipkin B3 追踪头（`X-Trace-ID`, `b3`, `X-B3-TraceId`, 等）
- 双认证（`X-API-Key` + `Authorization Bearer`）
- 会话 ID（`X-Conversation-ID`, `X-Conversation-Message-ID`, 等）

CLI 版本探测为懒加载（首次请求时执行，不阻塞启动）。

## 模型加载优先级

1. `~/.codebuddy/local_storage/` 中的云端缓存（支持 base64+gzip 压缩格式）
2. CLI 包目录下的 `product.internal.json` / `product.json`
3. 用户自定义 `~/.codebuddy/models.json`

模型列表每 60 秒自动刷新一次。空结果有 60 秒退避，避免频繁重试 IO。

## 日志管理

- `logs/requests.jsonl` — 请求日志，超 10MB 自动轮转
- `logs/last-*.json` — 最近一次请求/响应
- `logs/requests/` — per-request 调试文件，自动清理（7天 + 1000文件上限）

## 超时与断开处理

- 流式请求有 120 秒超时看门狗，超时会主动断开连接
- 客户端中途断开也会取消 upstream 读取
