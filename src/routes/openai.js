import { config } from '../config.js';
import { fetchUpstream, providerFor } from '../lib/upstream.js';
import { logRequest } from '../lib/logger.js';
import { replaceSystemPrompt, filterContentMessages } from '../lib/prompt.js';
import { normalizeOpenAIMessages } from '../lib/normalize.js';
import { readSSEStream, aggregateSSEChunks, normalizeSSEData } from '../lib/sse.js';
import { makeRequestId, dumpRequest, saveOpenAIStreamDebugLog, saveOpenAINonStreamDebugLog } from '../lib/debug.js';

/**
 * POST /v1/chat/completions — OpenAI-compatible endpoint
 *
 * Two paths:
 *   - CodeBuddy upstream: full adaptations (prompt replacement, CLI headers,
 *     SSE field normalization, forced-stream aggregation for non-stream clients)
 *   - Other providers: pure passthrough — request body and upstream bytes
 *     are forwarded unchanged, except for model-name alias resolution.
 */
export async function handleChatCompletions(req, res) {
  const startTime = Date.now();
  const reqModel = req.body.model || config.defaultModel;
  const provider = providerFor(reqModel);
  const isCodeBuddy = provider.name === 'codebuddy';
  const wantStream = req.body.stream === true;

  const requestId = makeRequestId();

  if (isCodeBuddy) {
    return handleCodeBuddyRequest({ req, res, reqModel, wantStream, startTime, requestId });
  } else {
    return handlePassthroughRequest({ req, res, reqModel, wantStream, startTime, requestId });
  }
}

// ─── Path A: non-CodeBuddy providers — pure passthrough ────────────────
async function handlePassthroughRequest({ req, res, reqModel, wantStream, startTime, requestId }) {
  // Forward the original body; model-name alias resolution is handled by
  // fetchUpstream → provider.preRequest() which maps the model but preserves
  // everything else (stream flag, messages, tools, temperature, etc.)
  const body = { ...req.body };
  if (!body.model) body.model = reqModel;

  // Debug dump — log what is actually being sent upstream
  dumpRequest('openai-passthrough', requestId, body);

  let upstream;
  try {
    upstream = await fetchUpstream(body);
  } catch (err) {
    console.error('[proxy error]', err?.message || err);
    return res.status(500).json({ error: { message: err?.message || 'Internal proxy error', type: 'proxy_error' } });
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    console.error(`[upstream ${upstream.status}]`, errText);
    return res.status(upstream.status).setHeader('content-type', 'application/json').send(errText);
  }

  // Forward response headers for streaming vs non-streaming
  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  } else {
    res.setHeader('Content-Type', 'application/json');
  }

  // Propagate client disconnect upstream
  res.on('close', () => {
    if (res.writableEnded) return;
    try { upstream.body.cancel?.(); } catch {}
  });

  // Pipe raw bytes from upstream to client
  try {
    const reader = upstream.body.getReader();
    const TIMEOUT = 120_000;
    let lastDataTime = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastDataTime > TIMEOUT) {
        console.error('[stream timeout] passthrough no data');
        try { reader.cancel(); } catch {}
        clearInterval(watchdog);
      }
    }, 10_000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastDataTime = Date.now();
      res.write(value);
    }
    clearInterval(watchdog);
  } catch (e) {
    console.error('[passthrough pipe error]', e.message);
  }

  res.end();
  logRequest({ model: reqModel, startTime });
}

// ─── Path B: CodeBuddy upstream — full adaptation stack ────────────────
async function handleCodeBuddyRequest({ req, res, reqModel, wantStream, startTime, requestId }) {
  // CodeBuddy backend is streaming-only; force stream + usage reporting
  // on the upstream request regardless of what the client asked for.
  const upstreamBody = {
    ...req.body,
    model: reqModel,
    stream: true,
    stream_options: { include_usage: true },
  };

  // CodeBuddy-specific message pre-processing
  if (upstreamBody.messages) {
    normalizeOpenAIMessages(upstreamBody.messages);
    replaceSystemPrompt(upstreamBody.messages);
    upstreamBody.messages = filterContentMessages(upstreamBody.messages);
  }

  dumpRequest('openai-codebuddy', requestId, upstreamBody);

  try {
    const upstream = await fetchUpstream(upstreamBody);
    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`[upstream ${upstream.status}]`, errText);
      return res.status(upstream.status).json({ error: { message: errText, type: 'upstream_error' } });
    }

    if (wantStream) {
      return pipeCodeBuddyStream({ res, upstream, upstreamBody, startTime, requestId });
    } else {
      return aggregateCodeBuddyNonStream({ res, upstream, upstreamBody, startTime, requestId });
    }
  } catch (err) {
    console.error('[proxy error]', err?.message || err);
    res.status(500).json({ error: { message: err?.message || 'Internal proxy error', type: 'proxy_error' } });
  }
}

// ─── CodeBuddy streaming: SSE parsing + field normalization + passthrough
async function pipeCodeBuddyStream({ res, upstream, upstreamBody, startTime, requestId }) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pipeBuf = '';
  let pipeLogLines = [];
  let streamUsage = null;
  let streamModel = upstreamBody.model;
  let sentDone = false;
  let lastDataTime = Date.now();
  let aborted = false;

  // Debug aggregation state
  let _fullContent = '';
  let _fullReasoning = '';
  let _toolCalls = [];
  let _finishReason = null;

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

      pipeBuf += chunk;
      const pipeLines = pipeBuf.split('\n');
      pipeBuf = pipeLines.pop() || '';

      for (const line of pipeLines) {
        const trimmed = line.trim();
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

        // CodeBuddy-specific: strip empty vendor fields
        writeDataEvent(normalizeSSEData(dataStr));
      }

      // Aggregate for debug log
      aggregateChunkForDebug(chunk);
    }

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

  saveOpenAIStreamDebugLog(requestId, streamModel, _finishReason, _fullContent, _fullReasoning, _toolCalls, streamUsage, pipeLogLines);
  logRequest({ model: streamModel, startTime, usage: streamUsage });

  function aggregateChunkForDebug(chunk) {
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

// ─── CodeBuddy non-streaming: aggregate SSE → single JSON response ─────
async function aggregateCodeBuddyNonStream({ res, upstream, upstreamBody, startTime, requestId }) {
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

  saveOpenAINonStreamDebugLog(requestId, id, model, finishReason, fullContent, fullReasoning, toolCalls, usage);
  logRequest({ model, startTime, usage });
}
