# Provider 架构详解

## 架构设计

项目以**两条基准协议路线**（OpenAI Chat Completions、Anthropic Messages）为骨架。路由路径决定协议：
- `POST /v1/chat/completions` → OpenAI 协议
- `POST /v1/messages` → Anthropic 协议

所有上游 provider 基于其中一条协议实现（`protocol: 'openai' | 'anthropic'`），不能发明第三种线缆格式。私有 provider（如 CodeBuddy、NVIDIA）通过**装饰器模式**叠加在基类上：

```
Provider (基类，protocol: 'openai' | 'anthropic')
  ├── resolveURL()                    # 标准端点 URL
  ├── buildHeaders(body) → headers    # 标准协议头（Authorization）
  ├── resolveModel(alias) → real      # 模型名映射
  ├── preRequest(body) → body         # 同步：body 改写
  ├── preRequestAsync(body)           # 异步：限流等待
  ├── postResponse(response)          # 观察响应状态（限流反馈、熔断器等）
  └── on429() / onSuccess()           # 状态反馈

OpenAIProvider     extends Provider  (协议头: Bearer; URL: /v1/chat/completions)
AnthropicProvider  extends Provider  (协议头: Bearer; URL: /v1/messages)

CodeBuddyProvider  extends OpenAIProvider   # + CLI 请求头伪装 + /v2 路径
NvidiaProvider     extends OpenAIProvider   # + 令牌桶限流 + 429 指数退避
```

## 路由层与 provider 层的职责边界

### Provider 层（统一、所有链路共享）

provider 层对**所有请求路径**都执行这些操作：
- 根据模型名 alias 选择 provider（`ProviderRegistry.resolveForModel`）
- 拼出正确的上游 URL（`resolveURL`，受 `protocol` 字段控制）
- 注入协议/提供商专属请求头（`buildHeaders`）
- 做模型名 alias → 真实模型名映射（`preRequest`）
- 处理速率限制（`preRequestAsync` + `on429`/`onSuccess`）

### 路由层（差异化，按路径分流）

路由层按路径决定协议，并在 OpenAI 路径上**按 provider 名做二次分流**：

| 路径 | provider 为 codebuddy | provider 为其他 |
|------|----------------------|----------------|
| `/v1/chat/completions` | **完整适配栈**：prompt 替换 + 内容清洗 + 强制流式 + SSE 空字段清洗 + 非流式聚合 | **纯透传**：原始 body → 原始响应字节 |
| `/v1/messages` | **纯透传**（不做 Anthropic↔OpenAI 转换） | **纯透传** |

> **设计要点**：路由层**感知** `codebuddy` 名字做适配分流，但不直接引用 provider 类。其他 provider 对路由层完全透明。

## 新增私有 Provider 流程

1. **创建子类** — 在 `src/providers/<name>.js` 创建类，继承 `OpenAIProvider` 或 `AnthropicProvider`

2. **覆盖钩子**（按需）：
   - `buildHeaders(body)` — 添加 provider 特定的请求头
   - `preRequest(body)` — 同步修改请求体（如模型名重写）
   - `preRequestAsync(body)` — 异步前置操作（如获取限流令牌）
   - `on429()` / `onSuccess()` — 响应状态反馈

3. **注册到配置** — 在 `src/config.js` 中按 `process.env.<NAME>_API_KEY` 条件实例化并 push 到 `providers` 数组

4. **路由层是否需要感知？** — 默认不需要。只有当需要对特定 provider 做**协议级别的消息改造**（如替换 system prompt、强制更改流式模式）时，才在路由层添加 `provider.name === 'your-name'` 的检查。普通 provider（如加自定义头、限速）应完全在 provider 子类中自包含。

## Provider 配置（环境变量）

```bash
# 启用 codebuddy（OpenAI + CLI 头 + 路由层适配）
CODEBUDDY_API_KEY=...
CODEBUDDY_MODELS=default-model,glm-5.1
CODEBUDDY_TARGET_MODEL=actual-upstream-model

# 启用 nvidia（OpenAI + 限流，路由层纯透传）
NVIDIA_API_KEY=...
NVIDIA_MODELS=glm-5.1
NVIDIA_TARGET_MODEL=z-ai/glm-5.1
NVIDIA_RPM=40
NVIDIA_BURST=5

# 路由回退
DEFAULT_PROVIDER=codebuddy
```

## 关键不变量

- `Provider.protocol` 只能是 `'openai'` 或 `'anthropic'`（基类构造时强制校验）
- `Provider.resolveURL()` 的路径由 `protocol` 决定，私有 provider 可重写（如 CodeBuddy 用 `/v2/chat/completions`）
- **路由层按 provider.name 做适配分流**（当前仅 `'codebuddy'`），其他 provider 对路由层透明
- 限流、头部伪装等副作用全部封装在 provider 内，对 `fetchUpstream` 的调用方透明
- Anthropic 路由 (`/v1/messages`) 不做任何格式转换，纯透传。协议由路径本身声明

## 路由机制

`ProviderRegistry.resolveForModel(model)` 按 model alias 顺序匹配：
1. 遍历所有 provider 的 `models` 数组
2. 找到第一个包含该 model 的 provider
3. 未命中时回退到 `DEFAULT_PROVIDER`

## 示例：创建新 Provider

```javascript
// src/providers/my-provider.js
import { OpenAIProvider } from './base.js';

export class MyProvider extends OpenAIProvider {
  constructor(opts) {
    super({ ...opts, label: 'my-provider' });
  }

  buildHeaders(body) {
    return {
      ...super.buildHeaders(body),
      'X-Custom-Header': 'value',
    };
  }
}
```

```javascript
// src/config.js — 在 providers 数组前添加
if (process.env.MY_PROVIDER_API_KEY) {
  providers.push(new MyProvider({
    name: 'my-provider',
    baseURL: process.env.MY_PROVIDER_BASE_URL,
    apiKey: process.env.MY_PROVIDER_API_KEY,
    models: (process.env.MY_PROVIDER_MODELS || '').split(',').map(s => s.trim()).filter(Boolean),
  }));
}
```

如果 `my-provider` 像 CodeBuddy 一样需要**协议级消息改造**（如替换 system prompt、强制流式），还需要在 `src/routes/openai.js` 中添加对应的 `provider.name === 'my-provider'` 分支。否则不需要改路由。
