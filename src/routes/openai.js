import { config } from '../config.js';
import { fetchUpstream } from '../lib/upstream.js';
import { logRequest } from '../lib/logger.js';
import { replaceSystemPrompt, filterContentMessages } from '../lib/prompt.js';
import { normalizeOpenAIMessages } from '../lib/normalize.js';
import { readSSEStream, aggregateSSEChunks, normalizeSSEData } from '../lib/sse.js';
import { makeRequestId, dumpRequest, dumpResponse, logResponseSummary, LOG_DIR, DEBUG_DIR } from '../lib/debug.js';
import fs from 'node:fs';
import path from 'node:path';

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
    stream_options: { include_usage: true },
  };

  // Normalize format (fix non-standard array content in assistant messages)
  // then replace system prompt & filter content
  if (upstreamBody.messages) {
    normalizeOpenAIMessages(upstreamBody.messages);
    replaceSystemPrompt(upstreamBody.messages);
    upstreamBody.messages = filterContentMessages(upstreamBody.messages);
  }

  // Debug dump
  const requestId = makeRequestId();
  dumpRequest('openai', requestId, upstreamBody);

  try {
    const upstream = await fetchUpstream(upstreamBody);
    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`[upstream ${upstream.status}]`, errText);
      return res.status(upstream.status).json({ error: { message: errText, type: 'upstream_error' } });
    }

    if (wantStream) {
      return pipeStreamResponse({ res, upstream, upstreamBody, startTime, requestId });
    } else {
      return aggregateNonStreamResponse({ res, upstream, upstreamBody, startTime, requestId });
    }
  } catch (err) {
    console.error('[proxy error]', err?.message || err);
    res.status(500).json({ error: { message: err?.message || 'Internal proxy error', type: 'proxy_error' } });
  }
}

// ─── 流式：直接透传 SSE，同时采集 usage ─────────────────────────────────
async function pipeStreamResponse({ res, upstream, upstreamBody, startTime, requestId }) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
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
        if (!trimmed) continue;

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

      // ── aggregate for debug log ──
      aggregateChunkForDebug(chunk);
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
  saveStreamDebugLog(requestId, streamModel, _finishReason, _fullContent, _fullReasoning, _toolCalls, streamUsage, pipeLogLines);
  logRequest({ model: streamModel, startTime, usage: streamUsage });

  // ── helper: aggregate a raw SSE chunk for debug logging ──
  function aggregateChunkForDebug(chunk) {
    // Parse the raw chunk (before normalization) to extract content/usage
    const lines = chunk.split('\n');
    for (const sl of lines) {
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
}

// ─── 非流式：聚合 SSE chunks → 单个 JSON 响应 ──────────────────────────
async function aggregateNonStreamResponse({ res, upstream, upstreamBody, startTime, requestId }) {
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
  saveNonStreamDebugLog(requestId, id, model, finishReason, fullContent, fullReasoning, toolCalls, usage);
  logRequest({ model, startTime, usage });
}

// ─── Debug log helpers ────────────────────────────────────────────────────
function formatToolCallsForDebug(toolCalls) {
  return toolCalls.map((tc) => {
    let args = tc.function.arguments;
    try { args = JSON.parse(args); } catch {}
    return { id: tc.id, function: { name: tc.function.name, arguments: args } };
  });
}

function saveStreamDebugLog(requestId, model, finishReason, content, reasoning, toolCalls, usage, pipeLogLines) {
  try {
    const debugResp = {
      id: requestId,
      model,
      finish_reason: finishReason,
      message: { role: 'assistant', content: content || null },
      tool_calls_count: toolCalls.length,
      usage,
      sse_sent_to_client: pipeLogLines.join(''),
    };
    if (reasoning) debugResp.message.reasoning_content = reasoning;
    if (toolCalls.length > 0) debugResp.message.tool_calls = formatToolCallsForDebug(toolCalls);
    dumpResponse('openai', requestId, debugResp);

    const tcSummary = toolCalls.length > 0
      ? toolCalls.map((tc) => tc.function.name).join(', ')
      : '(none)';
    const reasoningSummary = reasoning.length > 0 ? ` reasoning=${reasoning.length}chars` : '';
    logResponseSummary('openai', {
      finishReason, contentLen: content.length, reasoningLen: reasoning.length,
      toolCallSummary: tcSummary, extraInfo: reasoningSummary, requestId,
    });
  } catch { /* ignore */ }
}

function saveNonStreamDebugLog(requestId, id, model, finishReason, content, reasoning, toolCalls, usage) {
  try {
    const debugResp = {
      id, model, finish_reason: finishReason,
      message: { role: 'assistant', content: content || null },
      tool_calls_count: toolCalls.length,
      usage,
    };
    if (reasoning) debugResp.message.reasoning_content = reasoning;
    if (toolCalls.length > 0) debugResp.message.tool_calls = formatToolCallsForDebug(toolCalls);
    dumpResponse('openai', requestId, debugResp);

    const tcSummary = toolCalls.length > 0
      ? toolCalls.map((tc) => tc.function.name).join(', ')
      : '(none)';
    logResponseSummary('openai', {
      finishReason, contentLen: (content || '').length, toolCallSummary: tcSummary, requestId,
    });
  } catch { /* ignore */ }
}
