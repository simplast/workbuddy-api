/**
 * @deprecated Since refactoring to pure passthrough on /v1/messages.
 * This module is no longer used by any route handler. It is kept for
 * reference — if you need Anthropic ↔ OpenAI conversion in the future,
 * the logic is here and tested.
 *
 * Anthropic Messages API ↔ OpenAI Chat Completions 格式转换
 * Pure conversion functions — no I/O, no side effects.
 */

/**
 * Anthropic request body → OpenAI messages array
 *
 * Handles:
 * - system prompt (top-level → role:"system")
 * - user messages: string, text blocks, image blocks, tool_result blocks
 * - assistant messages: string, text blocks, thinking blocks, tool_use blocks
 * - cache_control fields are stripped (not supported by OpenAI)
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
    // Strip cache_control from message level
    const cleanedMsg = { ...msg };
    delete cleanedMsg.cache_control;

    if (cleanedMsg.role === 'user') {
      if (typeof cleanedMsg.content === 'string') {
        messages.push({ role: 'user', content: cleanedMsg.content });
      } else if (Array.isArray(cleanedMsg.content)) {
        // Build OpenAI multimodal content array or separate messages
        const contentParts = [];   // multimodal parts for a single user message
        const toolResults = [];     // tool_result → separate tool messages

        for (const block of cleanedMsg.content) {
          // Strip cache_control from each block
          const b = { ...block };
          delete b.cache_control;

          if (b.type === 'text') {
            contentParts.push({ type: 'text', text: b.text });
          } else if (b.type === 'image') {
            // Convert Anthropic image block → OpenAI image_url
            // Anthropic: { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
            // OpenAI:    { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
            if (b.source && b.source.type === 'base64' && b.source.data) {
              const mediaType = b.source.media_type || 'image/png';
              contentParts.push({
                type: 'image_url',
                image_url: { url: `data:${mediaType};base64,${b.source.data}` },
              });
            } else if (b.source && b.source.type === 'url' && b.source.url) {
              contentParts.push({
                type: 'image_url',
                image_url: { url: b.source.url },
              });
            } else {
              // Fallback: describe as text if we can't extract image data
              contentParts.push({ type: 'text', text: '[image]' });
            }
          } else if (b.type === 'tool_result') {
            // tool_result → separate { role: "tool", tool_call_id, content } message
            const resultContent = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content.filter(rb => rb.type === 'text').map(rb => rb.text).join('\n')
                : '';
            toolResults.push({ role: 'tool', tool_call_id: b.tool_use_id, content: resultContent });
          }
        }

        // Combine content parts into a user message
        if (contentParts.length > 0) {
          // If only text parts, simplify to a string
          const onlyText = contentParts.every(p => p.type === 'text');
          if (onlyText) {
            messages.push({ role: 'user', content: contentParts.map(p => p.text).join('\n') });
          } else {
            messages.push({ role: 'user', content: contentParts });
          }
        }

        // Add tool results as separate messages
        for (const tr of toolResults) messages.push(tr);
      }
    } else if (cleanedMsg.role === 'assistant') {
      if (typeof cleanedMsg.content === 'string') {
        messages.push({ role: 'assistant', content: cleanedMsg.content });
      } else if (Array.isArray(cleanedMsg.content)) {
        const textParts = [];
        let reasoningContent = '';
        const toolCalls = [];

        for (const block of cleanedMsg.content) {
          const b = { ...block };
          delete b.cache_control;

          if (b.type === 'text') {
            textParts.push(b.text);
          } else if (b.type === 'thinking') {
            // Anthropic thinking block → OpenAI reasoning_content
            reasoningContent += b.thinking || '';
          } else if (b.type === 'tool_use') {
            toolCalls.push({
              id: b.id,
              type: 'function',
              function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
            });
          }
          // Ignore unknown block types (e.g. redacted_thinking)
        }

        const m = { role: 'assistant', content: textParts.length > 0 ? textParts.join('\n') : null };
        if (reasoningContent) m.reasoning_content = reasoningContent;
        if (toolCalls.length > 0) m.tool_calls = toolCalls;
        messages.push(m);
      }
    }
    // Other roles (tool, system) — strip cache_control at block level
    else {
      if (Array.isArray(cleanedMsg.content)) {
        cleanedMsg.content = cleanedMsg.content.map((b) => {
          if (b && typeof b === 'object') {
            const { cache_control, ...rest } = b;
            return rest;
          }
          return b;
        });
      }
      messages.push(cleanedMsg);
    }
  }

  return messages;
}

/**
 * Anthropic tools → OpenAI tools
 */
export function anthropicToOpenAITools(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  const skipped = tools.filter(t => t.type && t.type !== 'custom');
  if (skipped.length > 0) {
    const types = skipped.map(t => t.type).join(', ');
    console.warn(`\x1b[33m[tools]\x1b[0m dropped ${skipped.length} non-custom tool(s) (type=${types}); only custom tools are supported`);
  }
  return tools
    .filter(t => !t.type || t.type === 'custom')
    .map(t => {
      const tool = {
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      };
      // Strip cache_control from tool definition
      delete tool.cache_control;
      return tool;
    });
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

/**
 * Prepare upstream body from Anthropic request.
 * Strips Anthropic-specific fields that upstream doesn't understand.
 * Maps thinking config if applicable.
 */
export function prepareUpstreamBody(body, openaiMessages, openaiTools) {
  const model = body.model || 'default';
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

  // Anthropic thinking config → upstream
  // Anthropic: { thinking: { type: "enabled", budget_tokens: N } }
  // Map budget_tokens to OpenAI-style reasoning_effort so upstream models
  // that support it (z-ai/glm, etc.) can honor the budget.
  if (body.thinking?.type === 'enabled') {
    const budget = body.thinking.budget_tokens;
    let effort = 'medium';
    if (typeof budget === 'number') {
      if (budget <= 2048) effort = 'low';
      else if (budget <= 8192) effort = 'medium';
      else effort = 'high';
    }
    upstreamBody.reasoning_effort = effort;
    console.log(`\x1b[36m[anthropic]\x1b[0m thinking enabled (budget_tokens=${budget}) → reasoning_effort=${effort}`);
  }

  return upstreamBody;
}
