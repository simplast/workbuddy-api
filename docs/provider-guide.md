# Provider 架构详解

## 架构设计

项目只有一个上游 provider：**CodeBuddy**，走 OpenAI Chat Completions 协议（实际端点 `/v2/chat/completions`）。

```
Provider (基类)
  ├── resolveURL()                    # 标准端点 URL
  ├── buildHeaders(body) → headers    # 协议头（Authorization）
  ├── resolveModel(alias) → real      # 模型名映射
  ├── preRequest(body) → body         # 同步：body 改写
  ├── preRequestAsync(body)           # 异步：限流等待
  ├── postResponse(response)          # 观察响应状态
  └── on429() / onSuccess()           # 状态反馈

OpenAIProvider  extends Provider  (协议头: Bearer; URL: /v1/chat/completions)

CodeBuddyProvider extends OpenAIProvider   # + CLI 请求头伪装 + /v2 路径
```

> **历史**：曾支持 NVIDIA provider 与 Anthropic 协议（`AnthropicProvider`），均已删除。`src/providers/base.js` 不再包含 anthropic 协议分支。

## Provider 层与路由层的职责边界

### Provider 层（`src/providers/`）

- 拼出正确的上游 URL（`resolveURL` → `/v2/chat/completions`）
- 注入 CLI 指纹请求头（`buildHeaders`，见 `buildCliHeaders`）
- 做模型名 alias → 真实模型名映射（`preRequest`）

### 路由层（`src/routes/openai.js`）

- 消息规范化、prompt 替换、内容清洗、工具 Schema 清洗
- 强制流式 + SSE 空字段清洗
- 非流式请求聚合成完整 JSON 返回

## 模型注册

在 `src/config.js` 中，`CODECBUDDY_API_KEY` 存在时实例化唯一的 `CodeBuddyProvider` 并注册进 `ProviderRegistry`。请求按模型 alias 查找 provider，未命中回退到默认 provider（`codebuddy`）。

## Provider 配置（环境变量）

```bash
CODEBUDDY_API_KEY=...
CODEBUDDY_BASE_URL=https://www.codebuddy.ai   # 或 https://copilot.tencent.com
CODEBUDDY_MODELS=default,glm-5.1
CODEBUDDY_TARGET_MODEL=actual-upstream-model
CODEBUDDY_CLI_VERSION=2.110.0   # 覆盖自动检测的 CLI 版本
```

## 关键不变量

- 上游协议固定为 OpenAI Chat Completions，无第二协议
- 路由层固定走 CodeBuddy 适配栈，无纯透传分支
- CLI 指纹头等副作用全部封装在 provider 内，对 `fetchUpstream` 的调用方透明
