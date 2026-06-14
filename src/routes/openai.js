import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { fetchUpstream } from '../lib/upstream.js';
import { logRequest } from '../lib/logger.js';
import { replaceSystemPrompt, filterContentMessages } from '../lib/prompt.js';
import { normalizeOpenAIMessages } from '../lib/normalize.js';
import { readSSEStream, aggregateSSEChunks } from '../lib/sse.js';
import { cleanupDebugDir } from '../lib/debug-cleanup.js';

const LOG_DIR = path.resolve('logs');
const DEBUG_DIR = path.join(LOG_DIR, 'requests');

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

  // Normalize format (fix non-standard array content in assistant messages)
  // then replace system prompt & filter content
  if (upstreamBody.messages) {
    normalizeOpenAIMessages(upstreamBody.messages);
    replaceSystemPrompt(upstreamBody.messages);
    upstreamBody.messages = filterContentMessages(upstreamBody.messages);
  }

  // Debug dump (per-request to avoid concurrent overwrite)
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    cleanupDebugDir(DEBUG_DIR);
    fs.writeFileSync(path.join(DEBUG_DIR, `openai-${requestId}.json`), JSON.stringify({ id: requestId, request: upstreamBody }, null, 2));
    fs.writeFileSync(path.join(LOG_DIR, 'last-request.json'), JSON.stringify({ id: requestId, request: upstreamBody }, null, 2));
    const msgs = upstreamBody.messages || [];
    const sys = msgs.find((m) => m.role === 'system');
    if (sys) {
      const preview = (typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content)).slice(0, 200);
      console.log(`\x1b[33m[req dump]\x1b[0m system prompt ${typeof sys.content === 'string' ? sys.content.length : JSON.stringify(sys.content).length} chars: ${preview}...`);
    }
    console.log(`\x1b[33m[req dump]\x1b[0m ${msgs.length} messages, ${upstreamBody.tools?.length ?? 0} tools → saved to logs/last-request.json (id=${requestId})`);
  } catch { /* ignore */ }

  try {
    const upstream = await fetchUpstream(upstreamBody);
    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`[upstream ${upstream.status}]`, errText);
      return res.status(upstream.status).json({ error: { message: errText, type: 'upstream_error' } });
    }

    if (wantStream) {
      return pipeStreamResponse({ res, upstream, upstreamBody, startTime, requestId, debugDir: DEBUG_DIR });
    } else {
      return aggregateNonStreamResponse({ res, upstream, upstreamBody, startTime, requestId, debugDir: DEBUG_DIR });
    }
  } catch (err) {
    console.error('[proxy error]', err?.message || err);
    res.status(500).json({ error: { message: err?.message || 'Internal proxy error', type: 'proxy_error' } });
  }
}

// ─── 流式：直接透传 SSE，同时采集 usage ─────────────────────────────────
async function pipeStreamResponse({ res, upstream, upstreamBody, startTime, requestId, debugDir }) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let streamBuf = '';
  let pipeBuf = '';       // buffer for SSE line-level piping with OpenAI normalization
  let pipeLogLines = [];   // accumulate rewritten SSE for debug dump
  let streamUsage = null;
  let streamModel = upstreamBody.model;
  let sentDone = false;
  let lastDataTime = Date.now();
  let aborted = false;

  // Propagate client disconnect upstream
  res.on('close', () => {
    if (res.writableEnded) return;
    aborted = true;
    try { reader.cancel(); } catch {}
  });

  /**
   * Keep the public OpenAI endpoint OpenAI-shaped.
   *
   * CodeBuddy upstream emits several empty vendor fields. ccswitch turns
   * `reasoning_content: ""` into empty Anthropic thinking blocks, which can
   * truncate Claude Code's visible response. Strip only empty/null extras and
   * preserve real OpenAI fields and finish_reason values.
   */
  function normalizeSSEData(dataStr) {
    try {
      const obj = JSON.parse(dataStr);
      const choice = obj.choices?.[0];
      if (choice) {
        const delta = choice.delta || {};

        if (delta.reasoning_content === '') delete delta.reasoning_content;
        if (delta.content === '') delete delta.content;
        if (
          delta.function_call == null ||
          (delta.function_call.name === '' && delta.function_call.arguments === '')
        ) {
          delete delta.function_call;
        }
        if (delta.refusal === '') delete delta.refusal;
        if (delta.extra_fields == null) delete delta.extra_fields;
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0) delete delta.tool_calls;

        if (choice.finish_reason === '') choice.finish_reason = null;
      }
      return JSON.stringify(obj);
    } catch { /* not JSON, pass through */ }
    return dataStr;
  }

  function writeDataEvent(dataStr) {
    const line = `data: ${dataStr}\n\n`;
    pipeLogLines.push(line);
    res.write(line);
  }

  // ── response aggregation for debug log ──
  let _fullContent = '';
  let _fullReasoning = '';
  let _toolCalls = [];
  let _finishReason = null;
  let _responseId = null;

  const STREAM_TIMEOUT = 120_000;
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataTime > STREAM_TIMEOUT) {
      console.error(`[stream timeout] no data for ${STREAM_TIMEOUT}ms`);
      aborted = true;
      try { reader.cancel(); } catch {}
      clearInterval(watchdog);
    }
  }, 10_000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastDataTime = Date.now();
      const chunk = decoder.decode(value, { stream: true });

      // ── line-level SSE piping with OpenAI response normalization ──
      pipeBuf += chunk;
      const pipeLines = pipeBuf.split('\n');
      pipeBuf = pipeLines.pop() || '';  // keep incomplete last line

      for (const line of pipeLines) {
        const trimmed = line.trim();

        // OpenAI streams are data-only. Ignore blank separators from upstream;
        // writeDataEvent emits normalized SSE separators.
        if (!trimmed) {
          continue;
        }
        const dataMatch = trimmed.match(/^data:\s?(.*)$/);
        if (!dataMatch) {
          res.write(`${line}\n`);
          continue;
        }

        const dataStr = dataMatch[1];

        if (dataStr === '[DONE]') {
          sentDone = true;
          writeDataEvent('[DONE]');
          continue;
        }

        writeDataEvent(normalizeSSEData(dataStr));
      }

      // ── aggregate for debug log (reuse parsed data) ──
      streamBuf += chunk;
      const sseLines = streamBuf.split('\n');
      streamBuf = sseLines.pop() || '';
      for (const sl of sseLines) {
        const t = sl.trim();
        const dataMatch = t.match(/^data:\s?(.*)$/);
        if (!dataMatch) continue;
        const d = dataMatch[1];
        if (d === '[DONE]') continue;
        try {
          const p = JSON.parse(d);
          if (p.model) streamModel = p.model;
          if (p.usage) streamUsage = p.usage;

          if (p.id && !_responseId) _responseId = p.id;
          const choice = p.choices?.[0];
          if (choice) {
            const delta = choice.delta || {};
            if (choice.finish_reason) _finishReason = choice.finish_reason;
            if (delta.content) _fullContent += delta.content;
            if (delta.reasoning_content) _fullReasoning += delta.reasoning_content;
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? _toolCalls.length;
                if (!_toolCalls[idx]) _toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                if (tc.id) _toolCalls[idx].id = tc.id;
                if (tc.function?.name && !_toolCalls[idx].function.name) _toolCalls[idx].function.name = tc.function.name;
                if (tc.function?.arguments) _toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          }
        } catch { /* skip */ }
      }
    }

    // flush remaining pipeBuf
    if (pipeBuf.trim()) {
      const trimmed = pipeBuf.trim();
      const dataMatch = trimmed.match(/^data:\s?(.*)$/);
      if (dataMatch) {
        const dataStr = dataMatch[1];
        if (dataStr === '[DONE]') {
          sentDone = true;
          writeDataEvent('[DONE]');
        } else {
          writeDataEvent(normalizeSSEData(dataStr));
        }
      } else {
        res.write(pipeBuf);
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

  if (!sentDone && !aborted) { writeDataEvent('[DONE]'); }
  res.end();

  // ── save aggregated response for debugging ──
  try {
    const debugResp = {
      id: _responseId,
      model: streamModel,
      finish_reason: _finishReason,
      message: {
        role: 'assistant',
        content: _fullContent || null,
      },
      tool_calls_count: _toolCalls.length,
      usage: streamUsage,
      sse_sent_to_client: pipeLogLines.join(''),
    };
    if (_fullReasoning) debugResp.message.reasoning_content = _fullReasoning;
    if (_toolCalls.length > 0) {
      debugResp.message.tool_calls = _toolCalls.map((tc) => {
        let args = tc.function.arguments;
        try { args = JSON.parse(args); } catch {}
        return { id: tc.id, function: { name: tc.function.name, arguments: args } };
      });
    }
    fs.writeFileSync(path.join(debugDir, `openai-${requestId}-resp.json`), JSON.stringify({ id: requestId, response: debugResp }, null, 2));
    fs.writeFileSync(path.join(LOG_DIR, 'last-response.json'), JSON.stringify({ id: requestId, response: debugResp }, null, 2));

    // console summary
    const tcSummary = _toolCalls.length > 0
      ? _toolCalls.map((tc) => tc.function.name).join(', ')
      : '(none)';
    console.log(`\x1b[33m[resp dump]\x1b[0m finish=${_finishReason} content=${_fullContent.length}chars tool_calls=[${tcSummary}] → saved to logs/last-response.json (id=${requestId})`);
  } catch { /* ignore */ }

  logRequest({ model: streamModel, startTime, usage: streamUsage });
}

// ─── 非流式：聚合 SSE chunks → 单个 JSON 响应 ──────────────────────────
async function aggregateNonStreamResponse({ res, upstream, upstreamBody, startTime, requestId, debugDir }) {
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

  // ── save response for debugging ──
  try {
    const debugResp = {
      id,
      model,
      finish_reason: finishReason,
      message: { role: 'assistant', content: fullContent || null },
      tool_calls_count: toolCalls.length,
      usage,
    };
    if (fullReasoning) debugResp.message.reasoning_content = fullReasoning;
    if (toolCalls.length > 0) {
      debugResp.message.tool_calls = toolCalls.map((tc) => {
        let args = tc.function.arguments;
        try { args = JSON.parse(args); } catch {}
        return { id: tc.id, function: { name: tc.function.name, arguments: args } };
      });
    }
    fs.writeFileSync(path.join(debugDir, `openai-${requestId}-resp.json`), JSON.stringify({ id: requestId, response: debugResp }, null, 2));
    fs.writeFileSync(path.join(LOG_DIR, 'last-response.json'), JSON.stringify({ id: requestId, response: debugResp }, null, 2));

    const tcSummary = toolCalls.length > 0
      ? toolCalls.map((tc) => tc.function.name).join(', ')
      : '(none)';
    console.log(`\x1b[33m[resp dump]\x1b[0m finish=${finishReason} content=${(fullContent||'').length}chars tool_calls=[${tcSummary}] → saved to logs/last-response.json (id=${requestId})`);
  } catch { /* ignore */ }

  logRequest({ model, startTime, usage });
}
