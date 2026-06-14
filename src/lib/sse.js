/**
 * SSE stream parsing utilities.
 * Used by both OpenAI and Anthropic route handlers.
 */

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
 * Returns { fullContent, fullReasoning, toolCalls, lastChunk, id, model, created }.
 */
export function aggregateSSEChunks() {
  let fullContent = '';
  let fullReasoning = '';
  let toolCalls = [];
  let lastChunk = null;
  let id = '';
  let model = '';
  let created = 0;

  const handleChunk = (parsed) => {
    lastChunk = parsed;
    if (parsed.id) id = parsed.id;
    if (parsed.model) model = parsed.model;
    if (typeof parsed.created === 'number') created = parsed.created;

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
  });

  return { handleChunk, getResult };
}
