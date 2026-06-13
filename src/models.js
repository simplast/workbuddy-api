/**
 * 动态加载 CodeBuddy 模型列表
 * 
 * 来源优先级：
 * 1. ~/.codebuddy/local_storage/ 中的云端合并缓存（最完整，包含云端动态模型）
 * 2. CLI 包目录下的 product.internal.json / product.json（bundled 静态列表）
 * 3. 用户自定义 ~/.codebuddy/models.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';

const CODEBUDDY_DIR = path.join(process.env.HOME || '~', '.codebuddy');
const LOCAL_STORAGE_DIR = path.join(CODEBUDDY_DIR, 'local_storage');

// 找到 CLI 安装目录
function findCliDir() {
  try {
    const binPath = execSync('which codebuddy 2>/dev/null || which cbc 2>/dev/null', { encoding: 'utf8' }).trim();
    if (binPath) {
      // bin/codebuddy -> 包的根目录
      const realPath = fs.realpathSync(binPath);
      return path.dirname(path.dirname(realPath));
    }
  } catch { /* ignore */ }
  return null;
}

// 从 JSON 文件中提取模型列表
function extractModels(obj) {
  if (!obj) return [];
  const models = obj.models || obj;
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => m.id && !m.tags?.includes('text-to-image') && !m.tags?.includes('image-to-image') && !m.tags?.includes('text-to-video') && !m.tags?.includes('image-to-video'))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      credits: m.credits || null,
      maxInputTokens: m.maxInputTokens || null,
      maxOutputTokens: m.maxOutputTokens || null,
      supportsImages: m.supportsImages || false,
      supportsToolCall: m.supportsToolCall || false,
      supportsReasoning: m.supportsReasoning || false,
      vendor: m.vendor || null,
    }));
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
            console.log(`  [models] Loaded ${models.length} models from local_storage cache (${file})`);
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
            console.log(`  [models] Loaded ${models.length} models from compressed cache (${file})`);
            return models;
          }
        }
      } catch { /* not gzip */ }
    }
  } catch (e) {
    console.warn('  [models] Failed to read local_storage cache:', e.message);
  }
  return null;
}

// 从 CLI 包的 product config 文件读取
function loadFromProductConfig() {
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
      console.log(`  [models] Loaded ${models.length} models from ${file}`);
    } catch (e) {
      console.warn(`  [models] Failed to load ${file}:`, e.message);
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
    if (models.length > 0) console.log(`  [models] Loaded ${models.length} custom models from models.json`);
    return models;
  } catch { /* ignore */ }
  return [];
}

// ─── 主函数：合并所有来源 ───────────────────────────────────────────────────
export function loadModels() {
  console.log('  [models] Loading model list...');

  // 优先级：local_storage 缓存 > product config > 空
  const cached = loadFromCache();
  const fromConfig = loadFromProductConfig();
  const customModels = loadFromUserModels();

  // 以缓存为主，config 为补充
  const modelMap = new Map();
  const source = cached || fromConfig || [];
  for (const m of source) modelMap.set(m.id, m);

  // 补充另一个来源中缺少的模型
  const supplement = cached ? fromConfig : null;
  if (supplement) {
    for (const m of supplement) {
      if (!modelMap.has(m.id)) modelMap.set(m.id, m);
    }
  }

  // 合并用户自定义模型
  for (const m of customModels) {
    modelMap.set(m.id, { ...modelMap.get(m.id), ...m });
  }

  const models = [...modelMap.values()];
  console.log(`  [models] Total: ${models.length} models available`);
  return models;
}

// ─── 带缓存的模型获取（文件变更时自动刷新） ────────────────────────────────
let _cachedModels = null;
let _lastLoadTime = 0;
let _loadReturnedEmpty = false;
const CACHE_TTL = 60_000; // 60 秒刷新

export function getModels() {
  const now = Date.now();
  // 加载失败（返回空）时不缓存，每次都重试
  if (!_cachedModels || _loadReturnedEmpty || now - _lastLoadTime > CACHE_TTL) {
    _cachedModels = loadModels();
    _lastLoadTime = now;
    _loadReturnedEmpty = _cachedModels.length === 0;
  }
  return _cachedModels;
}
