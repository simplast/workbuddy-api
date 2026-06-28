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
  } catch (e) {
    console.warn(
      `  [codebuddy] Failed to detect CLI version, using fallback ${CLI_VERSION}: ${e.message}`,
    );
  }
}

function hexId(len = 32) {
  return crypto.randomBytes(len / 2).toString("hex");
}

/**
 * Build the CLI fingerprint headers.
 * @param {string} apiKey - for the X-User-Id suffix
 */
function buildCliHeaders(apiKey) {
  detectCliVersion();
  const conversationId = crypto.randomUUID();
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

  buildHeaders() {
    return {
      ...super.buildHeaders(),
      ...buildCliHeaders(this.apiKey),
    };
  }
}
