/**
 * SSE stream parsing utilities.
 * Used by both OpenAI and Anthropic route handlers.
 */

/**
 * Normalize OpenAI SSE data by stripping empty vendor fields.
 *
 * CodeBuddy upstream emits several empty vendor fields. ccswitch turns
 * `reasoning_content: ""` into empty Anthropic thinking blocks, which can
 * truncate Claude Code's visible response. Strip only empty/null extras and
 * preserve real OpenAI fields and finish_reason values.
 */
export function normalizeSSEData(dataStr) {
  try {
    const obj = JSON.parse(dataStr);
    const choice = obj.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};

      if (delta.reasoning_content === '') delete delta.reasoning_content;
      if (delta.content === '') delete delta.content;
      if (
        delta.function_call == null ||
        (delta.function_call.name === '' && delta.function_call.arguments === '')
      ) {
        delete delta.function_call;
      }
      if (delta.refusal === '') delete delta.refusal;
      if (delta.extra_fields == null) delete delta.extra_fields;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0) delete delta.tool_calls;

      if (choice.finish_reason === '') choice.finish_reason = null;
    }
    return JSON.stringify(obj);
  } catch { /* not JSON, pass through */ }
  return dataStr;
}

/**
 * Read SSE stream and parse chunks, calling callbacks for each event.
 * Handles watchdog timeout and cleanup.
 */
export async function readSSEStream(reader, { onChunk, onDone, onError, timeoutMs = 120_000 }) {
  const decoder = new TextDecoder();
  let buffer = '';
  let lastDataTime = Date.now();
  let timedOut = false;

  const watchdog = setInterval(() => {
    if (Date.now() - lastDataTime > timeoutMs) {
      console.error(`[stream timeout] no data for ${timeoutMs}ms`);
      timedOut = true;
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
        const trimmed = line.trim();
        const dataMatch = trimmed.match(/^data:\s?(.*)$/);
        if (!dataMatch) continue;
        const data = dataMatch[1];
        if (data === '[DONE]') {
          onDone?.();
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          onChunk?.(parsed);
        } catch { /* skip malformed chunks */ }
      }
    }
    if (timedOut) onError?.(new Error('Stream timeout'));
  } catch (e) {
    // reader.cancel() from the watchdog surfaces here as an AbortError.
    // Report the timeout once; suppress the duplicate cancel-induced rejection.
    if (!timedOut) onError?.(e);
    else onError?.(new Error('Stream timeout'));
  } finally {
    clearInterval(watchdog);
  }
}

/**
 * Aggregate SSE chunks into a complete response object.
 * Returns { fullContent, fullReasoning, toolCalls, lastChunk, id, model, created, usage }.
 */
export function aggregateSSEChunks() {
  let fullContent = '';
  let fullReasoning = '';
  let toolCalls = [];
  let lastChunk = null;
  let id = '';
  let model = '';
  let created = 0;
  let usage = null;

  const handleChunk = (parsed) => {
    lastChunk = parsed;
    if (parsed.id) id = parsed.id;
    if (parsed.model) model = parsed.model;
    if (typeof parsed.created === 'number') created = parsed.created;
    if (parsed.usage) usage = parsed.usage;

    const choice = parsed.choices?.[0];
    if (!choice) return;

    const delta = choice.delta || {};
    if (delta.content) fullContent += delta.content;
    if (delta.reasoning_content) fullReasoning += delta.reasoning_content;

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? toolCalls.length;
        if (!toolCalls[idx]) {
          toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
        }
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name && !toolCalls[idx].function.name) toolCalls[idx].function.name = tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
  };

  const getResult = () => ({
    fullContent,
    fullReasoning,
    toolCalls,
    lastChunk,
    id,
    model,
    created,
    usage,
  });

  return { handleChunk, getResult };
}
