/**
 * 定位桌面端 WorkBuddy 缓存的云端 product config。
 *
 * 桌面端每起一个进程就写一份 `acc-product-config-v3-<pid>-<uuid>.json`，从不落盘
 * 无后缀的固定文件名。同一个 cache 目录里还混着 CLI 的 config：顶层没有 `agents`，
 * craft 白名单只有 9 个模型，新模型（deepseek-v4.1-flash、glm-5.3）的 reasoning
 * 档位也是旧口径。所以只能按内容甄别，光凭文件名或 mtime 都会挑错。
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || process.env.USERPROFILE || '~';
const CACHE_DIR = path.join(
  process.env.WORKBUDDY_DIR || HOME,
  '.workbuddy',
  'cache',
);
const FILE_PREFIX = 'acc-product-config-v3';
const FILE_SUFFIX = '.json';

// 显式覆盖优先，给测试和换机器留一条不需要改代码的路。
const OVERRIDE = process.env.WORKBUDDY_PRODUCT_CONFIG;

function readConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw.data || raw;
  } catch {
    // 桌面端可能正在写这一份，截断的 JSON 跳过即可，别让整次发现失败。
    return null;
  }
}

// 桌面端 config 带 agents 段；CLI config 的顶层是 productName/endpoint 那一套。
function isDesktopConfig(config) {
  return Array.isArray(config?.agents) && config.agents.length > 0;
}

function candidates() {
  try {
    return fs
      .readdirSync(CACHE_DIR)
      .filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX))
      .map((f) => {
        const file = path.join(CACHE_DIR, f);
        try {
          return { file, mtime: fs.statSync(file).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/**
 * 返回 `{ path, config }`，找不到桌面端 config 时返回 null。
 * 多份快照时取 mtime 最新的一份——桌面端启动时用新快照覆盖旧口径。
 */
export function resolveProductConfig() {
  if (OVERRIDE) {
    const config = readConfig(OVERRIDE);
    return config ? { path: OVERRIDE, config } : null;
  }

  for (const { file } of candidates()) {
    const config = readConfig(file);
    if (isDesktopConfig(config)) return { path: file, config };
  }
  return null;
}
