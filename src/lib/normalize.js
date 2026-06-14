/**
 * Normalize OpenAI Chat Completions messages for upstream compatibility.
 *
 * Some proxy tools (e.g. ccswitch) produce non-standard OpenAI messages:
 * - assistant.content as an array of text blocks instead of a string
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
 * - user: content CAN be string or array (multimodal).  Left as-is.
 * - tool / system: left as-is.
 */
export function normalizeOpenAIMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  let fixed = 0;

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;

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

  if (fixed > 0) {
    console.log(`\x1b[36m[normalize]\x1b[0m fixed ${fixed} assistant message(s) with array content → string`);
  }

  return messages;
}
