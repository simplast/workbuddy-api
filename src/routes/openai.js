import { config } from "../config.js";
import { fetchUpstream } from "../lib/upstream.js";
import { logRequest } from "../lib/logger.js";
import { replaceSystemPrompt, filterContentMessages } from "../lib/prompt.js";
import { normalizeOpenAIMessages } from "../lib/normalize.js";
import {
  readSSEStream,
  aggregateSSEChunks,
  normalizeSSEData,
} from "../lib/sse.js";
import {
  makeRequestId,
  dumpRequest,
  saveOpenAIStreamDebugLog,
  saveOpenAINonStreamDebugLog,
  CAPTURE_FULL_SSE_DEBUG,
} from "../lib/debug.js";

/**
 * POST /v1/chat/completions — OpenAI-compatible endpoint
 *
 * Sole upstream is CodeBuddy: prompt replacement, CLI headers, SSE field
 * normalization, and forced-stream aggregation for non-stream clients.
 */
export async function handleChatCompletions(req, res) {
  const startTime = Date.now();
  const reqModel = req.body.model || config.defaultModel;
  const wantStream = req.body.stream === true;

  const requestId = makeRequestId();

  return handleCodeBuddyRequest({
    req,
    res,
    reqModel,
    wantStream,
    startTime,
    requestId,
  });
}

// ─── CodeBuddy upstream — full adaptation stack ────────────────────────
async function handleCodeBuddyRequest({
  req,
  res,
  reqModel,
  wantStream,
  startTime,
  requestId,
}) {
  // CodeBuddy backend is streaming-only; force stream + usage reporting
  // on the upstream request regardless of what the client asked for.
  const upstreamBody = {
    ...req.body,
    model: reqModel,
    stream: true,
    stream_options: { include_usage: true },
  };

  // CodeBuddy backend (Go) only accepts tool_choice as a plain string
  // ("auto"/"none"/"required"). Force "auto" for any non-string value.
  if (upstreamBody.tool_choice != null && typeof upstreamBody.tool_choice !== "string") {
    upstreamBody.tool_choice = "auto";
  }

  // CodeBuddy's Go JSON Schema parser doesn't support `anyOf`, `const`,
  // or `$schema` in tool function parameters. Strip these out.
  // Also reject empty parameters objects — fill with a minimal schema.
  if (upstreamBody.tools) {
    for (const tool of upstreamBody.tools) {
      if (tool?.function?.parameters) {
        sanitizeSchema(tool.function.parameters);
        if (!tool.function.parameters.properties && !tool.function.parameters.type) {
          tool.function.parameters = { type: "object", properties: {} };
        }
      }
    }
  }

  // CodeBuddy-specific message pre-processing
  if (upstreamBody.messages) {
    normalizeOpenAIMessages(upstreamBody.messages);
    replaceSystemPrompt(upstreamBody.messages);
    upstreamBody.messages = filterContentMessages(upstreamBody.messages);
  }

  // Thinking params are passed through untouched.
  // We deliberately do NOT inject reasoning_effort: the proxy stays a transparent
  // pipe, and the downstream picks effort from the levels we advertise in
  // /v1/models (supported_efforts), which mirror CodeBuddy's own config. Injecting
  // a default here would silently override a downstream that intentionally left
  // reasoning off. See docs/codebuddy-thinking-analysis.md for background.

  // Intercept standalone web_search: call CodeBuddy's search API directly
  // instead of routing to the LLM. Claude Code sends these as single-tool
  // requests and expects real search results back.
  const webSearchResult = await interceptWebSearch(upstreamBody);
  if (webSearchResult) {
    const model = upstreamBody.model;
    return res.json(makeFakeChatCompletion({
      id: "search-" + requestId,
      model,
      body: upstreamBody,
      content: webSearchResult,
    }));
  }

  dumpRequest("openai-codebuddy", requestId, upstreamBody);

  try {
    const upstream = await fetchUpstream(upstreamBody);
    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`[upstream ${upstream.status}]`, errText);
      return res
        .status(upstream.status)
        .json({ error: { message: `Upstream error (${upstream.status})`, type: "upstream_error" } });
    }

    if (wantStream) {
      return pipeCodeBuddyStream({
        res,
        upstream,
        upstreamBody,
        startTime,
        requestId,
      });
    } else {
      return aggregateCodeBuddyNonStream({
        res,
        upstream,
        upstreamBody,
        startTime,
        requestId,
      });
    }
  } catch (err) {
    console.error("[proxy error]", err?.message || err);
    res.status(500).json({
      error: {
        message: err?.message || "Internal proxy error",
        type: "proxy_error",
      },
    });
  }
}

// ─── CodeBuddy streaming: SSE parsing + field normalization + pipe to client
async function pipeCodeBuddyStream({
  res,
  upstream,
  upstreamBody,
  startTime,
  requestId,
}) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pipeBuf = "";
  let pipeLogLines = CAPTURE_FULL_SSE_DEBUG ? [] : null;
  let streamUsage = null;
  let streamModel = upstreamBody.model;
  let sentDone = false;
  let lastDataTime = Date.now();
  let aborted = false;

  // Debug aggregation state
  let _fullContent = "";
  let _fullReasoning = "";
  let _toolCalls = [];
  let _finishReason = null;

  res.on("close", () => {
    if (res.writableEnded) return;
    aborted = true;
    try {
      reader.cancel();
    } catch {}
  });

  function writeDataEvent(dataStr) {
    const line = `data: ${dataStr}\n\n`;
    if (pipeLogLines) pipeLogLines.push(line);
    res.write(line);
  }

  const STREAM_TIMEOUT = 120_000;
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataTime > STREAM_TIMEOUT) {
      console.error(`[stream timeout] no data for ${STREAM_TIMEOUT}ms`);
      aborted = true;
      try {
        reader.cancel();
      } catch {}
      clearInterval(watchdog);
    }
  }, 10_000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastDataTime = Date.now();
      const chunk = decoder.decode(value, { stream: true });

      pipeBuf += chunk;
      const pipeLines = pipeBuf.split("\n");
      pipeBuf = pipeLines.pop() || "";

      for (const line of pipeLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const dataMatch = trimmed.match(/^data:\s?(.*)$/);
        if (!dataMatch) {
          res.write(`${line}\n`);
          continue;
        }

        const dataStr = dataMatch[1];
        if (dataStr === "[DONE]") {
          sentDone = true;
          writeDataEvent("[DONE]");
          continue;
        }

        // CodeBuddy-specific: strip empty vendor fields
        writeDataEvent(normalizeSSEData(dataStr));
      }

      // Aggregate for debug log
      aggregateChunkForDebug(chunk);
    }

    if (pipeBuf.trim()) {
      const trimmed = pipeBuf.trim();
      const dataMatch = trimmed.match(/^data:\s?(.*)$/);
      if (dataMatch) {
        const dataStr = dataMatch[1];
        if (dataStr === "[DONE]") {
          sentDone = true;
          writeDataEvent("[DONE]");
        } else {
          writeDataEvent(normalizeSSEData(dataStr));
        }
      } else {
        res.write(pipeBuf);
      }
    }
  } catch (e) {
    console.error("[stream pipe error]", e.message);
    try {
      const errChunk = { error: { message: e.message, type: "stream_error" } };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
    } catch {}
  } finally {
    clearInterval(watchdog);
  }

  if (!sentDone && !aborted) {
    writeDataEvent("[DONE]");
  }
  res.end();

  saveOpenAIStreamDebugLog(
    requestId,
    streamModel,
    _finishReason,
    _fullContent,
    _fullReasoning,
    _toolCalls,
    streamUsage,
    pipeLogLines,
  );
  logRequest({ model: streamModel, startTime, usage: streamUsage });

  function aggregateChunkForDebug(chunk) {
    const lines = chunk.split("\n");
    for (const sl of lines) {
      const t = sl.trim();
      const dataMatch = t.match(/^data:\s?(.*)$/);
      if (!dataMatch) continue;
      const d = dataMatch[1];
      if (d === "[DONE]") continue;
      try {
        const p = JSON.parse(d);
        if (p.model) streamModel = p.model;
        if (p.usage) streamUsage = p.usage;
        const choice = p.choices?.[0];
        if (choice) {
          const delta = choice.delta || {};
          if (choice.finish_reason) _finishReason = choice.finish_reason;
          if (delta.content) _fullContent += delta.content;
          if (delta.reasoning_content)
            _fullReasoning += delta.reasoning_content;
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? _toolCalls.length;
              if (!_toolCalls[idx])
                _toolCalls[idx] = {
                  id: "",
                  type: "function",
                  function: { name: "", arguments: "" },
                };
              if (tc.id) _toolCalls[idx].id = tc.id;
              if (tc.function?.name && !_toolCalls[idx].function.name)
                _toolCalls[idx].function.name = tc.function.name;
              if (tc.function?.arguments)
                _toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        }
      } catch {
        /* skip */
      }
    }
  }
}

// ─── CodeBuddy non-streaming: aggregate SSE → single JSON response ─────
async function aggregateCodeBuddyNonStream({
  res,
  upstream,
  upstreamBody,
  startTime,
  requestId,
}) {
  const reader = upstream.body.getReader();
  const agg = aggregateSSEChunks();
  let streamError = null;

  await readSSEStream(reader, {
    onChunk: (parsed) => agg.handleChunk(parsed),
    onError: (err) => { streamError = err; },
  });

  // Stream errored (timeout or other failure) — propagate to client
  if (streamError) {
    console.error("[non-stream error]", streamError.message);
    return res.status(500).json({
      error: { message: streamError.message, type: "stream_error" },
    });
  }

  const {
    fullContent,
    fullReasoning,
    toolCalls,
    lastChunk,
    id,
    model,
    created,
  } = agg.getResult();

  const finishReason = lastChunk?.choices?.[0]?.finish_reason || "stop";
  const usage = lastChunk?.usage || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  const message = { role: "assistant", content: fullContent || null };
  if (fullReasoning) message.reasoning_content = fullReasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  res.json({
    id,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  });

  saveOpenAINonStreamDebugLog(
    requestId,
    id,
    model,
    finishReason,
    fullContent,
    fullReasoning,
    toolCalls,
    usage,
  );
  logRequest({ model, startTime, usage });
}

// ─── Tool parameter schema sanitizer ────────────────────────────────────
// CodeBuddy's Go JSON Schema parser rejects `anyOf`, `const` and `$schema`.
// Strip them before sending to upstream.

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return;

  delete schema.$schema;

  // Flatten anyOf with single entry: { anyOf: [{ type: "string", enum: [...] }, { ... }] }
  // → pick the first entry and move its fields up.
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const first = schema.anyOf[0];
    delete schema.anyOf;
    for (const key of Object.keys(first)) {
      if (schema[key] == null) schema[key] = first[key];
    }
  }

  // Delete const (not supported)
  delete schema.const;

  // Recurse into properties
  if (schema.properties) {
    for (const v of Object.values(schema.properties)) sanitizeSchema(v);
  }

  // Recurse into items (arrays)
  if (schema.items) sanitizeSchema(schema.items);

  // Recurse into additionalProperties
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    sanitizeSchema(schema.additionalProperties);
  }
}

// ─── WebSearch interception ─────────────────────────────────────────────
// When Claude Code sends a standalone web_search request (single tool,
// user message starts with "Perform a web search"), intercept it and
// call CodeBuddy's search API directly instead of routing to the LLM.

const WEB_SEARCH_API_PATH = "/agenttool/v1/search";
const WEB_SEARCH_RE = /^Perform a web search for the query:\s*(.+?)\s*$/ms;

async function interceptWebSearch(body) {
  if (!body.tools || body.tools.length !== 1) return null;
  if (body.tools[0].function?.name !== "web_search") return null;

  const msgs = body.messages;
  if (!msgs || msgs.length === 0) return null;

  // Last user message should be the search instruction
  const lastUser = msgs.filter(m => m.role === "user").pop();
  if (!lastUser?.content || typeof lastUser.content !== "string") return null;

  const m = lastUser.content.match(WEB_SEARCH_RE);
  if (!m) return null;

  const query = m[1].trim();
  return doWebSearch(query);
}

async function doWebSearch(query) {
  try {
    const resp = await fetch(
      `${process.env.CODEBUDDY_BASE_URL || "https://copilot.tencent.com"}${WEB_SEARCH_API_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.CODEBUDDY_API_KEY}`,
          "X-User-Id": `anonymous_${(process.env.CODEBUDDY_API_KEY || "").slice(-8)}`,
          "X-IDE-Type": "CLI",
          "X-Product": "SaaS",
          "Accept": "application/json",
        },
        body: JSON.stringify({ query }),
      },
    );

    if (!resp.ok) {
      console.error(`[websearch] API returned ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    if (!data?.results || data.results.length === 0) return null;

    // Format results as text
    const lines = [`Web search results for query: "${query}"`, ""];
    data.results.forEach((r, i) => {
      lines.push(`${i + 1}. **${r.title}**`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      if (r.url) lines.push(`   URL: ${r.url}`);
      lines.push("");
    });
    return lines.join("\n");
  } catch (e) {
    console.error("[websearch] Error:", e.message);
    return null;
  }
}

// Build a synthetic non-streaming chat completion response (used when
// we intercept a request and return results without calling upstream).
function makeFakeChatCompletion({ id, model, body, content }) {
  const tokenCount = Math.ceil((content || "").length / 3);
  return {
    id: id || "intercepted-" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || body?.model || "unknown",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: content || "" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: tokenCount,
      total_tokens: tokenCount,
    },
  };
}
