# CodeBuddy Thinking 机制分析

> 基于 CodeBuddy CLI v2.110.0 源码逆向分析。分析日期：2026-06-26。

## 概述

本文档记录了对 CodeBuddy CLI 和 CodeBuddy 后端（`copilot.tencent.com`）thinking/reasoning 机制的逆向分析结果。核心发现：**应使用 `reasoning_effort` 而非 `thinking: { type: "enabled" }` 来启用 thinking**。

## 关键架构

### 两层转换

CodeBuddy 的 thinking 参数经过两层转换：

```
CLI 客户端                    CodeBuddy 后端                 实际模型 API
──────────────────────────────────────────────────────────────────────────
modelSettings.reasoning   →   ThinkingFormatTranslatorRule   →  provider-native
  .effort = "high"             reasoning_effort → format          格式
  .summary = "auto"                                               
                                                             DeepSeek:
CLI 发出:                     后端转换:                       thinking: {type:"enabled"}
reasoning_effort: "high"                                      Z.AI/Qwen:
                                                              enable_thinking: true
```

### 为什么不能直接传 `thinking: { type: "enabled" }`

CodeBuddy 后端（`copilot.tencent.com/v2/chat/completions`）内部有自己的 `ThinkingFormatTranslatorRule`，它的输入是 `reasoning_effort`（OpenAI 标准字段），输出是各 provider 的原生格式。

如果直接传 `thinking: { type: "enabled" }`，后端不会将其识别为 thinking 启用信号，因为它期望的是 `reasoning_effort`。实测结果：
- ❌ `thinking: { type: "enabled" }` → `reasoning_tokens: 0`
- ✅ `reasoning_effort: "high"` → `reasoning_tokens: 84`

## CLI 源码分析

### 1. 模型配置（product.internal.json）

```json
{
  "id": "deepseek-v4-pro",
  "supportsReasoning": true,
  "onlyReasoning": true,
  "reasoning": {
    "effort": "high",
    "summary": "auto"
  }
}
```

- `onlyReasoning: true` — 该模型始终以 reasoning 模式运行
- `reasoning.summary: "auto"` — DeepSeek 自动摘要 thinking 内容（不返回原始 reasoning_content，但会返回摘要后的内容）

### 2. ModelConfigAgentRunInterceptor

CLI 启动时通过此拦截器设置 thinking 配置：

```javascript
// 来源：dist/codebuddy.js
async configureThinkingSettings(eA, el, ec) {
  // ...
  let eC = (em ?? ed ?? !1) || !!ef;  // thinkingEnabled || alwaysThinkingEnabled || maxThinkingTokens
  eC && (
    eA.modelSettings.reasoning.summary = "auto",
    eA.modelSettings.text.verbosity = "high"
  );
  // effort 来自 settings、环境变量或模型默认配置
  eA.modelSettings.reasoning.effort = toSdkEffort(effort);
}
```

### 3. SDK 请求构建

OpenAI Agents SDK 将 `modelSettings` 转为 API 请求体：

```javascript
// 来源：dist/codebuddy.js
let eh = eA.modelSettings.providerData ?? {};
eA.modelSettings.reasoning && eA.modelSettings.reasoning.effort
  && (eh.reasoning_effort = eA.modelSettings.reasoning.effort);
// 注意：summary 不会进入 providerData！

let ef = {
  model: this.#Au,
  messages: eg,
  // ...
  ...eh  // providerData 展开到请求体
};
```

**关键点**：
- `effort` → 映射为 `reasoning_effort`（放入请求体顶层）
- `summary` → 不传给 API（仅在 CLI 内部使用，用于解析响应时决定如何展示 thinking）

### 4. ThinkingFormatTranslatorRule（后端）

CodeBuddy 后端收到请求后执行此规则：

```javascript
// 来源：dist/codebuddy.js
class ThinkingFormatTranslatorRule {
  apply(eA, el) {
    let eu = el.caps?.thinkingFormat;  // 模型配置中的 thinkingFormat
    let ed = eA.reasoning_effort;      // 从请求体中读取

    switch (eu) {
      case "deepseek":
        eA.thinking = { type: "enabled" };
        delete eA.reasoning_effort;
        break;
      case "zai":
      case "qwen":
        eA.enable_thinking = true;
        delete eA.reasoning_effort;
        break;
      case "openrouter":
        eA.reasoning = { effort: ed };
        delete eA.reasoning_effort;
        break;
      // ...
    }
  }
}
```

### 5. thinkingLevelMap（effort 值映射）

DeepSeek 模型配置中的 effort 映射：

```json
{
  "thinkingLevelMap": {
    "minimal": null,
    "low": null,
    "medium": null,
    "high": "high",
    "xhigh": "max"
  }
}
```

- `minimal`/`low`/`medium` → `null`（DeepSeek 不支持，跳过）
- `high` → `"high"`（保持不变）
- `xhigh` → `"max"`（DeepSeek 最大值）

## 各 Provider 的 thinkingFormat

| Provider | thinkingFormat | 转换结果 |
|----------|---------------|---------|
| DeepSeek | `"deepseek"` | `thinking: { type: "enabled" }` |
| Z.AI / Qwen | `"zai"` / `"qwen"` | `enable_thinking: true` |
| OpenRouter | `"openrouter"` | `reasoning: { effort: "high" }` |
| Together | `"together"` | `reasoning: { enabled: true }` |
| Qwen (chat template) | `"qwen-chat-template"` | `chat_template_kwargs: { enable_thinking: true }` |

## 实际请求示例

### CLI 实际发出的请求

```json
{
  "model": "deepseek-v4-flash",
  "messages": [...],
  "stream": true,
  "stream_options": { "include_usage": true },
  "reasoning_effort": "high"
}
```

### 经过代理的正确请求

```json
{
  "model": "deepseek-v4-pro",
  "messages": [...],
  "stream": true,
  "stream_options": { "include_usage": true },
  "reasoning_effort": "high"
}
```

### 响应中的 reasoning

```json
{
  "choices": [{
    "delta": {
      "content": "2",
      "reasoning_content": "OK, the user just asked...",
    }
  }],
  "usage": {
    "completion_tokens_details": {
      "reasoning_tokens": 84
    }
  }
}
```

## 相关代码位置

| 组件 | 文件 | 说明 |
|------|------|------|
| Thinking 参数注入 | `src/routes/openai.js` | `injectThinkingParams()` |
| CodeBuddy provider | `src/providers/codebuddy.js` | CLI 指纹头、/v2 端点 |
| SSE 空字段清洗 | `src/lib/sse.js` | `normalizeSSEData()` — 过滤空 reasoning_content |

## 参考

- CodeBuddy CLI 源码包（`dist/codebuddy.js` 中的 thinking 处理逻辑）
- 模型配置缓存：`~/.codebuddy/local_storage/`
- CLI 日志：`~/.codebuddy/logs/`（如有）
- CLI traces：`~/.codebuddy/traces/`（如有）
