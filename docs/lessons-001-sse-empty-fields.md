# SSE 流空字段导致下游解析器崩溃

日期: 2026-06-14

## 现象

Claude Code 通过 ccswitch（Anthropic→OpenAI 转换代理）连接 workbuddy-api 的 OpenAI 端点时，LLM 经常"沉默"——不回复、不调用工具，Claude Code 总是收到 `stop_reason=end_turn` 而无 `tool_use` blocks。

## 错误排查路径

看到 `end_turn` 替代了 `tool_use`，加上 ccswitch 自诊说 finish_reason 未做 OpenAI→Anthropic 映射，就认定问题在于 finish_reason 值的映射缺失。于是不断在 OpenAI 端点上加 remap 逻辑（FINISH_REASON_MAP → passthrough → scope 修复 → strip/inject），越修越复杂，始终无效。

## 真正根因

CodeBuddy 上游 SSE 流包含大量**空的 vendor 字段**：

| 字段 | 空值示例 |
|------|----------|
| `delta.reasoning_content` | `""` |
| `delta.content` | `""` |
| `delta.function_call` | `{name:"",arguments:""}` |
| `delta.tool_calls` | `[]` |
| `delta.extra_fields` | `null` |
| `delta.refusal` | `""` |
| `choice.finish_reason` | `""` |

ccswitch 把这些空字段当作有效数据解析，产生了无效的 Anthropic content blocks（空 thinking block、空 text block、提前发出的 message_delta），淹没了真正的 tool_calls 数据。

## 正确修复

`normalizeSSEData()` 只做一件事——剥离这些空/null vendor 字段。SSE 流变干净后，ccswitch 就能正确解析标准 OpenAI 数据了。`finish_reason: "stop"` 和 `"tool_calls"` 本就是 OpenAI 标准值，ccswitch 自己会正确映射到 Anthropic 的 `end_turn` 和 `tool_use`。

## 教训

1. **看症状不等于看病因**。看到 `stop_reason=end_turn` 不等于 finish_reason 映射有问题——可能是别的东西干扰了整个流的解析。推理式诊断需要用数据验证，不能只靠逻辑推导。

2. **先拿到完整原始数据再定位问题**。应该第一时间抓一份完整的 SSE 流原始数据，逐行检查下游到底收到了什么、输出了什么。而不是基于 ccswitch 的自我诊断就假设了 finish_reason 是根因。

3. **在错误前提上叠加补丁只会越走越远**。remap→passthrough→scope修→strip/inject 每一层都在修补一个不存在的假设，方向错了再多的迭代也不可能收敛到正确答案。

4. **简单问题优先**。空字段清洗这种改动只有十几行，却解决了根本问题。finish_reason remap 有几十行还带 scope bug，解决的是一个不存在的问题。优先排查最简单的可能原因。
