/**
 * Debug dump management for request/response logging.
 * Centralizes per-request debug file writing, directory management,
 * and console output that was previously duplicated across route handlers.
 */
import fs from "node:fs";
import path from "node:path";
import { cleanupDebugDir } from "./debug-cleanup.js";

const LOG_DIR = path.resolve("logs");
const DEBUG_DIR = path.join(LOG_DIR, "requests");
export const CAPTURE_FULL_SSE_DEBUG =
  process.env.DEBUG_CAPTURE_FULL_SSE === "1";
export const ENABLE_DEBUG_DUMPS = process.env.ENABLE_DEBUG_DUMPS !== "0";

function ensureDirs() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

/**
 * Generate a unique request ID.
 */
export function makeRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Dump the upstream request body to debug files and console.
 * @param {string} prefix - 'openai' or 'anthropic'
 * @param {string} requestId
 * @param {object} upstreamBody
 */
let _lastCleanup = 0;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // every 5 minutes

export function dumpRequest(prefix, requestId, upstreamBody) {
  if (!ENABLE_DEBUG_DUMPS) return;
  try {
    ensureDirs();
    if (Date.now() - _lastCleanup > CLEANUP_INTERVAL) {
      cleanupDebugDir(DEBUG_DIR);
      _lastCleanup = Date.now();
    }
    const filename = `${prefix}-${requestId}.json`;
    const content = JSON.stringify(
      { id: requestId, request: upstreamBody },
      null,
      2,
    );
    fs.writeFileSync(path.join(DEBUG_DIR, filename), content);

    // Write last-request file (separate for openai vs anthropic)
    const lastFile =
      prefix === "anthropic"
        ? "last-request-anthropic.json"
        : "last-request.json";
    fs.writeFileSync(path.join(LOG_DIR, lastFile), content);

    // Console summary
    const msgs = upstreamBody.messages || [];
    const sys = msgs.find((m) => m.role === "system");
    if (sys && prefix === "openai") {
      const preview = (
        typeof sys.content === "string"
          ? sys.content
          : JSON.stringify(sys.content)
      ).slice(0, 200);
      console.log(
        `\x1b[33m[req dump]\x1b[0m system prompt ${typeof sys.content === "string" ? sys.content.length : JSON.stringify(sys.content).length} chars: ${preview}...`,
      );
    }

    // Extract thinking/reasoning info from the request
    const thinkingInfo = [];
    // OpenAI: reasoning_effort (low/medium/high)
    if (upstreamBody.reasoning_effort != null) {
      thinkingInfo.push(`reasoning_effort=${upstreamBody.reasoning_effort}`);
    }
    // Anthropic: thinking budget_tokens or enabled
    if (upstreamBody.thinking != null) {
      const t = upstreamBody.thinking;
      if (typeof t === "object") {
        const parts = [];
        if (t.type) parts.push(`type=${t.type}`);
        if (t.budget_tokens != null) parts.push(`budget=${t.budget_tokens}`);
        thinkingInfo.push(`thinking={${parts.join(",")}}`);
      } else {
        thinkingInfo.push(`thinking=${JSON.stringify(t)}`);
      }
    }

    const topKeys = {};
    for (const k of Object.keys(upstreamBody)) {
      if (k === "messages" || k === "tools" || k === "thinking") continue;
      topKeys[k] = upstreamBody[k];
    }
    const thinkingStr =
      thinkingInfo.length > 0
        ? ` \x1b[35m🧠 ${thinkingInfo.join(" ")}\x1b[0m`
        : "";
    console.log(
      `\x1b[33m[req dump]\x1b[0m ${msgs.length} messages, ${upstreamBody.tools?.length ?? 0} tools, top-keys: ${JSON.stringify(topKeys)}${thinkingStr} → saved (id=${requestId})`,
    );
  } catch {
    /* ignore */
  }
}

/**
 * Dump the aggregated response to debug files and console.
 * @param {string} prefix - 'openai' or 'anthropic'
 * @param {string} requestId
 * @param {object} debugResp - Aggregated response summary object
 */
export function dumpResponse(prefix, requestId, debugResp) {
  if (!ENABLE_DEBUG_DUMPS) return;
  try {
    ensureDirs();
    const filename = `${prefix}-${requestId}-resp.json`;
    const content = JSON.stringify(
      { id: requestId, response: debugResp },
      null,
      2,
    );
    fs.writeFileSync(path.join(DEBUG_DIR, filename), content);

    const lastFile =
      prefix === "anthropic"
        ? "last-response-anthropic.json"
        : "last-response.json";
    fs.writeFileSync(path.join(LOG_DIR, lastFile), content);
  } catch {
    /* ignore */
  }
}

/**
 * Log a response summary to console.
 * @param {string} prefix
 * @param {object} opts - { finishReason, contentLen, reasoningLen, toolCallSummary, extraInfo }
 */
export function logResponseSummary(prefix, opts) {
  const {
    finishReason,
    contentLen,
    reasoningLen = 0,
    toolCallSummary = "(none)",
    extraInfo = "",
  } = opts;
  const reasoningPart =
    reasoningLen > 0 ? ` reasoning=${reasoningLen}chars` : "";
  const extra = extraInfo ? ` ${extraInfo}` : "";
  console.log(
    `\x1b[33m[${prefix} resp]\x1b[0m finish=${finishReason} content=${contentLen}chars${reasoningPart}${extra} → saved to logs/ (id=${opts.requestId || ""})`,
  );
}

export { LOG_DIR, DEBUG_DIR };

// ─── OpenAI debug response helpers ──────────────────────────────────────

function formatToolCallsForDebug(toolCalls) {
  return toolCalls.map((tc) => {
    let args = tc.function.arguments;
    try {
      args = JSON.parse(args);
    } catch {}
    return { id: tc.id, function: { name: tc.function.name, arguments: args } };
  });
}

export function saveOpenAIStreamDebugLog(
  requestId,
  model,
  finishReason,
  content,
  reasoning,
  toolCalls,
  usage,
  pipeLogLines,
) {
  if (!ENABLE_DEBUG_DUMPS) return;
  try {
    const debugResp = {
      id: requestId,
      model,
      finish_reason: finishReason,
      message: { role: "assistant", content: content || null },
      tool_calls_count: toolCalls.length,
      usage,
    };
    if (pipeLogLines) debugResp.sse_sent_to_client = pipeLogLines.join("");
    if (reasoning) debugResp.message.reasoning_content = reasoning;
    if (toolCalls.length > 0)
      debugResp.message.tool_calls = formatToolCallsForDebug(toolCalls);
    dumpResponse("openai", requestId, debugResp);

    const tcSummary =
      toolCalls.length > 0
        ? toolCalls.map((tc) => tc.function.name).join(", ")
        : "(none)";
    const reasoningSummary =
      reasoning.length > 0 ? ` reasoning=${reasoning.length}chars` : "";
    logResponseSummary("openai", {
      finishReason,
      contentLen: content.length,
      reasoningLen: reasoning.length,
      toolCallSummary: tcSummary,
      extraInfo: reasoningSummary,
      requestId,
    });
  } catch {
    /* ignore */
  }
}

export function saveOpenAINonStreamDebugLog(
  requestId,
  id,
  model,
  finishReason,
  content,
  reasoning,
  toolCalls,
  usage,
) {
  if (!ENABLE_DEBUG_DUMPS) return;
  try {
    const debugResp = {
      id,
      model,
      finish_reason: finishReason,
      message: { role: "assistant", content: content || null },
      tool_calls_count: toolCalls.length,
      usage,
    };
    if (reasoning) debugResp.message.reasoning_content = reasoning;
    if (toolCalls.length > 0)
      debugResp.message.tool_calls = formatToolCallsForDebug(toolCalls);
    dumpResponse("openai", requestId, debugResp);

    const tcSummary =
      toolCalls.length > 0
        ? toolCalls.map((tc) => tc.function.name).join(", ")
        : "(none)";
    logResponseSummary("openai", {
      finishReason,
      contentLen: (content || "").length,
      toolCallSummary: tcSummary,
      requestId,
    });
  } catch {
    /* ignore */
  }
}
