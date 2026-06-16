# workbuddy-api 重构进度

## 阶段 1：路由瘦身（已完成）

详见前序 commits。**路由文件 864 → 566 行（-34%）**。

## 阶段 2：多 Provider 架构（已完成）

### 目标
- 系统保持两条基准协议路线：`openai` 和 `anthropic`
- CodeBuddy / NVIDIA 等私有 provider 是"补丁"——只加头、改字段、限流，**不发明第三种线缆格式**
- 新增私有 provider 不需要修改调度器，只需添加子类 + env-var block

### 架构

```
Provider (基类)
  - protocol: 'openai' | 'anthropic'    # 协议类型（构造时强制校验）
  - resolveURL()                        # 标准端点
  - buildHeaders(body) → headers        # 协议头
  - resolveModel(alias) → real          # 模型名映射
  - preRequest(body) → body             # 同步：body 改写
  - preRequestAsync(body)               # 异步：限流等待
  - on429() / onSuccess() / postResponse(r)

OpenAIProvider     extends Provider
AnthropicProvider  extends Provider

CodeBuddyProvider  extends OpenAIProvider   # + CLI 请求头伪装
NvidiaProvider     extends OpenAIProvider   # + 令牌桶限流 + 429 指数退避
```

### 新增模块

| 文件 | 行数 | 职责 |
|------|------|------|
| `providers/base.js` | 90 | Provider 基类 + OpenAIProvider / AnthropicProvider |
| `providers/codebuddy.js` | 145 | CodeBuddy（OpenAI + CLI 头，迁移自 `lib/headers.js`） |
| `providers/nvidia.js` | 130 | NVIDIA（OpenAI + 限流，迁移自 `lib/rate-limit.js`） |
| `providers/registry.js` | 30 | ProviderRegistry（model alias → provider 路由） |

### 删除模块

| 文件 | 替代 |
|------|------|
| `lib/headers.js` | `providers/codebuddy.js`（保留 git history） |
| `lib/rate-limit.js` | `providers/nvidia.js` |

### 关键不变量

- `Provider.protocol` 只能是 `'openai'` 或 `'anthropic'`
- 私有 provider 不改变线缆协议（CodeBuddy 路径 `/v1` → `/v2/chat/completions` 但仍是 Chat Completions 协议）
- 路由层（`routes/openai.js`、`routes/anthropic.js`）只与协议打交道，**不感知**私有 provider
- 限流、头部伪装等副作用全部封装在 provider 内，对调用方透明

### 新增私有 provider 流程

1. `src/providers/<name>.js` 创建子类，继承 `OpenAIProvider` 或 `AnthropicProvider`
2. 按需覆盖：`buildHeaders()` / `preRequest()` / `preRequestAsync()` / `on429()`
3. `src/config.js` 中按 `process.env.<NAME>_API_KEY` 条件实例化并 push 到 `providers` 数组

无需修改 `upstream.js` / 路由 / `registry.js`。

### 配置（环境变量）

```
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

### 验证

✅ 服务器启动正常
✅ `/health` 返回 `defaultProvider=codebuddy`、`upstream=https://copilot.tencent.com/v2/chat/completions`
✅ 同时设置 `CODEBUDDY_API_KEY` 和 `NVIDIA_API_KEY` 时，两个 provider 自动注册

### 破坏性变更（按用户决策）

- 移除 `lib/headers.js`、`lib/rate-limit.js`（逻辑迁移至 `providers/`）
- `.env.example` 重写为新的 provider block 格式
- `config.nvidia.baseURL` → `NVIDIA_BASE_URL` 顶级变量
- `AGENT.md` 重写 "Provider 架构" 章节
