import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve("logs");
const LOG_FILE = path.join(LOG_DIR, "requests.jsonl");
const LOG_FILE_OLD = path.join(LOG_DIR, "requests.jsonl.1");
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
  } catch {
    /* file may not exist yet */
  }
}

function ts(now = new Date()) {
  return now.toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * Print a diagnostic line with a gray timestamp prefix so ad-hoc logs
 * ([normalize], [clean], [rate-limit], ...) align with logRequest lines.
 */
export function logDiag(tag, message, color = 36) {
  console.log(`\x1b[90m${ts()}\x1b[0m \x1b[${color}m${tag}\x1b[0m ${message}`);
}

/**
 * Reserved width of each column, sized from the widest value observed in
 * logs/requests.jsonl (7.3k real requests) — each slot is that maximum
 * plus one separator space.
 *
 * The +1 matters: padEnd() only ever grows a string, never truncates, so a
 * cell exactly as wide as its slot gets no trailing space and the row is one
 * column short — that is how this table drifted before. Keeping every slot
 * strictly wider than its widest possible content is what makes consecutive
 * lines comparable.
 */
const COL = {
  model: 20, // longest id in the catalog + 1, e.g. "deepseek-v3-2-volc"
  elapsed: 7, // "427.6s"
  num: 8, // "↑421.6K" — symbol + fmtNum() worst case
  credit: 7, // "¥14.26"
  total: 12, // "Σ¥12345.67" — the running sum only grows
};

/**
 * Pad a cell to its reserved slot. The overflow branch is a safety net for
 * content longer than we sized for: it emits a single trailing space so the
 * neighbour stays separated rather than bleeding together. It should not be
 * reached in practice — see COL above.
 */
function cell(text, width) {
  return text.length + 1 >= width ? `${text} ` : text.padEnd(width);
}

function numCell(symbol, value, color) {
  return `\x1b[${color}m${cell(`${symbol}${fmtNum(value)}`, COL.num)}\x1b[0m`;
}

export function logRequest({ model, startTime, usage, ctx }) {
  const now = new Date();
  const elapsed = Date.now() - startTime;

  // Each part is padded to a fixed visible width so columns line up across
  // consecutive log lines. Color codes wrap the already-padded string, so
  // padEnd sees only the visible text (no ANSI counted).
  const parts = [
    `\x1b[90m${ts(now)}\x1b[0m`,
    `\x1b[1m${cell(model, COL.model)}\x1b[0m`,
    `\x1b[90m${cell(`${(elapsed / 1000).toFixed(1)}s`, COL.elapsed)}\x1b[0m`,
  ];

  if (usage) {
    const inp = usage.prompt_tokens ?? 0;
    const out = usage.completion_tokens ?? 0;
    const cacheHit =
      usage.prompt_cache_hit_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      0;
    const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
    const thinking =
      usage.completion_thinking_tokens ??
      usage.completion_tokens_details?.reasoning_tokens ??
      0;
    const credit = usage.credit;

    // Every slot is emitted unconditionally. Δ and M used to be skipped
    // when the upstream reported no cache counters, which shifted T/¥/Σ¥
    // left by 7 or 14 columns on those lines; printing "0" is far cheaper
    // than a broken table.
    parts.push(numCell("↑", inp, 32));
    parts.push(numCell("↓", out, 33));
    parts.push(numCell("Δ", cacheHit, 35));
    parts.push(numCell("M", cacheMiss, 0));
    parts.push(numCell("T", thinking, 90));
    if (credit != null) {
      const creditNum = Number(credit);
      if (!Number.isNaN(creditNum)) totalCredit += creditNum;
      parts.push(`\x1b[31m${cell(`¥${credit}`, COL.credit)}\x1b[0m`);
      parts.push(
        `\x1b[1;31m${cell(`Σ¥${totalCredit.toFixed(2)}`, COL.total)}\x1b[0m`,
      );
    }

    const record = {
      timestamp: now.toISOString(),
      model,
      elapsed_ms: elapsed,
      prompt_tokens: inp,
      completion_tokens: out,
      cache_hit_tokens: cacheHit,
      cache_miss_tokens: cacheMiss,
      cached_output_tokens:
        usage.completion_tokens_details?.cached_tokens ??
        usage.cached_tokens ??
        0,
      thinking_tokens: thinking,
      // Cache diagnostics (from the chat route): which upstream cache bucket
      // this request used, and fingerprints of the prompt prefix.
      ...(ctx?.convId ? { conversation_id: ctx.convId } : {}),
      ...(ctx?.sysHash ? { system_hash: ctx.sysHash } : {}),
      ...(ctx?.bodyHash ? { body_hash: ctx.bodyHash } : {}),
      ...(ctx?.msgCount != null ? { message_count: ctx.msgCount } : {}),
      credit: credit ?? null,
      total_tokens: usage.total_tokens ?? inp + out,
    };
    try {
      rotateIfNeeded();
      fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");
    } catch (e) {
      console.error("[log write error]", e.message);
    }
  }

  console.log(parts.join(" "));
}

function fmtNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "K";
  return String(n);
}
