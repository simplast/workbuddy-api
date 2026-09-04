import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.jsonl');
const LOG_FILE_OLD = path.join(LOG_DIR, 'requests.jsonl.1');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// 程序运行以来累计金额
let totalCredit = 0;

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_LOG_SIZE) return;
    // Rotate: requests.jsonl → requests.jsonl.1 (overwrite old)
    fs.renameSync(LOG_FILE, LOG_FILE_OLD);
  } catch { /* file may not exist yet */ }
}

function ts(now = new Date()) {
  return now.toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * Print a diagnostic line with a gray timestamp prefix so ad-hoc logs
 * ([normalize], [clean], [rate-limit], ...) align with logRequest lines.
 */
export function logDiag(tag, message, color = 36) {
  console.log(`\x1b[90m${ts()}\x1b[0m \x1b[${color}m${tag}\x1b[0m ${message}`);
}

export function logRequest({ model, startTime, usage }) {
  const now = new Date();
  const elapsed = Date.now() - startTime;

  // Each part is padded to a fixed visible width so columns line up across
  // consecutive log lines. Color codes wrap the already-padded string, so
  // padEnd sees only the visible text (no ANSI counted).
  const parts = [
    `\x1b[90m${ts(now)}\x1b[0m`,
    `\x1b[1m${model.padEnd(8)}\x1b[0m`,
    `\x1b[90m${`${(elapsed / 1000).toFixed(1)}s`.padEnd(6)}\x1b[0m`,
  ];

  if (usage) {
    const inp = usage.prompt_tokens ?? 0;
    const out = usage.completion_tokens ?? 0;
    const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
    const thinking = usage.completion_thinking_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0;
    const credit = usage.credit;

    parts.push(`\x1b[32m${`↑${fmtNum(inp)}`.padEnd(6)}\x1b[0m`);
    parts.push(`\x1b[33m${`↓${fmtNum(out)}`.padEnd(5)}\x1b[0m`);
    // Reserve the Δ slot whenever cache info is present, so later columns
    // don't shift left on lines that had no cache-hit.
    if (cacheHit || cacheMiss) parts.push(`\x1b[35m${`Δ${fmtNum(cacheHit)}`.padEnd(6)}\x1b[0m`);
    if (cacheMiss) parts.push(`\x1b[0m${`M${fmtNum(cacheMiss)}`.padEnd(6)}\x1b[0m`);
    // T slot is emitted unconditionally (T0 when zero) — skipping it on
    // lines without thinking would shift the ¥/Σ¥ columns left.
    parts.push(`\x1b[90m${`T${fmtNum(thinking)}`.padEnd(5)}\x1b[0m`);
    if (credit != null) {
      const creditNum = Number(credit);
      if (!Number.isNaN(creditNum)) totalCredit += creditNum;
      parts.push(`\x1b[31m${`¥${credit}`.padEnd(6)}\x1b[0m`);
      parts.push(`\x1b[1;31m${`Σ¥${totalCredit.toFixed(2)}`.padEnd(7)}\x1b[0m`);
    }

    const record = {
      timestamp: now.toISOString(),
      model,
      elapsed_ms: elapsed,
      prompt_tokens: inp,
      completion_tokens: out,
      cache_hit_tokens: cacheHit,
      cache_miss_tokens: cacheMiss,
      cached_output_tokens: usage.completion_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0,
      thinking_tokens: thinking,
      credit: credit ?? null,
      total_tokens: usage.total_tokens ?? inp + out,
    };
    try {
      rotateIfNeeded();
      fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
    } catch (e) {
      console.error('[log write error]', e.message);
    }
  }

  console.log(parts.join(' '));
}

function fmtNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'K';
  return String(n);
}
