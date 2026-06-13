import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.jsonl');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

export function logRequest({ model, startTime, usage }) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const elapsed = Date.now() - startTime;

  const line = '\x1b[90m─\x1b[0m'.repeat(60);
  console.log(`\n${line}`);
  console.log(`\x1b[36m[${timeStr}]\x1b[0m  \x1b[1m${model}\x1b[0m  \x1b[90m${elapsed}ms\x1b[0m`);

  if (usage) {
    const inp = usage.prompt_tokens ?? 0;
    const out = usage.completion_tokens ?? 0;
    const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
    const cachedOut = usage.completion_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
    const thinking = usage.completion_thinking_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0;
    const credit = usage.credit;

    let parts = [`\x1b[32m↑ ${inp}\x1b[0m`, `\x1b[33m↓ ${out}\x1b[0m`];
    if (cacheHit) parts.push(`\x1b[35mcache_hit ${cacheHit}\x1b[0m`);
    if (cacheMiss) parts.push(`cache_miss ${cacheMiss}`);
    if (cachedOut) parts.push(`\x1b[35mcached_out ${cachedOut}\x1b[0m`);
    if (thinking) parts.push(`\x1b[90mthinking ${thinking}\x1b[0m`);
    if (credit != null) parts.push(`\x1b[31m¥${credit}\x1b[0m`);

    console.log('  ' + parts.join('  \x1b[90m│\x1b[0m  '));

    const record = {
      timestamp: now.toISOString(),
      model,
      elapsed_ms: elapsed,
      prompt_tokens: inp,
      completion_tokens: out,
      cache_hit_tokens: cacheHit,
      cache_miss_tokens: cacheMiss,
      cached_output_tokens: cachedOut,
      thinking_tokens: thinking,
      credit: credit ?? null,
      total_tokens: usage.total_tokens ?? inp + out,
    };
    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
    } catch (e) {
      console.error('[log write error]', e.message);
    }
  }
}
