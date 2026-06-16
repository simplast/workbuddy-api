# Provider 架构详解

## 架构设计

项目以**两条基准协议路线**（OpenAI Chat Completions、Anthropic Messages）为骨架。所有上游 provider 必须基于其中一条协议，不能发明第三种线缆格式。私有 provider（如 CodeBuddy、NVIDIA）通过**装饰器模式**叠加在基类上：

```
Provider (基类，protocol: 'openai' | 'anthropic')
  ├── resolveURL()                    # 标准端点 URL
  ├── buildHeaders(body) → headers    # 标准协议头（Authorization）
  ├── resolveModel(alias) → real      # 模型名映射
  ├── preRequest(body) → body         # 同步：body 改写
  ├── preRequestAsync(body)           # 异步：限流等待
  └── on429() / onSuccess()           # 状态反馈

OpenAIProvider     extends Provider  (协议头: Bearer)
AnthropicProvider  extends Provider  (协议头: Bearer; URL: /v1/messages)

CodeBuddyProvider  extends OpenAIProvider   # + CLI 请求头伪装
NvidiaProvider     extends OpenAIProvider   # + 令牌桶限流 + 429 指数退避
```

## 新增私有 Provider 流程

1. **创建子类** — 在 `src/providers/<name>.js` 创建类，继承 `OpenAIProvider` 或 `AnthropicProvider`

2. **覆盖钩子**（按需）：
   - `buildHeaders(body)` — 添加 provider 特定的请求头
   - `preRequest(body)` — 同步修改请求体（如模型名重写）
   - `preRequestAsync(body)` — 异步前置操作（如获取限流令牌）
   - `on429()` / `onSuccess()` — 响应状态反馈

3. **注册到配置** — 在 `src/config.js` 中按 `process.env.<NAME>_API_KEY` 条件实例化并 push 到 `providers` 数组

## Provider 配置（环境变量）

```bash
# 启用 codebuddy（OpenAI + CLI 头）
CODEBUDDY_API_KEY=...
CODEBUDDY_MODELS=default-model,glm-5.1
CODEBUDDY_TARGET_MODEL=actual-upstream-model

# 启用 nvidia（OpenAI + 限流）
NVIDIA_API_KEY=...
NVIDIA_MODELS=glm-5.1
NVIDIA_TARGET_MODEL=z-ai/glm-5.1
NVIDIA_RPM=40
NVIDIA_BURST=5

# 路由
DEFAULT_PROVIDER=codebuddy
```

## 关键不变量

- `Provider.protocol` 只能是 `'openai'` 或 `'anthropic'`（基类构造时强制校验）
- 私有 provider **不重写** `resolveURL` 改变线缆协议（CodeBuddy 例外：路径从 `/v1` 改为 `/v2/chat/completions` 但仍是 Chat Completions 协议）
- 路由层（`routes/openai.js`、`routes/anthropic.js`）只与协议打交道，**不感知**私有 provider 的存在
- 限流、头部伪装等副作用全部封装在 provider 内，对调用方透明

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
