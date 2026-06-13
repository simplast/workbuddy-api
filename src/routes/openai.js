import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { fetchUpstream } from '../lib/upstream.js';
import { logRequest } from '../lib/logger.js';
import { replaceSystemPrompt, filterContentMessages } from '../lib/prompt.js';
import { readSSEStream, aggregateSSEChunks } from '../lib/sse.js';

const LOG_DIR = path.resolve('logs');

/**
 * POST /v1/chat/completions — OpenAI-compatible endpoint
 */
export async function handleChatCompletions(req, res) {
  const startTime = Date.now();
  const wantStream = req.body.stream === true;

  const reqModel = req.body.model || config.defaultModel;
  const upstreamBody = {
    ...req.body,
    model: reqModel,
    stream: true,
  };

  // Replace system prompt & filter content
  if (upstreamBody.messages) {
    replaceSystemPrompt(upstreamBody.messages);
    upstreamBody.messages = filterContentMessages(upstreamBody.messages);
  }

  // Debug dump
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
    const upstream = await fetchUpstream(upstreamBody);
    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`[upstream ${upstream.status}]`, errText);
      return res.status(upstream.status).json({ error: { message: errText, type: 'upstream_error' } });
    }

    if (wantStream) {
      return pipeStreamResponse({ res, upstream, upstreamBody, startTime });
    } else {
      return aggregateNonStreamResponse({ res, upstream, upstreamBody, startTime });
    }
  } catch (err) {
    console.error('[proxy error]', err?.message || err);
    res.status(500).json({ error: { message: err?.message || 'Internal proxy error', type: 'proxy_error' } });
  }
}

// ─── 流式：直接透传 SSE，同时采集 usage ─────────────────────────────────
async function pipeStreamResponse({ res, upstream, upstreamBody, startTime }) {
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

      if (chunk.includes('data: [DONE]')) sentDone = true;
      res.write(chunk);

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
    try {
      const errChunk = { error: { message: e.message, type: 'stream_error' } };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
    } catch {}
  } finally {
    clearInterval(watchdog);
  }

  if (!sentDone) { res.write('data: [DONE]\n\n'); }
  res.end();
  logRequest({ model: streamModel, startTime, usage: streamUsage });
}

// ─── 非流式：聚合 SSE chunks → 单个 JSON 响应 ──────────────────────────
async function aggregateNonStreamResponse({ res, upstream, upstreamBody, startTime }) {
  const reader = upstream.body.getReader();
  const agg = aggregateSSEChunks();

  await readSSEStream(reader, {
    onChunk: (parsed) => agg.handleChunk(parsed),
  });

  const { fullContent, fullReasoning, toolCalls, lastChunk, id, model, created } = agg.getResult();

  const finishReason = lastChunk?.choices?.[0]?.finish_reason || 'stop';
  const usage = lastChunk?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const message = { role: 'assistant', content: fullContent || null };
  if (fullReasoning) message.reasoning_content = fullReasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  res.json({
    id,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  });

  logRequest({ model, startTime, usage });
}
