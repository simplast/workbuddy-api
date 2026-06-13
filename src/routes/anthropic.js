import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { fetchUpstream } from '../lib/upstream.js';
import { logRequest } from '../lib/logger.js';
import { getCustomSystemPrompt, filterContentMessages } from '../lib/prompt.js';
import { anthropicToOpenAIMessages, anthropicToOpenAITools, mapToolChoice } from '../convert/anthropic.js';

const LOG_DIR = path.resolve('logs');

function msgId() {
  return 'msg_' + crypto.randomBytes(20).toString('hex');
}

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseEvent(event, obj) {
  return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/**
 * POST /v1/messages — Anthropic Messages API endpoint
 */
export async function handleMessages(req, res) {
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

  // Debug dump
  try {
    fs.writeFileSync(path.join(LOG_DIR, 'last-request-anthropic.json'), JSON.stringify(upstreamBody, null, 2));
  } catch {}

  if (body.stream === true) {
    return streamAnthropicResponse({ upstreamBody, res, startTime, model });
  } else {
    return nonStreamAnthropicResponse({ upstreamBody, res, startTime, model });
  }
}

// ─── 流式 Anthropic 响应 ───────────────────────────────────────────────
async function streamAnthropicResponse({ upstreamBody, res, startTime, model }) {
  const customSystemPrompt = getCustomSystemPrompt();

  if (customSystemPrompt) {
    const sysIdx = upstreamBody.messages.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) upstreamBody.messages[sysIdx].content = customSystemPrompt;
  }

  upstreamBody.messages = filterContentMessages(upstreamBody.messages);

  const id = msgId();

  const upstream = await fetchUpstream(upstreamBody);
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

  let nextBlockIdx = 0;
  let textBlockIdx = -1;
  let textOpen = false;
  const toolMap = new Map();
  let lastOi = 0;
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let lastDataTime = Date.now();

  const TIMEOUT = 120_000;
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataTime > TIMEOUT) {
      console.error('[anthropic timeout]');
      try { reader.cancel(); } catch {}
      res.write(sseEvent('message_stop', { type: 'message_stop' }));
      res.end();
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
        if (!t.startsWith('data: ')) continue;
        const d = t.slice(6);
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

          // 文本内容
          if (delta.content) {
            if (!textOpen) {
              textBlockIdx = nextBlockIdx++;
              textOpen = true;
              res.write(sseEvent('content_block_start', {
                type: 'content_block_start',
                index: textBlockIdx,
                content_block: { type: 'text', text: '' },
              }));
            }
            res.write(sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: textBlockIdx,
              delta: { type: 'text_delta', text: delta.content },
            }));
          }

          // tool calls
          if (delta.tool_calls && delta.tool_calls.length > 0) {
            if (textOpen) {
              res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIdx }));
              textOpen = false;
            }

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

  // 关闭文本块
  if (textOpen) {
    res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIdx }));
  }

  // 关闭所有 tool 块
  for (const [, ai] of toolMap) {
    res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: ai }));
  }

  let stopReason = 'end_turn';
  if (finishReason === 'tool_calls') stopReason = 'tool_use';
  else if (finishReason === 'length') stopReason = 'max_tokens';

  res.write(sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  }));

  res.write(sseEvent('message_stop', { type: 'message_stop' }));
  res.end();

  logRequest({ model, startTime, usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens } });
}

// ─── 非流式 Anthropic 响应 ─────────────────────────────────────────────
async function nonStreamAnthropicResponse({ upstreamBody, res, startTime, model }) {
  const customSystemPrompt = getCustomSystemPrompt();

  if (customSystemPrompt) {
    const sysIdx = upstreamBody.messages.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) upstreamBody.messages[sysIdx].content = customSystemPrompt;
  }

  upstreamBody.messages = filterContentMessages(upstreamBody.messages);

  const id = msgId();

  const upstream = await fetchUpstream(upstreamBody);
  if (!upstream.ok) {
    const errText = await upstream.text();
    return res.status(upstream.status).json({ type: 'error', error: { type: 'api_error', message: errText } });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let fullContent = '';
  let toolCalls = [];
  let lastChunk = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const d = t.slice(6);
      if (d === '[DONE]') continue;
      try {
        const parsed = JSON.parse(d);
        lastChunk = parsed;
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) fullContent += delta.content;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? toolCalls.length;
            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name && !toolCalls[idx].function.name) toolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      } catch { /* skip */ }
    }
  }

  const usage = lastChunk?.usage || { prompt_tokens: 0, completion_tokens: 0 };
  const content = [];
  if (fullContent) content.push({ type: 'text', text: fullContent });
  for (const tc of toolCalls) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments); } catch {}
    content.push({ type: 'tool_use', id: tc.id || `toolu_${crypto.randomBytes(12).toString('hex')}`, name: tc.function.name, input });
  }

  let stopReason = 'end_turn';
  const fr = lastChunk?.choices?.[0]?.finish_reason;
  if (fr === 'tool_calls') stopReason = 'tool_use';
  else if (fr === 'length') stopReason = 'max_tokens';

  res.json({
    id, type: 'message', role: 'assistant', content, model,
    stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  });

  logRequest({ model, startTime, usage });
}
