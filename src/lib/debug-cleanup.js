/**
 * Cleanup helper for per-request debug dump directories.
 * Keeps the directory bounded by both age and file count.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FILES = 1000;

/**
 * Delete debug files older than MAX_AGE_MS, and if still over MAX_FILES,
 * drop the oldest until under the cap. Runs synchronously; best-effort.
 */
export function cleanupDebugDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(dir, e.name);
        try {
          const stat = fs.statSync(full);
          return { path: full, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // 1) age-based prune
    for (const e of entries) {
      if (now - e.mtime > MAX_AGE_MS) {
        try { fs.unlinkSync(e.path); } catch {}
      }
    }

    // 2) count-based prune: keep newest MAX_FILES
    const remaining = entries.filter((e) => fs.existsSync(e.path));
    if (remaining.length > MAX_FILES) {
      remaining.sort((a, b) => a.mtime - b.mtime);
      const toDrop = remaining.length - MAX_FILES;
      for (let i = 0; i < toDrop; i++) {
        try { fs.unlinkSync(remaining[i].path); } catch {}
      }
    }
  } catch { /* best-effort cleanup */ }
}
