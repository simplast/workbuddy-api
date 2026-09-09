/**
 * CodeBuddy provider — OpenAI protocol + CLI request-header fingerprinting.
 *
 * CodeBuddy's upstream is a Chat Completions-compatible endpoint, but it
 * rejects requests that don't look like the official CLI client. We layer
 * the CLI fingerprint (Stainless SDK headers, B3 trace headers, conversation
 * IDs, etc.) on top of a standard OpenAI request.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { OpenAIProvider } from "./base.js";

// ─── CLI version & SDK info (lazy: detected on first request) ───────────
const FALLBACK_CLI_VERSION = process.env.CODEBUDDY_CLI_VERSION || "2.110.0";
let CLI_VERSION = FALLBACK_CLI_VERSION;
let _cliVersionDetected = false;
const SDK_VERSION = "6.25.0";
const WHICH_CMD = process.platform === "win32" ? "where" : "which";

function detectCliVersion() {
  if (_cliVersionDetected) return;
  _cliVersionDetected = true;

  // Allow explicit override via env var (useful when CLI is not installed locally)
  if (process.env.CODEBUDDY_CLI_VERSION) {
    CLI_VERSION = process.env.CODEBUDDY_CLI_VERSION;
    console.log(`  [codebuddy] CLI version from env: ${CLI_VERSION}`);
    return;
  }

  try {
    const nullRedirect = process.platform === "win32" ? "2>NUL" : "2>/dev/null";
    const raw = execSync(
      `${WHICH_CMD} codebuddy ${nullRedirect} || ${WHICH_CMD} cbc ${nullRedirect}`,
      { encoding: "utf8" },
    ).trim();
    if (raw) {
      const pkgPath = path.join(
        path.dirname(fs.realpathSync(raw)),
        "..",
        "package.json",
      );
      const ver = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
      if (ver) CLI_VERSION = ver;
    }
  } catch {
    // Detection failure is non-fatal — fall back to bundled version silently
  }
}

function hexId(len = 32) {
  return crypto.randomBytes(len / 2).toString("hex");
}

/**
 * Derive a stable per-conversation id from the request body.
 *
 * Keyed on the SYSTEM prompt + the first user message: within one agent
 * conversation those never change, while the tail grows with every turn —
 * exactly the prefix the upstream cache needs to match. If a client sends
 * no system message the first user message alone carries the identity.
 */
function deriveConversationId(body) {
  const PREFIX_SEED = crypto
    .createHash("sha256")
    .update("workbuddy-api:conversation-v1")
    .digest();

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    // No messages to identify the conversation by — keep one id per process
    // so at least consecutive health-check-style calls share a bucket.
    return processConversationId ??= uuidFromSeed(PREFIX_SEED);
  }

  const parts = [];
  for (const m of body.messages) {
    // System and developer messages are the conversation's stable identity.
    if (m.role === "system" || m.role === "developer") {
      parts.push(`${m.role}:${contentToText(m.content)}`);
    }
  }
  // First user turn anchors conversations that have no system prompt.
  const firstUser = body.messages.find((m) => m.role === "user");
  if (firstUser) parts.push(`user:${contentToText(firstUser.content)}`);

  const seed = parts.length
    ? crypto.createHash("sha256").update(parts.join("\n")).digest()
    : PREFIX_SEED;
  return uuidFromSeed(seed);
}

let processConversationId = null;

function uuidFromSeed(seed) {
  const hex = Buffer.from(seed).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20, 32)}`;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/**
 * Build the CLI fingerprint headers.
 *
 * `X-Conversation-ID` must stay STABLE across the requests of one conversation:
 * the upstream keys its prompt cache by conversation, so a fresh random id per
 * request makes every request land in a different cache bucket — measured as
 * 0% prefix-cache hits on 130K-token contexts (~3x credit burn). The official
 * CLI keeps this header constant for a session (only messageId rotates).
 *
 * We derive it deterministically from a hash of the message history, so the
 * same conversation keeps the same bucket while unrelated conversations stay
 * isolated. `body` may be null (health checks etc.), which falls back to a
 * per-process constant.
 *
 * @param {string} apiKey - for the X-User-Id suffix
 * @param {object|null} body - the outgoing request body (messages[])
 */
export function buildCliHeaders(apiKey, body = null) {
  detectCliVersion();
  const conversationId = deriveConversationId(body);
  const requestId = hexId(32);
  const messageId = hexId(32);
  const traceId = hexId(32);
  const spanId = hexId(16);
  const parentSpanId = hexId(16);

  const userIdSuffix = apiKey.length >= 8 ? apiKey.slice(-8) : "00000000";
  const userId = `anonymous_${userIdSuffix}`;

  const platform = os.platform();
  const arch = os.arch();
  const osName =
    platform === "darwin"
      ? "MacOS"
      : platform === "linux"
        ? "Linux"
        : "Windows";

  return {
    Accept: "application/json",
    "x-requested-with": "XMLHttpRequest",

    "x-stainless-arch": arch,
    "x-stainless-lang": "js",
    "x-stainless-os": osName,
    "x-stainless-package-version": SDK_VERSION,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,

    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": requestId,
    "X-Conversation-Message-ID": messageId,
    "X-Request-ID": traceId,

    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",

    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-IDE-Version": CLI_VERSION,
    "X-Private-Data": "false",

    "X-Trace-ID": traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-SpanId": spanId,
    "X-B3-Sampled": "1",

    "x-codebuddy-request": "1",

    "X-API-Key": apiKey,
    "X-User-Id": userId,
    "X-Product": "SaaS",

    "User-Agent": `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
  };
}

/**
 * CodeBuddy OpenAI provider. Default baseURL is https://www.codebuddy.ai,
 * and the actual endpoint path is /v2/chat/completions (not /v1).
 */
export class CodeBuddyProvider extends OpenAIProvider {
  constructor(opts) {
    super({ ...opts, label: opts.label || "codebuddy" });
  }

  resolveURL() {
    return `${this.baseURL}/v2/chat/completions`;
  }

  buildHeaders(body = null) {
    return {
      ...super.buildHeaders(),
      ...buildCliHeaders(this.apiKey, body),
    };
  }
}
