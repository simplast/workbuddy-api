# workbuddy-api 重构进度

## 架构问题分析

### 核心问题：路由文件是巨型单体

| 文件 | 行数 | 问题 |
|------|------|------|
| `routes/openai.js` | 356 | 混合了路由逻辑、SSE 流处理、调试日志、响应聚合 |
| `routes/anthropic.js` | 508 | 同上，加上 Anthropic block state machine、pseudo-XML 检测 |

### 具体问题

1. **调试日志重复** — 两个路由文件各有 ~50 行几乎相同的 debug dump 代码（requestId 生成、目录创建、文件写入、console 输出）
2. **SSE 流处理重复** — 两个路由各有自己的 SSE 读取循环、watchdog、buffer 管理；`sse.js` 已存在但仅被 openai 非流式路径使用
3. **Anthropic 响应转换内联** — block state machine、pseudo-XML 检测、stop reason mapping 全部内联在路由文件中，应属于 `convert/` 层
4. **normalizeSSEData 散落** — OpenAI SSE 空字段清洗函数定义在 `openai.js` 内部，应属于 `sse.js`
5. **硬编码路径** — `LOG_DIR = path.resolve('logs')` 相对 CWD，两个文件重复定义

### 重构目标

```
src/
  index.js                    # Express app + 路由注册（不变）
  config.js                   # 环境配置（不变）
  models.js                   # 模型加载（不变）
  routes/
    openai.js                 # 瘦路由：准备请求 → 调用上游 → 委托流处理
    anthropic.js              # 瘦路由：转换请求 → 调用上游 → 委托响应转换
  lib/
    upstream.js               # 上游请求（不变）
    headers.js                # CLI 头伪装（不变）
    logger.js                 # 请求日志（不变）
    normalize.js              # 消息修正（不变）
    prompt.js                 # System prompt 替换（不变）
    sse.js                    # 增强：+ normalizeSSEData, + createStreamPiper
    debug.js                  # 新增：调试日志管理（requestId, dump, response log）
    rate-limit.js             # 速率限制（不变）
    debug-cleanup.js          # 调试文件清理（不变）
  convert/
    anthropic.js              # Anthropic→OpenAI 请求转换（不变）
    anthropic-response.js     # 新增：OpenAI→Anthropic 响应转换
```

## 重构步骤

### Phase 1: 提取 debug 日志模块
- [ ] 创建 `src/lib/debug.js`，封装 requestId 生成、请求/响应 dump、目录管理
- [ ] 更新 `routes/openai.js` 和 `routes/anthropic.js` 使用新模块
- [ ] 测试 + 提交

### Phase 2: 增强 SSE 工具
- [ ] 将 `normalizeSSEData` 从 `openai.js` 移入 `sse.js`
- [ ] 创建 `createStreamPiper` 封装通用 SSE 流转发逻辑
- [ ] 更新路由使用新工具
- [ ] 测试 + 提交

### Phase 3: 提取 Anthropic 响应转换
- [ ] 创建 `src/convert/anthropic-response.js`
- [ ] 移入：stop reason mapping、pseudo-XML 检测、block state machine、SSE event helpers
- [ ] 更新 `routes/anthropic.js` 使用新模块
- [ ] 测试 + 提交

### Phase 4: 瘦身路由处理器
- [ ] 简化 `routes/openai.js` 为薄编排层
- [ ] 简化 `routes/anthropic.js` 为薄编排层
- [ ] 测试 + 提交

### Phase 5: 最终验证
- [ ] 完整功能测试
- [ ] 代码审查
- [ ] 最终提交
