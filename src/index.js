import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { config } from './config.js';
import { getModels } from './models.js';
import {
  anthropicToOpenAIMessages,
  anthropicToOpenAITools,
  mapToolChoice,
  streamAnthropicResponse,
  nonStreamAnthropicResponse,
} from './anthropic.js';

const UPSTREAM = `${config.baseURL}/v2/chat/completions`;

// ─── 日志文件 ──────────────────────────────────────────────────────────────
const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.jsonl');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── 自定义 System Prompt（规避上游内容审核） ────────────────────────────────
const SYSTEM_PROMPT_FILE = path.resolve('system-prompt.txt');
let customSystemPrompt = '';
try {
  customSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8').trim();
  console.log(`  \x1b[32m✓\x1b[0m Custom system prompt loaded (${customSystemPrompt.length} chars)`);
} catch {
  console.log('  \x1b[33m⚠\x1b[0m No system-prompt.txt found, passthrough mode');
}

// ─── CLI 版本 & SDK 信息 ────────────────────────────────────────────────────
let CLI_VERSION = '2.106.1';
let SDK_VERSION = '6.25.0';
try {
  const raw = execSync('which codebuddy 2>/dev/null || which cbc 2>/dev/null', { encoding: 'utf8' }).trim();
  if (raw) {
    const ver = execSync(
      `node -e "const p=require('path');const f=require('fs');console.log(require(p.join(p.dirname(f.realpathSync('${raw}')),'..','package.json')).version)"`,
      { encoding: 'utf8' }
    ).trim();
    if (ver) CLI_VERSION = ver;
  }
} catch { /* fallback */ }

// ─── 构造与真实 CLI 完全一致的请求头 ────────────────────────────────────────
// 基于拦截真实 CLI 请求捕获的完整 header 列表

function hexId(len = 32) {
  return crypto.randomBytes(len / 2).toString('hex');
}

function buildCliHeaders(model) {
  const conversationId = crypto.randomUUID();
  const requestId = hexId(32);
  const messageId = hexId(32);
  const traceId = hexId(32);
  const spanId = hexId(16);
  const parentSpanId = hexId(16);

  // X-User-Id: API Key 模式下是 anonymous_ + key 最后 8 位
  const userIdSuffix = config.apiKey.slice(-8);
  const userId = `anonymous_${userIdSuffix}`;

  // OS 信息 (Stainless SDK 自动添加)
  const platform = os.platform();
  const arch = os.arch();
  const osName = platform === 'darwin' ? 'MacOS' : platform === 'linux' ? 'Linux' : 'Windows';

  return {
    // ── 标准 HTTP ──
    'Accept': 'application/json',
    'x-requested-with': 'XMLHttpRequest',

    // ── OpenAI Stainless SDK 头（CLI 底层用的 OpenAI SDK） ──
    'x-stainless-arch': arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': osName,
    'x-stainless-package-version': SDK_VERSION,
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,

    // ── 会话/请求追踪 ──
    'X-Conversation-ID': conversationId,
    'X-Conversation-Request-ID': requestId,
    'X-Conversation-Message-ID': messageId,
    'X-Request-ID': traceId,

    // ── Agent 信息 ──
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',

    // ── 客户端标识（后台"客户端"列） ──
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': CLI_VERSION,
    'X-Private-Data': 'false',

    // ── Zipkin B3 分布式追踪 ──
    'X-Trace-ID': traceId,
    'b3': `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',

    // ── 网关标识 ──
    'x-codebuddy-request': '1',

    // ── 双认证（CLI 同时发 X-API-Key 和 Authorization Bearer） ──
    'X-API-Key': config.apiKey,
    'X-User-Id': userId,
    'X-Product': 'SaaS',

    // ── User-Agent（格式：CLI/<version> CodeBuddy/<version>） ──
    'User-Agent': `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
  };
}

// ─── 请求日志 ─────────────────────────────────────────────────────────────
function logRequest({ model, startTime, usage }) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const elapsed = Date.now() - startTime;

  const line = '\x1b[90m─\x1b[0m'.repeat(60);
  console.log(`\n${line}`);
  console.log(`\x1b[36m[${timeStr}]\x1b[0m  \x1b[1m${model}\x1b[0m  \x1b[90m${elapsed}ms\x1b[0m`);

  if (usage) {
    const inp = usage.prompt_tokens ?? 0;
    const out = usage.completion_tokens ?? 0;
    const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
    const cachedOut = usage.completion_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
    const thinking = usage.completion_thinking_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0;
    const credit = usage.credit;

    let parts = [`\x1b[32m↑ ${inp}\x1b[0m`, `\x1b[33m↓ ${out}\x1b[0m`];
    if (cacheHit) parts.push(`\x1b[35mcache_hit ${cacheHit}\x1b[0m`);
    if (cacheMiss) parts.push(`cache_miss ${cacheMiss}`);
    if (cachedOut) parts.push(`\x1b[35mcached_out ${cachedOut}\x1b[0m`);
    if (thinking) parts.push(`\x1b[90mthinking ${thinking}\x1b[0m`);
    if (credit != null) parts.push(`\x1b[31m¥${credit}\x1b[0m`);

    console.log('  ' + parts.join('  \x1b[90m│\x1b[0m  '));

    // 写入 JSONL
    const record = {
      timestamp: now.toISOString(),
      model,
      elapsed_ms: elapsed,
      prompt_tokens: inp,
      completion_tokens: out,
      cache_hit_tokens: cacheHit,
      cache_miss_tokens: cacheMiss,
      cached_output_tokens: cachedOut,
      thinking_tokens: thinking,
      credit: credit ?? null,
      total_tokens: usage.total_tokens ?? inp + out,
    };
    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
    } catch (e) {
      console.error('[log write error]', e.message);
    }
  }
}

// ─── Express App ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '50mb' }));

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', upstream: UPSTREAM, defaultModel: config.defaultModel });
});

// 列出可用模型（动态加载）
app.get('/v1/models', (_req, res) => {
  const models = getModels();
  res.json({
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created: Date.now(),
      owned_by: 'codebuddy',
      name: m.name,
      credits: m.credits,
      supportsImages: m.supportsImages,
      supportsReasoning: m.supportsReasoning,
    })),
  });
});

// ─── 核心：POST /v1/chat/completions ───────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  const startTime = Date.now();
  const wantStream = req.body.stream === true;

  // 构造上游请求体 — 强制 stream: true（CodeBuddy 只支持流式）
  const upstreamBody = {
    ...req.body,
    model: req.body.model || config.defaultModel,
    stream: true,
    stream_options: { include_usage: true },
  };

  // ─── 替换 system prompt ─────────────────────────────────────────────────
  if (customSystemPrompt && upstreamBody.messages) {
    const sysIdx = upstreamBody.messages.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0) {
      upstreamBody.messages[sysIdx] = { role: 'system', content: customSystemPrompt };
      console.log(`\x1b[36m[sys]\x1b[0m system prompt replaced (${customSystemPrompt.length} chars)`);
    }
  }

  // ─── 清洗历史中的 content_filter 错误消息 ──────────────────────────────
  if (upstreamBody.messages) {
    const FILTER_MARK = '敏感内容';
    const before = upstreamBody.messages.length;
    upstreamBody.messages = upstreamBody.messages.filter((m) => {
      if (m.role !== 'assistant') return true;
      const text = typeof m.content === 'string' ? m.content : '';
      return !text.includes(FILTER_MARK);
    });
    const removed = before - upstreamBody.messages.length;
    if (removed > 0) {
      console.log(`\x1b[36m[clean]\x1b[0m removed ${removed} content_filter error message(s) from history`);
    }
  }

  // ─── dump 请求体供调试 ─────────────────────────────────────────────────
  try {
    fs.writeFileSync(path.join(LOG_DIR, 'last-request.json'), JSON.stringify(upstreamBody, null, 2));
    const msgs = upstreamBody.messages || [];
    const sys = msgs.find((m) => m.role === 'system');
    if (sys) {
      const preview = (typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content)).slice(0, 200);
      console.log(`\x1b[33m[req dump]\x1b[0m system prompt ${sys.content?.length ?? 0} chars: ${preview}...`);
    }
    console.log(`\x1b[33m[req dump]\x1b[0m ${msgs.length} messages, ${upstreamBody.tools?.length ?? 0} tools → saved to logs/last-request.json`);
  } catch { /* ignore */ }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        ...buildCliHeaders(upstreamBody.model),
      },
      body: JSON.stringify(upstreamBody),
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`[upstream ${upstream.status}]`, errText);
      return res.status(upstream.status).json({ error: { message: errText, type: 'upstream_error' } });
    }

    // ─── 流式：直接透传 SSE，同时采集 usage ─────────────────────────────────
    if (wantStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let streamBuf = '';
      let streamUsage = null;
      let streamModel = upstreamBody.model;
      let sentDone = false;
      let lastDataTime = Date.now();

      // 流式超时看门狗（120s 无数据则断开）
      const STREAM_TIMEOUT = 120_000;
      const watchdog = setInterval(() => {
        if (Date.now() - lastDataTime > STREAM_TIMEOUT) {
          console.error(`[stream timeout] no data for ${STREAM_TIMEOUT}ms`);
          try { reader.cancel(); } catch {}
          if (!sentDone) { res.write('data: [DONE]\n\n'); sentDone = true; }
          res.end();
          clearInterval(watchdog);
        }
      }, 10_000);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastDataTime = Date.now();
          const chunk = decoder.decode(value, { stream: true });

          // 检测上游是否已发 [DONE]
          if (chunk.includes('data: [DONE]')) sentDone = true;
          res.write(chunk);

          // 旁路解析 usage
          streamBuf += chunk;
          const sseLines = streamBuf.split('\n');
          streamBuf = sseLines.pop() || '';
          for (const sl of sseLines) {
            const t = sl.trim();
            if (!t.startsWith('data: ')) continue;
            const d = t.slice(6);
            if (d === '[DONE]') continue;
            try {
              const p = JSON.parse(d);
              if (p.model) streamModel = p.model;
              if (p.usage) streamUsage = p.usage;
            } catch { /* skip */ }
          }
        }
      } catch (e) {
        console.error('[stream pipe error]', e.message);
        // 发送错误事件给客户端
        try {
          const errChunk = { error: { message: e.message, type: 'stream_error' } };
          res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        } catch {}
      } finally {
        clearInterval(watchdog);
      }

      // 保证 [DONE] 信号一定发出
      if (!sentDone) { res.write('data: [DONE]\n\n'); }
      res.end();
      logRequest({ model: streamModel, startTime, usage: streamUsage });
      return;
    }

    // ─── 非流式：聚合 SSE chunks → 单个 JSON 响应 ───────────────────────
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let fullContent = '';
    let fullReasoning = '';
    let toolCalls = [];
    let lastChunk = null;
    let id = '';
    let model = upstreamBody.model;
    let created = Math.floor(Date.now() / 1000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留未完成的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          lastChunk = parsed;
          id = parsed.id || id;
          model = parsed.model || model;
          created = parsed.created || created;

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta || {};
          if (delta.content) fullContent += delta.content;
          if (delta.reasoning_content) fullReasoning += delta.reasoning_content;

          // 合并 tool_calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? toolCalls.length;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch { /* skip malformed chunks */ }
      }
    }

    const finishReason = lastChunk?.choices?.[0]?.finish_reason || 'stop';
    const usage = lastChunk?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const message = { role: 'assistant', content: fullContent || null };
    if (fullReasoning) message.reasoning_content = fullReasoning;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    res.json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    });

    logRequest({ model, startTime, usage });
  } catch (err) {
    console.error('[proxy error]', err?.message || err);
    res.status(500).json({ error: { message: err?.message || 'Internal proxy error', type: 'proxy_error' } });
  }
});

// ─── Anthropic Messages API: POST /v1/messages ──────────────────────────────
app.post('/v1/messages', async (req, res) => {
  const startTime = Date.now();
  const body = req.body;
  const model = body.model || config.defaultModel;

  const openaiMessages = anthropicToOpenAIMessages(body);
  const openaiTools = anthropicToOpenAITools(body.tools);

  const upstreamBody = {
    model,
    messages: openaiMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (openaiTools && openaiTools.length > 0) upstreamBody.tools = openaiTools;
  if (body.max_tokens) upstreamBody.max_tokens = body.max_tokens;
  if (body.temperature != null) upstreamBody.temperature = body.temperature;
  const tc = mapToolChoice(body.tool_choice);
  if (tc) upstreamBody.tool_choice = tc;

  // dump 调试
  try {
    fs.writeFileSync(path.join(LOG_DIR, 'last-request-anthropic.json'), JSON.stringify(upstreamBody, null, 2));
  } catch {}

  const fetchUpstream = async (ub) => fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...buildCliHeaders(model),
    },
    body: JSON.stringify(ub),
  });

  const shared = { upstreamBody, res, fetchUpstream, startTime, model, logRequest, customSystemPrompt };

  if (body.stream === true) {
    return streamAnthropicResponse(shared);
  } else {
    return nonStreamAnthropicResponse(shared);
  }
});

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: { message: 'Use POST /v1/chat/completions, POST /v1/messages, or GET /v1/models' } });
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(config.port, config.host, () => {
  console.log(`
  ✦ workbuddy-api proxy running

  OpenAI:    http://${config.host}:${config.port}/v1/chat/completions
  Anthropic: http://${config.host}:${config.port}/v1/messages
  Upstream:  ${UPSTREAM}
  Default:   ${config.defaultModel}
  `);
});
