/**
 * 动态加载 CodeBuddy 模型列表
 *
 * 来源优先级（取第一个命中的，不做合并）：
 * 1. ~/.workbuddy/cache/acc-product-config-v3.json — workbuddy 桌面端缓存的云端
 *    product config。最新最全，glm-5.3 等新模型只在这里。
 * 2. local_storage/ 中的云端合并缓存（按会话分片，可能过期）
 * 3. CLI 包目录下的 product.internal.json / product.json（bundled 静态列表）
 * 4. 内置兜底 builtin-models.json（随代码发布）
 * 5. 用户自定义 ~/.codebuddy/models.json（叠加在主来源之上）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';

const HOME = process.env.HOME || process.env.USERPROFILE || '~';
const CODEBUDDY_DIR = process.env.CODEBUDDY_DIR || path.join(HOME, '.codebuddy');
const LOCAL_STORAGE_DIR = path.join(CODEBUDDY_DIR, 'local_storage');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_MODELS_PATH = path.join(__dirname, 'builtin-models.json');

// 桌面端缓存的云端 product config。可用 WORKBUDDY_PRODUCT_CONFIG 覆盖。
const PRODUCT_CONFIG = process.env.WORKBUDDY_PRODUCT_CONFIG
  || path.join(process.env.WORKBUDDY_DIR || HOME, '.workbuddy', 'cache', 'acc-product-config-v3.json');

// Model discovery runs on every cache refresh and is noise for normal use.
// Set MODELS_DEBUG=1 to trace which source each model list came from.
export const MODELS_DEBUG = process.env.MODELS_DEBUG === '1';

function log(...args) {
  if (MODELS_DEBUG) console.log(...args);
}

function warn(...args) {
  if (MODELS_DEBUG) console.warn(...args);
}

// CLI executable lookup — which (Unix) / where (Windows)
const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which';

// 找到 CLI 安装目录
function findCliDir() {
  try {
    const binPath = execSync(`${WHICH_CMD} codebuddy 2>${process.platform === 'win32' ? 'NUL' : '/dev/null'} || ${WHICH_CMD} cbc 2>${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, { encoding: 'utf8' }).trim();
    if (binPath) {
      // bin/codebuddy -> 包的根目录
      const realPath = fs.realpathSync(binPath);
      return path.dirname(path.dirname(realPath));
    }
  } catch { /* ignore */ }
  return null;
}

// 客户端实际可选的模型（product config 中 CLI agent 的 models 列表）。
// models[] 里还有大量内部/历史模型（deepseek-v3-0324、hunyuan-3b、default-1.x 等），
// 它们没有过期标记但不在 UI 中展示，因此以该白名单为准。
function craftModelIds(config) {
  const agent = (config.agents || [])
    .find((a) => (a.modelTags || []).includes('craft') && a.models?.length);
  return agent?.models || null;
}

// 从 JSON 文件中提取模型列表
function extractModels(obj, allowList = null) {
  if (!obj) return [];
  let models = obj.models || obj;
  if (!Array.isArray(models)) return [];
  // 白名单命中时只保留其中的模型，并保持白名单顺序
  if (allowList) {
    const byId = new Map(models.map((m) => [m.id, m]));
    models = allowList.map((id) => byId.get(id)).filter(Boolean);
  }
  return models
    // 排除图像/视频生成模型、内部补全模型、以及带内网地址的自定义渠道模型
    .filter((m) => m.id
      && !m.id.startsWith('custom-local:')
      && !/completion/i.test(m.id)
      && !m.id.startsWith('codewise-')
      && !m.tags?.includes('text-to-image') && !m.tags?.includes('image-to-image')
      && !m.tags?.includes('text-to-video') && !m.tags?.includes('image-to-video'))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      credits: m.credits || null,
      description: m.descriptionEn || m.description || null,
      descriptionZh: m.descriptionZh || null,
      maxInputTokens: m.maxInputTokens || null,
      maxOutputTokens: m.maxOutputTokens || null,
      supportsImages: m.supportsImages || false,
      supportsToolCall: m.supportsToolCall || false,
      supportsReasoning: m.supportsReasoning || false,
      vendor: m.vendor || null,
      // 思考档位：上游支持的档位列表与默认值，供下游（如 Pi 自定义 provider）直接声明。
      // CodeBuddy 后端会按 thinkingLevelMap 二次映射/降级，这里暴露原始口径。
      supportedEfforts: Array.isArray(m.reasoning?.supportedEfforts)
        ? [...m.reasoning.supportedEfforts]
        : null,
      defaultEffort: m.reasoning?.defaultEffort ?? m.reasoning?.effort ?? null,
      canDisableThinking: m.reasoning?.canDisableThinking ?? null,
    }));
}

// 从桌面端缓存的云端 product config 读取（最新最全，新模型的唯一来源）
function loadFromProductConfig() {
  if (!fs.existsSync(PRODUCT_CONFIG)) return null;
  try {
    const content = JSON.parse(fs.readFileSync(PRODUCT_CONFIG, 'utf8'));
    const models = extractModels(content.data || content, craftModelIds(content));
    if (models.length > 0) {
      log(`  [models] Loaded ${models.length} models from product config (${PRODUCT_CONFIG})`);
      return models;
    }
  } catch (e) {
    warn(`  [models] Failed to load ${PRODUCT_CONFIG}:`, e.message);
  }
  return null;
}

// 从 local_storage 缓存中读取（云端合并后的完整列表）
function loadFromCache() {
  try {
    if (!fs.existsSync(LOCAL_STORAGE_DIR)) return null;
    const files = fs.readdirSync(LOCAL_STORAGE_DIR).filter((f) => f.endsWith('.info'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(LOCAL_STORAGE_DIR, file), 'utf8');

      // 尝试直接解析 JSON（部分缓存文件是明文 JSON）
      try {
        const parsed = JSON.parse(content);
        // 格式: [{ userId, data: { models, agents } }]
        if (Array.isArray(parsed) && parsed[0]?.data?.models) {
          const models = extractModels(parsed[0].data);
          if (models.length > 0) {
            log(`  [models] Loaded ${models.length} models from local_storage cache (${file})`);
            return models;
          }
        }
      } catch { /* not JSON */ }

      // 尝试 base64 + gzip 解压
      try {
        const stripped = content.replace(/^"|"$/g, '');
        const buf = Buffer.from(stripped, 'base64');
        const decompressed = zlib.gunzipSync(buf).toString('utf8');
        const parsed = JSON.parse(decompressed);
        if (parsed?.models) {
          const models = extractModels(parsed);
          if (models.length > 0) {
            log(`  [models] Loaded ${models.length} models from compressed cache (${file})`);
            return models;
          }
        }
      } catch { /* not gzip */ }
    }
  } catch (e) {
    warn('  [models] Failed to read local_storage cache:', e.message);
  }
  return null;
}

// 从 CLI 包的 product config 文件读取
function loadFromCliConfig() {
  const cliDir = findCliDir();
  if (!cliDir) return null;

  // 按优先级尝试：internal → 主 product.json
  const configFiles = ['product.internal.json', 'product.json'];
  const allModels = new Map();

  for (const file of configFiles) {
    try {
      const filePath = path.join(cliDir, file);
      if (!fs.existsSync(filePath)) continue;
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const models = extractModels(content);
      for (const m of models) {
        if (!allModels.has(m.id)) allModels.set(m.id, m);
      }
      log(`  [models] Loaded ${models.length} models from ${file}`);
    } catch (e) {
      warn(`  [models] Failed to load ${file}:`, e.message);
    }
  }

  return allModels.size > 0 ? [...allModels.values()] : null;
}

// 从用户自定义 models.json 读取
function loadFromUserModels() {
  const modelsFile = path.join(CODEBUDDY_DIR, 'models.json');
  try {
    if (!fs.existsSync(modelsFile)) return [];
    const content = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
    const raw = Array.isArray(content) ? content : content.models || [];
    const models = raw.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      custom: true,
      maxInputTokens: m.maxInputTokens || null,
      maxOutputTokens: m.maxOutputTokens || null,
      supportsToolCall: m.supportsToolCall ?? true,
    }));
    if (models.length > 0) log(`  [models] Loaded ${models.length} custom models from models.json`);
    return models;
  } catch { /* ignore */ }
  return [];
}

// 内置兜底模型列表（从 product config 提取，随代码发布）
function loadFromBuiltin() {
  try {
    if (!fs.existsSync(BUILTIN_MODELS_PATH)) return null;
    const content = JSON.parse(fs.readFileSync(BUILTIN_MODELS_PATH, 'utf8'));
    const models = extractModels({ models: content });
    if (models.length > 0) {
      log(`  [models] Loaded ${models.length} models from builtin fallback`);
      return models;
    }
  } catch (e) {
    warn('  [models] Failed to load builtin models:', e.message);
  }
  return null;
}

// ─── 主函数：合并所有来源 ───────────────────────────────────────────────────
export function loadModels() {
  // 优先级：桌面端 product config > local_storage 缓存 > CLI product config > 内置兜底 > 空
  const source = loadFromProductConfig()
    || loadFromCache()
    || loadFromCliConfig()
    || loadFromBuiltin()
    || [];

  const modelMap = new Map();
  for (const m of source) modelMap.set(m.id, m);

  // 合并用户自定义模型（可覆盖上游字段）
  for (const m of loadFromUserModels()) {
    modelMap.set(m.id, { ...modelMap.get(m.id), ...m });
  }

  const models = [...modelMap.values()];
  log(`  [models] Total: ${models.length} models available`);
  return models;
}

// ─── 带缓存的模型获取（文件变更时自动刷新） ────────────────────────────────
let _cachedModels = null;
let _lastLoadTime = 0;
let _lastEmptyLoadTime = 0;
const CACHE_TTL = 60_000; // 60 秒刷新
const EMPTY_BACKOFF = 60_000; // 空结果退避 60 秒，避免每次请求都重试 IO

export function getModels() {
  const now = Date.now();
  const emptyBackoffActive = now - _lastEmptyLoadTime < EMPTY_BACKOFF;

  if (!_cachedModels) {
    _cachedModels = loadModels();
    _lastLoadTime = now;
    if (_cachedModels.length === 0) {
      _lastEmptyLoadTime = now;
      return _cachedModels;
    }
  } else if (!emptyBackoffActive && now - _lastLoadTime > CACHE_TTL) {
    // TTL 到期，尝试刷新（非空结果情况下）
    const fresh = loadModels();
    _lastLoadTime = now;
    if (fresh.length > 0) {
      _cachedModels = fresh;
    } else {
      _lastEmptyLoadTime = now;
    }
  }
  return _cachedModels;
}
