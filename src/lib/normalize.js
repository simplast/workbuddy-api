import { logDiag } from './logger.js';

/**
 * Normalize OpenAI Chat Completions messages for upstream compatibility.
 *
 * Some proxy tools (e.g. ccswitch) produce non-standard OpenAI messages:
 * - assistant.content as an array of text blocks instead of a string
 * - tool_calls[].function.arguments as a JSON object instead of a string
 * - user.content arrays left intact (which is actually valid for multimodal)
 *
 * This module fixes those issues before forwarding to the upstream model.
 */

/**
 * Normalize messages in-place so the upstream model receives spec-compliant
 * OpenAI Chat Completions format.
 *
 * Rules:
 * - assistant: content MUST be string | null.  Array of text blocks → joined string.
 * - assistant.tool_calls[].function.arguments: MUST be string (JSON-serialized). Object → string.
 * - assistant reasoning is renamed to the field CodeBuddy actually reads (`reasoning`).
 *   See the note on `normalizeReasoningField` below.
 * - user: content CAN be string or array (multimodal).  Left as-is.
 * - tool / system: left as-is.
 */
export function normalizeOpenAIMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  let fixed = 0;
  let argsFixed = 0;
  let reasoningRenamed = 0;
  let reasoningDropped = 0;

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    // Fix content: array of text blocks → string
    if (Array.isArray(msg.content)) {
      // Merge text blocks into a single string
      const text = msg.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');

      // Preserve empty string (vs. null) so downstream can distinguish
      // "assistant said nothing" from "no content field at all"
      msg.content = text;
      fixed++;
    }

    // Fix tool_calls: function.arguments object → JSON string
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.function?.arguments != null && typeof tc.function.arguments !== 'string') {
          tc.function.arguments = JSON.stringify(tc.function.arguments);
          argsFixed++;
        }
      }
    }

    const reasoning = normalizeReasoningField(msg);
    if (reasoning === 'renamed') reasoningRenamed++;
    else if (reasoning === 'dropped') reasoningDropped++;
  }

  if (fixed > 0 || argsFixed > 0 || reasoningRenamed > 0 || reasoningDropped > 0) {
    const parts = [];
    if (fixed > 0) parts.push(`${fixed} assistant message(s) with array content → string`);
    if (argsFixed > 0) parts.push(`${argsFixed} tool_calls arguments object → string`);
    if (reasoningRenamed > 0) parts.push(`${reasoningRenamed} assistant reasoning_content → reasoning`);
    if (reasoningDropped > 0) parts.push(`${reasoningDropped} empty reasoning_content dropped`);
    logDiag('[normalize]', parts.join(', '));
  }

  return messages;
}

/**
 * Rename assistant `reasoning_content` to `reasoning`, the field CodeBuddy's
 * gateway actually reads.
 *
 * The upstream emits prior-turn thinking as `reasoning_content` SSE deltas,
 * so clients that replay our stream verbatim send `reasoning_content` back.
 * The gateway silently ignores that field — verified by replaying captured
 * CodeBuddy CLI v2.122.0 requests against copilot.tencent.com/v2:
 *
 *   reasoning_content +990 chars   → prompt_tokens Δ 0
 *   reasoning_content +9900 chars  → prompt_tokens Δ 0
 *   reasoning          +990 chars  → prompt_tokens Δ +220 (when `tools` present)
 *   reasoning          +9900 chars → prompt_tokens Δ +2200 (when `tools` present)
 *
 * The CLI itself only ever sends `reasoning`; its bundled
 * `reasoning-content-backfill` rule is gated on the
 * `requiresReasoningContentOnAssistantMessages` capability, which CodeBuddy
 * product-config models (e.g. deepseek-v4.1-flash) do not declare. So we must
 * not rely on the upstream to bridge the two names — doing so makes the model
 * blind to its own previous reasoning in multi-turn conversations.
 *
 * `reasoning_content` is dropped rather than kept alongside: the gateway
 * ignores it today, and if it were ever honored too we would be replaying the
 * same trace twice.
 *
 * @returns {'renamed'|'dropped'|null} what was done, for diagnostics
 */
function normalizeReasoningField(msg) {
  if (!('reasoning_content' in msg)) return null;

  const rc = msg.reasoning_content;
  const incoming = typeof rc === 'string' && rc.length > 0;
  const existing = typeof msg.reasoning === 'string' && msg.reasoning.length > 0;

  // `reasoning` is what the gateway reads; only fill it from
  // reasoning_content when the message doesn't already carry one.
  if (incoming && !existing) msg.reasoning = rc;

  // Dropped either way: the gateway ignores it, and keeping a duplicate would
  // replay the same trace twice if that ever changed. Empty values go too, so
  // the payload matches the CLI instead of carrying dead weight.
  delete msg.reasoning_content;
  return incoming ? 'renamed' : 'dropped';
}
