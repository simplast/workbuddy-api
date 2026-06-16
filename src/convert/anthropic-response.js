/**
 * OpenAI → Anthropic response conversion.
 * Pure conversion functions — no I/O, no side effects.
 */
import crypto from 'node:crypto';

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

export function mapStopReason(reason) {
  if (!reason) return 'end_turn';
  return STOP_REASON_MAP[reason] ?? 'end_turn';
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
export function extractPseudoXMLToolCalls(text) {
  if (!text || (!text.includes('<tool_calls>') && !text.includes('<invoke') && !text.includes('<tool_call'))) {
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
 * Build Anthropic content blocks in order: thinking → text → tool_use.
 * Used by the non-streaming Anthropic response handler.
 */
export function formatAnthropicContent(fullReasoning, cleanText, toolCalls, parsedToolCalls) {
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
  return content;
}

/**
 * Build a debug response summary object for Anthropic responses.
 */
export function buildAnthropicDebugResp({ id, model, stopReason, rawFinishReason, contentLen, reasoningLen, structuredToolCalls, pseudoXmlToolCalls, usage }) {
  const debugResp = {
    id, model, stop_reason: stopReason,
    raw_finish_reason: rawFinishReason,
    content_text: contentLen > 0 ? contentLen + ' chars' : '(empty)',
    reasoning_text: reasoningLen > 0 ? reasoningLen + ' chars' : '(none)',
    structured_tool_calls: structuredToolCalls,
    pseudo_xml_tool_calls: pseudoXmlToolCalls,
    total_tool_calls: structuredToolCalls + pseudoXmlToolCalls,
    usage,
  };
  return debugResp;
}
