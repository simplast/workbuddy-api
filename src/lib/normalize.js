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
 * - reasoning_content is PRESERVED. DeepSeek thinking_mode requires it to be
 *   passed back for turns that involved tool calls; stripping it causes 400.
 *   See https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 * - user: content CAN be string or array (multimodal).  Left as-is.
 * - tool / system: left as-is.
 */
export function normalizeOpenAIMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  let fixed = 0;
  let argsFixed = 0;

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

    // NOTE: reasoning_content is intentionally NOT stripped. DeepSeek's
    // thinking_mode spec requires reasoning_content to be replayed for turns
    // that produced tool_calls; removing it triggers a 400 on the next call.
  }

  if (fixed > 0 || argsFixed > 0) {
    const parts = [];
    if (fixed > 0) parts.push(`${fixed} assistant message(s) with array content → string`);
    if (argsFixed > 0) parts.push(`${argsFixed} tool_calls arguments object → string`);
    console.log(`\x1b[36m[normalize]\x1b[0m ${parts.join(', ')}`);
  }

  return messages;
}
