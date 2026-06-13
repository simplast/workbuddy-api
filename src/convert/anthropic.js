/**
 * Anthropic Messages API ↔ OpenAI Chat Completions 格式转换
 * Pure conversion functions — no I/O, no side effects.
 */

/**
 * Anthropic request body → OpenAI messages array
 */
export function anthropicToOpenAIMessages(body) {
  const messages = [];

  // system prompt: Anthropic 用顶层字段，OpenAI 用 role:"system"
  if (body.system) {
    const text = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : '';
    if (text) messages.push({ role: 'system', content: text });
  }

  for (const msg of body.messages || []) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        const toolResults = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_result') {
            const content = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter(b => b.type === 'text').map(b => b.text).join('')
                : '';
            toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
          } else if (block.type === 'image') {
            textParts.push('[image]');
          }
        }

        if (textParts.length > 0) messages.push({ role: 'user', content: textParts.join('\n') });
        for (const tr of toolResults) messages.push(tr);
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        const toolCalls = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
            });
          }
        }

        const m = { role: 'assistant', content: textParts.length > 0 ? textParts.join('\n') : null };
        if (toolCalls.length > 0) m.tool_calls = toolCalls;
        messages.push(m);
      }
    }
  }

  return messages;
}

/**
 * Anthropic tools → OpenAI tools
 */
export function anthropicToOpenAITools(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  return tools
    .filter(t => !t.type || t.type === 'custom')
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
}

/**
 * OpenAI tool_choice ← Anthropic tool_choice
 */
export function mapToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === 'any') return 'required';
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}
