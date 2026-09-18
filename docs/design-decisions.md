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

`normalizeOpenAIMessages()` 修正非标准 OpenAI 消息：
- assistant content 为 text block 数组而非 string 时，合并为单个字符串
- assistant `tool_calls[].function.arguments` 为对象时序列化为字符串
- assistant `reasoning_content` 重命名为 `reasoning`（见下）

### assistant reasoning 字段名：`reasoning`，不是 `reasoning_content`

上游流式响应里历史轮次的思考以 `reasoning_content` delta 下发，客户端原样回传时也带 `reasoning_content`。但 CodeBuddy 网关**只认 `reasoning`**，`reasoning_content` 会被静默丢弃，导致模型在多轮对话中看不到自己此前的思考。

用抓取到的 CodeBuddy CLI v2.122.0 真实请求体重放到 `copilot.tencent.com/v2` 验证（各 3 次，结果完全一致）：

| 改动 | prompt_tokens |
|------|---------------|
| `reasoning_content` +990 字符 | Δ 0 |
| `reasoning_content` +9900 字符 | Δ 0 |
| `reasoning` +990 字符（带 `tools`） | Δ +220 |
| `reasoning` +9900 字符（带 `tools`） | Δ +2200 |

CLI 自己始终只发 `reasoning`：其内置的 `reasoning-content-backfill` 规则以 `caps.requiresReasoningContentOnAssistantMessages` 为前提，而 CodeBuddy product config 里的模型（如 `deepseek-v4.1-flash`）不声明该能力，所以规则不生效。因此不能指望上游帮我们桥接两个字段名。

`normalize.js` 中的 `normalizeReasoningField()` 据此把 `reasoning_content` 改写成 `reasoning`（已存在 `reasoning` 时以它为准），并丢弃空值。注意这与「内联注入 content」的思路不同：字段改写是无损的，不会改变 prompt 前缀，也不会把整段思考重复计费。

## 请求头伪装

构建与 CLI 一致的请求头：
- Stainless SDK 头（`x-stainless-arch`, `x-stainless-lang`, `x-stainless-os` 等）
- Zipkin B3 追踪头（`X-Trace-ID`, `b3`, `X-B3-TraceId` 等）
- 双认证（`X-API-Key` + `Authorization Bearer`）
- 会话 ID（`X-Conversation-ID`, `X-Conversation-Message-ID` 等）

CLI 版本探测为懒加载（首次请求时执行，不阻塞启动）。

## 模型加载优先级

1. `~/.workbuddy/cache/acc-product-config-v3.json` — WorkBuddy 桌面端缓存的云端 product config（最新最全，glm-5.3 等只在这里），取 craft agent 的 `models` 白名单
2. `~/.codebuddy/local_storage/` 中的云端缓存（按会话分片，支持 base64+gzip 压缩格式，可能过期）
3. CLI 包目录下的 `product.internal.json` / `product.json`
4. `src/builtin-models.json` — 随代码发布的兜底列表
5. 用户自定义 `~/.codebuddy/models.json`（叠加在各来源之上，可覆盖字段）

来源之间取第一个命中的，不合并。模型列表每 60 秒自动刷新一次，空结果有 60 秒退避。

### builtin 兜底列表必须机器生成

`src/builtin-models.json` 是 product config 的原样快照，别手写——手写过一次的字段已经漂移过（hy4-preview 的 `maxOutputTokens` 写成 100000、`supportsImages` 写成 false、description 里的参数量是编的；hy3 缺 `supportedEfforts`、hy3-x 干脆缺失）。

```bash
node scripts/sync-builtin-models.js           # 从桌面端缓存重新生成
node scripts/sync-builtin-models.js --check   # 校验是否同步（不一致时退出码 1）
node scripts/sync-builtin-models.js --diff    # 打印差异模型 id，不写入
```

## 日志管理

- `logs/requests.jsonl` — 请求日志，超 10MB 自动轮转
- `logs/last-request.json` — 最近一次请求体
- `logs/last-response.json` — 最近一次响应摘要
- `logs/requests/` — per-request 调试文件，自动清理（7天 + 1000文件上限）

## 超时与断开处理

- 所有流式请求有 120 秒超时看门狗，超时主动断开连接
- 客户端中途断开也会取消 upstream 读取
