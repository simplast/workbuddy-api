import crypto from 'node:crypto';
import { config } from '../config.js';
import { fetchUpstream } from '../lib/upstream.js';
import { logRequest } from '../lib/logger.js';
import { replaceSystemPrompt, filterContentMessages } from '../lib/prompt.js';
import { anthropicToOpenAIMessages, anthropicToOpenAITools, prepareUpstreamBody } from '../convert/anthropic.js';
import { makeMsgId, mapStopReason, extractPseudoXMLToolCalls, formatAnthropicContent, buildAnthropicDebugResp } from '../convert/anthropic-response.js';
import { readSSEStream, aggregateSSEChunks, sseEvent } from '../lib/sse.js';
import { makeRequestId, dumpRequest, dumpResponse, logResponseSummary } from '../lib/debug.js';

/**
 * POST /v1/messages — Anthropic Messages API endpoint
 */
export async function handleMessages(req, res) {
  const startTime = Date.now();
  const body = req.body;
  const model = body.model || config.defaultModel;

  const openaiMessages = anthropicToOpenAIMessages(body);
  const openaiTools = anthropicToOpenAITools(body.tools);

  const upstreamBody = prepareUpstreamBody(body, openaiMessages, openaiTools);

  // Replace system prompt & filter BEFORE logging, so the log matches the actual upstream request
  replaceSystemPrompt(upstreamBody.messages);
  upstreamBody.messages = filterContentMessages(upstreamBody.messages);

  // Debug dump
  const requestId = makeRequestId();
  dumpRequest('anthropic', requestId, upstreamBody);

  if (body.stream === true) {
    return streamAnthropicResponse({ upstreamBody, res, startTime, model, requestId });
  } else {
    return nonStreamAnthropicResponse({ upstreamBody, res, startTime, model, requestId });
  }
}

// ─── 流式 Anthropic 响应 ───────────────────────────────────────────────
async function streamAnthropicResponse({ upstreamBody, res, startTime, model, requestId }) {
  const id = makeMsgId();

  let upstream;
  try {
    upstream = await fetchUpstream(upstreamBody);
  } catch (err) {
    console.error('[anthropic fetch error]', err?.message || err);
    return res.status(502).json({ type: 'error', error: { type: 'api_error', message: err?.message || 'Upstream fetch failed' } });
  }
  if (!upstream.ok) {
    const errText = await upstream.text();
    return res.status(upstream.status).json({ type: 'error', error: { type: 'api_error', message: errText } });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // message_start
  res.write(sseEvent('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', content: [],
      model, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }));

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let aborted = false;

  // Propagate client disconnect upstream
  res.on('close', () => {
    if (res.writableEnded) return;
    aborted = true;
    try { reader.cancel(); } catch {}
  });

  // Block state machine:
  // Anthropic content blocks come in order: thinking → text → tool_use
  let nextBlockIdx = 0;
  let currentBlockType = null;  // 'thinking' | 'text' | null
  let currentBlockIdx = -1;
  const toolMap = new Map();    // OpenAI tool_call index → Anthropic block index
  let lastOi = 0;
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let _fullContent = '';
  let _fullReasoning = '';
  let lastDataTime = Date.now();

  function closeCurrentBlock() {
    if (currentBlockType) {
      res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIdx }));
      currentBlockType = null;
      currentBlockIdx = -1;
    }
  }

  function openBlock(type) {
    closeCurrentBlock();
    currentBlockIdx = nextBlockIdx++;
    currentBlockType = type;

    if (type === 'thinking') {
      res.write(sseEvent('content_block_start', {
        type: 'content_block_start',
        index: currentBlockIdx,
        content_block: { type: 'thinking', thinking: '' },
      }));
    } else if (type === 'text') {
      res.write(sseEvent('content_block_start', {
        type: 'content_block_start',
        index: currentBlockIdx,
        content_block: { type: 'text', text: '' },
      }));
    }
  }

  const TIMEOUT = 120_000;
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataTime > TIMEOUT) {
      console.error('[anthropic timeout]');
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

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const t = line.trim();
        const dataMatch = t.match(/^data:\s?(.*)$/);
        if (!dataMatch) continue;
        const d = dataMatch[1];
        if (d === '[DONE]') continue;

        try {
          const chunk = JSON.parse(d);
          if (chunk.usage) {
            usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
            usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          finishReason = choice.finish_reason || finishReason;

          // ── reasoning_content → thinking block ──
          if (delta.reasoning_content) {
            _fullReasoning += delta.reasoning_content;
            if (currentBlockType !== 'thinking') openBlock('thinking');
            res.write(sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIdx,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            }));
          }

          // ── text content → text block ──
          if (delta.content) {
            _fullContent += delta.content;
            if (currentBlockType !== 'text') openBlock('text');
            res.write(sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIdx,
              delta: { type: 'text_delta', text: delta.content },
            }));
          }

          // ── tool_calls → tool_use block ──
          if (delta.tool_calls && delta.tool_calls.length > 0) {
            closeCurrentBlock();

            for (const tc of delta.tool_calls) {
              const oi = tc.index ?? lastOi;
              if (tc.index != null) lastOi = tc.index;

              if (!toolMap.has(oi)) {
                const ai = nextBlockIdx++;
                toolMap.set(oi, ai);
                res.write(sseEvent('content_block_start', {
                  type: 'content_block_start',
                  index: ai,
                  content_block: {
                    type: 'tool_use',
                    id: tc.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
                    name: tc.function?.name || '',
                    input: {},
                  },
                }));
              }

              if (tc.function?.arguments) {
                res.write(sseEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: toolMap.get(oi),
                  delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                }));
              }
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch (e) {
    console.error('[anthropic stream error]', e.message);
  } finally {
    clearInterval(watchdog);
  }

  // Close any open text/thinking block
  closeCurrentBlock();

  // Pseudo-XML tool call detection is disabled in streaming mode.
  const stopReason = mapStopReason(finishReason);

  // Close all structured tool blocks
  for (const [, ai] of toolMap) {
    res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: ai }));
  }

  if (!aborted) {
    res.write(sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    }));
    res.write(sseEvent('message_stop', { type: 'message_stop' }));
  }
  res.end();

  // ── save debug response log ──
  try {
    const debugResp = buildAnthropicDebugResp({
      id, model, stopReason, rawFinishReason: finishReason,
      contentLen: _fullContent.length, reasoningLen: _fullReasoning.length,
      structuredToolCalls: toolMap.size, pseudoXmlToolCalls: 0,
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    });
    if (toolMap.size > 0) {
      debugResp.tool_calls = [];
      for (const [oi, ai] of toolMap) {
        debugResp.tool_calls.push({ openai_index: oi, anthropic_index: ai });
      }
    }
    dumpResponse('anthropic', requestId, debugResp);
    logResponseSummary('anthropic', {
      finishReason: stopReason, contentLen: _fullContent.length, reasoningLen: _fullReasoning.length,
      extraInfo: `structured_tools=${toolMap.size}`, requestId,
    });
  } catch { /* ignore */ }

  logRequest({ model, startTime, usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens } });
}

// ─── 非流式 Anthropic 响应 ─────────────────────────────────────────────
async function nonStreamAnthropicResponse({ upstreamBody, res, startTime, model, requestId }) {
  const id = makeMsgId();

  let upstream;
  try {
    upstream = await fetchUpstream(upstreamBody);
  } catch (err) {
    console.error('[anthropic fetch error]', err?.message || err);
    return res.status(502).json({ type: 'error', error: { type: 'api_error', message: err?.message || 'Upstream fetch failed' } });
  }
  if (!upstream.ok) {
    const errText = await upstream.text();
    return res.status(upstream.status).json({ type: 'error', error: { type: 'api_error', message: errText } });
  }

  // Reuse SSE aggregation utilities
  const reader = upstream.body.getReader();
  const agg = aggregateSSEChunks();
  await readSSEStream(reader, {
    onChunk: (parsed) => agg.handleChunk(parsed),
  });

  const { fullContent, fullReasoning, toolCalls, lastChunk } = agg.getResult();

  // Detect pseudo-XML tool calls in text
  const { cleanText, parsedToolCalls } = extractPseudoXMLToolCalls(fullContent);

  // Build Anthropic content blocks
  const content = formatAnthropicContent(fullReasoning, cleanText, toolCalls, parsedToolCalls);

  const fr = lastChunk?.choices?.[0]?.finish_reason;
  let stopReason = mapStopReason(fr);
  if (parsedToolCalls.length > 0 && toolCalls.length === 0) {
    stopReason = 'tool_use';
  }

  res.json({
    id, type: 'message', role: 'assistant', content, model,
    stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: lastChunk?.usage?.prompt_tokens || 0, output_tokens: lastChunk?.usage?.completion_tokens || 0 },
  });

  // ── save debug response log ──
  try {
    const debugResp = buildAnthropicDebugResp({
      id, model, stopReason, rawFinishReason: fr,
      contentLen: fullContent.length, reasoningLen: fullReasoning.length,
      structuredToolCalls: toolCalls.length, pseudoXmlToolCalls: parsedToolCalls.length,
      usage: { input_tokens: lastChunk?.usage?.prompt_tokens || 0, output_tokens: lastChunk?.usage?.completion_tokens || 0 },
    });
    if (toolCalls.length > 0) {
      debugResp.tool_calls = toolCalls.map(tc => ({ id: tc.id, name: tc.function.name }));
    }
    if (parsedToolCalls.length > 0) {
      debugResp.pseudo_xml_tool_calls_detail = parsedToolCalls.map(tc => ({ name: tc.name }));
    }
    dumpResponse('anthropic', requestId, debugResp);
    logResponseSummary('anthropic', {
      finishReason: stopReason, contentLen: fullContent.length, reasoningLen: fullReasoning.length,
      extraInfo: `structured_tools=${toolCalls.length} pseudo_xml_tools=${parsedToolCalls.length}`, requestId,
    });
  } catch { /* ignore */ }

  logRequest({ model, startTime, usage: lastChunk?.usage });
}
