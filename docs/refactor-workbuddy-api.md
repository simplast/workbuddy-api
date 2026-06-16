# workbuddy-api 重构进度

## 架构问题分析（重构前）

### 核心问题：路由文件是巨型单体

| 文件 | 行数 | 问题 |
|------|------|------|
| `routes/openai.js` | 356 | 混合了路由逻辑、SSE 流处理、调试日志、响应聚合 |
| `routes/anthropic.js` | 508 | 同上，加上 Anthropic block state machine、pseudo-XML 检测 |

### 具体问题

1. **调试日志重复** — 两个路由文件各有 ~50 行几乎相同的 debug dump 代码
2. **SSE 流处理重复** — 两个路由各有自己的 SSE 读取循环；`sse.js` 仅被 openai 非流式路径使用
3. **Anthropic 响应转换内联** — pseudo-XML 检测、stop reason mapping 内联在路由文件中
4. **normalizeSSEData 散落** — 定义在 `openai.js` 内部，应属于 `sse.js`
5. **硬编码路径** — `LOG_DIR` 两个文件重复定义

## 重构结果

### 行数对比

| 文件 | 重构前 | 重构后 | 变化 |
|------|--------|--------|------|
| `routes/openai.js` | 356 | 231 | -35% |
| `routes/anthropic.js` | 508 | 335 | -34% |
| **路由总计** | **864** | **566** | **-34%** |

### 新增模块

| 文件 | 行数 | 职责 |
|------|------|------|
| `lib/debug.js` | 150 | 调试日志管理（requestId, dump, response log） |
| `convert/anthropic-response.js` | 137 | OpenAI→Anthropic 响应转换（纯函数） |

### 增强模块

| 文件 | 变化 | 说明 |
|------|------|------|
| `lib/sse.js` | +42 行 | 新增 `normalizeSSEData()` 和 `sseEvent()` |

### 最终架构

```
src/
  index.js                    # Express app + 路由注册
  config.js                   # 环境配置
  models.js                   # 模型加载
  routes/
    openai.js                 # OpenAI 兼容端点（231 行）
    anthropic.js              # Anthropic Messages 端点（335 行）
  lib/
    upstream.js               # 上游请求构造 + NVIDIA 路由
    headers.js                # CLI 请求头伪装
    logger.js                 # 请求日志（console + JSONL）
    normalize.js              # OpenAI 非标准消息修正
    prompt.js                 # System prompt 替换 + 内容过滤
    sse.js                    # SSE 工具（normalizeSSEData, sseEvent, readSSEStream, aggregateSSEChunks）
    debug.js                  # 调试日志管理（makeRequestId, dumpRequest, dumpResponse, logResponseSummary, save*DebugLog）
    rate-limit.js             # NVIDIA 速率限制
    debug-cleanup.js          # 调试文件自动清理
  convert/
    anthropic.js              # Anthropic→OpenAI 请求转换
    anthropic-response.js     # OpenAI→Anthropic 响应转换（makeMsgId, mapStopReason, extractPseudoXMLToolCalls, formatAnthropicContent, buildAnthropicDebugResp）
```

## 重构步骤（已完成）

### Phase 1: 提取 debug 日志模块 ✅
- [x] 创建 `src/lib/debug.js`
- [x] 更新路由使用新模块
- [x] 测试 + 提交

### Phase 2: 增强 SSE 工具 ✅
- [x] 将 `normalizeSSEData` 移入 `sse.js`
- [x] 将 `sseEvent` 移入 `sse.js`
- [x] 测试 + 提交

### Phase 3: 提取 Anthropic 响应转换 ✅
- [x] 创建 `src/convert/anthropic-response.js`
- [x] 移入：makeMsgId, mapStopReason, extractPseudoXMLToolCalls, formatAnthropicContent, buildAnthropicDebugResp
- [x] 测试 + 提交

### Phase 4: 瘦身路由处理器 ✅
- [x] 移动 OpenAI debug log helpers 到 `debug.js`
- [x] `nonStreamAnthropicResponse` 复用 `readSSEStream` + `aggregateSSEChunks`（消除 ~40 行重复 SSE 解析）
- [x] 移除未使用的导入
- [x] 测试 + 提交

### Phase 5: 最终验证 ✅
- [x] 服务器启动正常，/health 端点响应正确
- [x] 代码审查通过
- [x] 更新进度文档

## 设计决策

### 为什么 block state machine 留在 anthropic.js？

`streamAnthropicResponse` 中的 block state machine（`openBlock`/`closeCurrentBlock`）与 `res.write()` 紧密耦合。提取它需要引入回调/访问者模式，增加复杂度但无实际收益。当前实现清晰且内聚。

### 为什么 pipeStreamResponse 保留 aggregateChunkForDebug？

`pipeStreamResponse` 需要在转发 SSE 数据的同时聚合调试信息。`aggregateChunkForDebug` 作为嵌套函数捕获外部状态，这是最简洁的实现方式。提取为独立函数需要传入大量状态参数，得不偿失。
