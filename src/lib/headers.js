import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { config } from '../config.js';

// ─── CLI 版本 & SDK 信息 ────────────────────────────────────────────────────
let CLI_VERSION = '2.106.1';
let SDK_VERSION = '6.25.0';
try {
  const raw = execSync('which codebuddy 2>/dev/null || which cbc 2>/dev/null', { encoding: 'utf8' }).trim();
  if (raw) {
    const pkgPath = path.join(path.dirname(fs.realpathSync(raw)), '..', 'package.json');
    const ver = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    if (ver) CLI_VERSION = ver;
  }
} catch (e) {
  console.warn(`  [headers] Failed to detect CLI version, using fallback ${CLI_VERSION}: ${e.message}`);
}

export function hexId(len = 32) {
  return crypto.randomBytes(len / 2).toString('hex');
}

export function buildCliHeaders(model) {
  const conversationId = crypto.randomUUID();
  const requestId = hexId(32);
  const messageId = hexId(32);
  const traceId = hexId(32);
  const spanId = hexId(16);
  const parentSpanId = hexId(16);

  const userIdSuffix = config.apiKey.slice(-8);
  const userId = `anonymous_${userIdSuffix}`;

  const platform = os.platform();
  const arch = os.arch();
  const osName = platform === 'darwin' ? 'MacOS' : platform === 'linux' ? 'Linux' : 'Windows';

  return {
    'Accept': 'application/json',
    'x-requested-with': 'XMLHttpRequest',

    'x-stainless-arch': arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': osName,
    'x-stainless-package-version': SDK_VERSION,
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,

    'X-Conversation-ID': conversationId,
    'X-Conversation-Request-ID': requestId,
    'X-Conversation-Message-ID': messageId,
    'X-Request-ID': traceId,

    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',

    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': CLI_VERSION,
    'X-Private-Data': 'false',

    'X-Trace-ID': traceId,
    'b3': `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',

    'x-codebuddy-request': '1',

    'X-API-Key': config.apiKey,
    'X-User-Id': userId,
    'X-Product': 'SaaS',

    'User-Agent': `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`,
  };
}
