import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { fetchUpstream } from '../lib/upstream.js';
import { logRequest } from '../lib/logger.js';
import { replaceSystemPrompt, filterContentMessages } from '../lib/prompt.js';
import { anthropicToOpenAIMessages, anthropicToOpenAITools, prepareUpstreamBody } from '../convert/anthropic.js';

const LOG_DIR = path.resolve('logs');

/**
 * OpenAI finish_reason → Anthropic stop_reason mapping.
 * Handles both standard OpenAI values and non-standard upstream values.
 */
const STOP_REASON_MAP = {
  // OpenAI standard → Anthropic
  'stop': 'end_turn',
  'tool_calls': 'tool_use',
  'length': 'max_tokens',
  'content_filter': 'end_turn',
  // Already Anthropic-compatible values — pass through
  'end_turn': 'end_turn',
  'tool_use': 'tool_use',
  'max_tokens': 'max_tokens',
};

function mapStopReason(reason) {
  if (!reason) return 'end_turn';
  return STOP_REASON_MAP[reason] ?? 'end_turn';
}

function msgId() {
  return 'msg_' + crypto.randomBytes(20).toString('hex');
}

function sseEvent(event, obj) {
  return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Detect pseudo-XML tool calls in text content and parse them into
 * structured tool_use content blocks.
 *
 * Some models output tool calls as XML-like tags in text instead of
 * using structured function calling:
 *   <tool_calls>
 *   <invoke name="Bash">
 *   <parameter name="command">echo hello</parameter>
 *   </invoke>
 *   </tool_calls>
 *
 * This function extracts those and returns { cleanText, parsedToolCalls }.
 */
function extractPseudoXMLToolCalls(text) {
  if (!text || !text.includes('<tool_calls>') && !text.includes('<invoke')) {
    return { cleanText: text, parsedToolCalls: [] };
  }

  const toolCalls = [];
  let cleanText = text;

  // Pattern: <invoke name="..."><parameter name="...">value</parameter></invoke>
  // Also handle: <tool_call name="..." arguments="..."> format
  const invokePattern = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
  const toolCallPattern = /<tool_call\s+name="([^"]+)"\s+arguments="([^"]*)"\s*\/?>/g;

  let match;
  while ((match = invokePattern.exec(text)) !== null) {
    const name = match[1];
    const paramsRaw = match[2];
    // Extract parameters: <parameter name="key">value</parameter>
    const input = {};
    const paramPattern = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let pm;
    while ((pm = paramPattern.exec(paramsRaw)) !== null) {
      input[pm[1]] = pm[2];
    }
    toolCalls.push({
      id: `toolu_${crypto.randomBytes(12).toString('hex')}`,
      name,
      input,
    });
  }

  while ((match = toolCallPattern.exec(text)) !== null) {
    let input = {};
    try { input = JSON.parse(match[2]); } catch {}
    toolCalls.push({
      id: `toolu_${crypto.randomBytes(12).toString('hex')}`,
      name: match[1],
      input,
    });
  }

  if (toolCalls.length > 0) {
    // Remove the pseudo-XML from text
    cleanText = text
      .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
      .replace(/<invoke\s+name="[^"]+"\s*>[\s\S]*?<\/invoke>/g, '')
      .replace(/<tool_call\s+name="[^"]+"\s+arguments="[^"]*"\s*\/?>/g, '')
      .trim();
    console.log(`\x1b[36m[pseudo-xml]\x1b[0m detected ${toolCalls.length} pseudo-XML tool call(s) in text: ${toolCalls.map(tc => tc.name).join(', ')}`);
  }

  return { cleanText, parsedToolCalls: toolCalls };
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

  const upstreamBody = prepareUpstreamBody(body, openaiMessages, openaiTools);

  // Replace system prompt & filter BEFORE logging, so the log matches the actual upstream request
  replaceSystemPrompt(upstreamBody.messages);
  upstreamBody.messages = filterContentMessages(upstreamBody.messages);

  // Debug dump
  try {
    fs.writeFileSync(path.join(LOG_DIR, 'last-request-anthropic.json'), JSON.stringify(upstreamBody, null, 2));
    console.log(`\x1b[33m[req dump]\x1b[0m ${upstreamBody.messages.length} messages, ${upstreamBody.tools?.length ?? 0} tools → saved to logs/last-request-anthropic.json`);
  } catch {}

  if (body.stream === true) {
    return streamAnthropicResponse({ upstreamBody, res, startTime, model });
  } else {
    return nonStreamAnthropicResponse({ upstreamBody, res, startTime, model });
  }
}

// ─── 流式 Anthropic 响应 ───────────────────────────────────────────────
async function streamAnthropicResponse({ upstreamBody, res, startTime, model }) {
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

  // Block state machine:
  // Anthropic content blocks come in order: thinking → text → tool_use
  // We track which block type is currently open
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

  // Buffer for pseudo-XML tool call detection at stream end
  let _pseudoXMLBuffer = '';

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

          // ── reasoning_content → thinking block ──
          if (delta.reasoning_content) {
            _fullReasoning += delta.reasoning_content;
            if (currentBlockType !== 'thinking') {
              openBlock('thinking');
            }
            res.write(sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIdx,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            }));
          }

          // ── text content → text block ──
          if (delta.content) {
            _fullContent += delta.content;
            _pseudoXMLBuffer += delta.content;  // accumulate for pseudo-XML detection
            if (currentBlockType !== 'text') {
              openBlock('text');
            }
            res.write(sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIdx,
              delta: { type: 'text_delta', text: delta.content },
            }));
          }

          // ── tool_calls → tool_use block ──
          if (delta.tool_calls && delta.tool_calls.length > 0) {
            closeCurrentBlock();  // close any open text/thinking block

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

  // ── Post-stream: detect pseudo-XML tool calls in accumulated text ──
  const { cleanText, parsedToolCalls } = extractPseudoXMLToolCalls(_pseudoXMLBuffer);
  for (const tc of parsedToolCalls) {
    const ai = nextBlockIdx++;
    res.write(sseEvent('content_block_start', {
      type: 'content_block_start',
      index: ai,
      content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
    }));
    res.write(sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: ai,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) },
    }));
    res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: ai }));
  }

  // If we parsed pseudo-XML tool calls, override the stop reason to tool_use
  // (unless there were also structured tool_calls already)
  let stopReason = mapStopReason(finishReason);
  if (parsedToolCalls.length > 0 && toolMap.size === 0) {
    // The model outputted tool calls as text instead of structured format
    // Force stop_reason = tool_use so Claude Code knows there are tool calls
    stopReason = 'tool_use';
    console.log(`\x1b[36m[pseudo-xml]\x1b[0m overriding stop_reason to "tool_use" (detected pseudo-XML tool calls)`);
  }

  // Close all structured tool blocks
  for (const [, ai] of toolMap) {
    res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: ai }));
  }

  res.write(sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  }));

  res.write(sseEvent('message_stop', { type: 'message_stop' }));
  res.end();

  // ── save debug response log ──
  try {
    const totalToolCalls = toolMap.size + parsedToolCalls.length;
    const debugResp = {
      id, model, stop_reason: stopReason,
      raw_finish_reason: finishReason,
      content_text: _fullContent.length > 0 ? _fullContent.length + ' chars' : '(empty)',
      reasoning_text: _fullReasoning.length > 0 ? _fullReasoning.length + ' chars' : '(none)',
      structured_tool_calls: toolMap.size,
      pseudo_xml_tool_calls: parsedToolCalls.length,
      total_tool_calls: totalToolCalls,
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    };
    if (toolMap.size > 0) {
      debugResp.tool_calls = [];
      for (const [oi, ai] of toolMap) {
        debugResp.tool_calls.push({ openai_index: oi, anthropic_index: ai });
      }
    }
    if (parsedToolCalls.length > 0) {
      debugResp.pseudo_xml_tool_calls_detail = parsedToolCalls.map(tc => ({ name: tc.name }));
    }
    fs.writeFileSync(path.join(LOG_DIR, 'last-response-anthropic.json'), JSON.stringify(debugResp, null, 2));
    console.log(`\x1b[33m[anthropic resp]\x1b[0m stop_reason=${stopReason} (raw=${finishReason}) content=${_fullContent.length}chars reasoning=${_fullReasoning.length}chars structured_tools=${toolMap.size} pseudo_xml_tools=${parsedToolCalls.length} → saved to logs/last-response-anthropic.json`);
  } catch { /* ignore */ }

  logRequest({ model, startTime, usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens } });
}

// ─── 非流式 Anthropic 响应 ─────────────────────────────────────────────
async function nonStreamAnthropicResponse({ upstreamBody, res, startTime, model }) {
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
  let fullReasoning = '';
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
        if (delta.reasoning_content) fullReasoning += delta.reasoning_content;
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

  // ── Detect pseudo-XML tool calls in text ──
  const { cleanText, parsedToolCalls } = extractPseudoXMLToolCalls(fullContent);

  // Build Anthropic content blocks in order: thinking → text → tool_use
  const content = [];
  if (fullReasoning) content.push({ type: 'thinking', thinking: fullReasoning });
  if (cleanText) content.push({ type: 'text', text: cleanText });
  for (const tc of toolCalls) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments); } catch {}
    content.push({ type: 'tool_use', id: tc.id || `toolu_${crypto.randomBytes(12).toString('hex')}`, name: tc.function.name, input });
  }
  for (const tc of parsedToolCalls) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }

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
    const totalToolCalls = toolCalls.length + parsedToolCalls.length;
    const debugResp = {
      id, model, stop_reason: stopReason,
      raw_finish_reason: fr,
      content_text: fullContent.length > 0 ? fullContent.length + ' chars' : '(empty)',
      reasoning_text: fullReasoning.length > 0 ? fullReasoning.length + ' chars' : '(none)',
      structured_tool_calls: toolCalls.length,
      pseudo_xml_tool_calls: parsedToolCalls.length,
      total_tool_calls: totalToolCalls,
      usage: { input_tokens: lastChunk?.usage?.prompt_tokens || 0, output_tokens: lastChunk?.usage?.completion_tokens || 0 },
    };
    if (toolCalls.length > 0) {
      debugResp.tool_calls = toolCalls.map(tc => ({ id: tc.id, name: tc.function.name }));
    }
    if (parsedToolCalls.length > 0) {
      debugResp.pseudo_xml_tool_calls_detail = parsedToolCalls.map(tc => ({ name: tc.name }));
    }
    fs.writeFileSync(path.join(LOG_DIR, 'last-response-anthropic.json'), JSON.stringify(debugResp, null, 2));
    console.log(`\x1b[33m[anthropic resp]\x1b[0m stop_reason=${stopReason} (raw=${fr}) content=${fullContent.length}chars reasoning=${fullReasoning.length}chars structured_tools=${toolCalls.length} pseudo_xml_tools=${parsedToolCalls.length} → saved to logs/last-response-anthropic.json`);
  } catch { /* ignore */ }

  logRequest({ model, startTime, usage: lastChunk?.usage });
}
