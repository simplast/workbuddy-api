import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_PROMPT_FILE = path.resolve('system-prompt.txt');

let _customSystemPrompt = null;
let _loaded = false;

export function getCustomSystemPrompt() {
  if (_loaded) return _customSystemPrompt;
  _loaded = true;
  try {
    _customSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8').trim();
    console.log(`  \x1b[32m✓\x1b[0m Custom system prompt loaded (${_customSystemPrompt.length} chars)`);
  } catch {
    console.log('  \x1b[33m⚠\x1b[0m No system-prompt.txt found, passthrough mode');
    _customSystemPrompt = '';
  }
  return _customSystemPrompt;
}

const FILTER_MARK = '敏感内容';

export function replaceSystemPrompt(messages) {
  const prompt = getCustomSystemPrompt();
  if (!prompt || !messages) return messages;
  const sysIdx = messages.findIndex((m) => m.role === 'system');
  if (sysIdx >= 0) {
    messages[sysIdx].content = prompt;
    console.log(`\x1b[36m[sys]\x1b[0m system prompt replaced (${prompt.length} chars)`);
  }
  return messages;
}

export function filterContentMessages(messages) {
  if (!messages) return messages;
  const before = messages.length;
  const filtered = messages.filter((m) => {
    if (m.role !== 'assistant') return true;
    const text = typeof m.content === 'string' ? m.content : '';
    return !text.includes(FILTER_MARK);
  });
  const removed = before - filtered.length;
  if (removed > 0) {
    console.log(`\x1b[36m[clean]\x1b[0m removed ${removed} content_filter error message(s) from history`);
  }
  return filtered;
}

export { FILTER_MARK };
