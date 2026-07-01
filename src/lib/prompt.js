import fs from "node:fs";
import path from "node:path";

/**
 * Path to the optional system prompt override file.
 * Set `SYSTEM_PROMPT_FILE` env var to customise; default is
 * `system-prompt.txt` in the project root. The file is NOT included
 * in the public repository — create one manually.
 */
const SYSTEM_PROMPT_FILE =
  process.env.SYSTEM_PROMPT_FILE || path.resolve("system-prompt.txt");

let _customSystemPrompt = null;
let _loaded = false;

export function getCustomSystemPrompt() {
  if (_loaded) return _customSystemPrompt;
  _loaded = true;
  try {
    _customSystemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8").trim();
    console.log(
      `  \x1b[32m✓\x1b[0m Custom system prompt loaded (${_customSystemPrompt.length} chars)`,
    );
  } catch {
    console.log(
      "  \x1b[33m⚠\x1b[0m No system-prompt.txt found, passthrough mode",
    );
    _customSystemPrompt = "";
  }
  return _customSystemPrompt;
}

const FILTER_MARK = "敏感内容";

export function replaceSystemPrompt(messages) {
  const prompt = getCustomSystemPrompt();
  if (!prompt || !messages) return messages;
  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    messages[sysIdx].content = prompt;
  } else {
    messages.unshift({ role: "system", content: prompt });
  }
  return messages;
}

export function filterContentMessages(messages) {
  if (!messages) return messages;
  let cleaned = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string" && m.content.includes(FILTER_MARK)) {
      // Replace the content-filter placeholder with a neutral value.
      // Keep the message (and its tool_calls) to preserve conversation structure;
      // deleting the message would orphan tool results and cause upstream 400.
      m.content =
        m.content.replace(FILTER_MARK, "[content filtered]").trim() || null;
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(
      `\x1b[36m[clean]\x1b[0m scrubbed ${cleaned} content_filter marker(s) from assistant messages`,
    );
  }
  return messages;
}

export { FILTER_MARK };
