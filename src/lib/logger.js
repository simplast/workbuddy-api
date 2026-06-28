import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.jsonl');
const LOG_FILE_OLD = path.join(LOG_DIR, 'requests.jsonl.1');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_LOG_SIZE) return;
    // Rotate: requests.jsonl → requests.jsonl.1 (overwrite old)
    fs.renameSync(LOG_FILE, LOG_FILE_OLD);
  } catch { /* file may not exist yet */ }
}

export function logRequest({ model, startTime, usage }) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const elapsed = Date.now() - startTime;

  const parts = [
    `\x1b[90m${timeStr}\x1b[0m`,
    `\x1b[1m${model}\x1b[0m`,
    `\x1b[90m${elapsed}ms\x1b[0m`,
  ];

  if (usage) {
    const inp = usage.prompt_tokens ?? 0;
    const out = usage.completion_tokens ?? 0;
    const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
    const thinking = usage.completion_thinking_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0;
    const credit = usage.credit;

    parts.push(`\x1b[32m↑${fmtNum(inp)}\x1b[0m`);
    parts.push(`\x1b[33m↓${fmtNum(out)}\x1b[0m`);
    if (cacheHit) parts.push(`\x1b[35mΔ${fmtNum(cacheHit)}\x1b[0m`);
    if (cacheMiss) parts.push(`M${fmtNum(cacheMiss)}`);
    if (thinking) parts.push(`\x1b[90mT${fmtNum(thinking)}\x1b[0m`);
    if (credit != null) parts.push(`\x1b[31m¥${credit}\x1b[0m`);

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

  console.log(parts.join('  '));
}

function fmtNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'K';
  return String(n);
}
