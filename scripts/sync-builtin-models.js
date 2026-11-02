#!/usr/bin/env node
/**
 * 用桌面端缓存的 product config 重新生成 src/builtin-models.json。
 *
 * builtin-models.json 是「没有 WorkBuddy 桌面端缓存 / CLI 包配置」时的兜底模型列表，
 * 必须与上游保持同样的 id、上下文长度、思考档位与 credits。手写维护极易漂移
 * （历史事故：hy4-preview 的 maxOutputTokens 写成 100000、supportsImages 写成 false、
 * description 里的参数量是编的；hy3 缺 supportedEfforts、hy3-x 干脆没有）。
 *
 * 用法：
 *   node scripts/sync-builtin-models.js            # 写入 src/builtin-models.json
 *   node scripts/sync-builtin-models.js --check    # 只校验是否已同步（CI/提交前用）
 *   node scripts/sync-builtin-models.js --diff     # 打印差异，不写入
 *
 * 数据来源由 src/lib/product-config.js 解析：默认取
 * ~/.workbuddy/cache/acc-product-config-v3-<pid>-<uuid>.json 中 mtime 最新、
 * 且带 agents 段的桌面端快照。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProductConfig } from '../src/lib/product-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'src', 'builtin-models.json');

// 体积大且与运行时无关的展示字段，不进兜底列表
const DROP_FIELDS = new Set(['iconUrl']);

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const DIFF = args.has('--diff');

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

// 解析现有兜底列表；文件缺失或损坏时返回 null（视为「需要重新生成」）
function readCurrent() {
  if (!fs.existsSync(OUT_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 桌面端缓存是多份带 pid/uuid 的快照，解析失败说明当前这份正在被写入。
// 给出明确报错，不要把异常直接抛成堆栈。
const resolved = resolveProductConfig();
if (!resolved) {
  fail('找不到可用的桌面端 product config\n'
    + '    期望 ~/.workbuddy/cache/acc-product-config-v3-<pid>-<uuid>.json 中有一份带 agents 段。\n'
    + '    请先启动 WorkBuddy 桌面端同步云端配置，或用 WORKBUDDY_PRODUCT_CONFIG 指定路径。');
}
const { path: configPath, config } = resolved;

// 与 src/models.js 的 craftModelIds() 保持一致：以 craft agent 的白名单为准，
// models[] 里还有大量未在 UI 展示的内部/历史模型。
const craftAgent = (config.agents || [])
  .find((a) => (a.modelTags || []).includes('craft') && a.models?.length);
if (!craftAgent) fail('product config 里找不到 craft agent 的 models 白名单。');

const byId = new Map((config.models || []).map((m) => [m.id, m]));
const missing = craftAgent.models.filter((id) => !byId.has(id));
if (missing.length) fail(`白名单中的模型在 models[] 里缺失: ${missing.join(', ')}`);

// 按白名单顺序输出，且是上游条目的原样快照（只去掉 iconUrl）。
// src/models.js 的 extractModels() 会做统一的字段映射，这里不重复裁剪，
// 以免两边各写一份字段名后再漂移。
const models = craftAgent.models.map((id) => {
  const m = byId.get(id);
  return Object.fromEntries(
    Object.entries(m).filter(([k]) => !DROP_FIELDS.has(k)),
  );
});

const text = `${JSON.stringify(models, null, 2)}\n`;

if (DIFF || CHECK) {
  const current = readCurrent();
  const same = current
    && JSON.stringify(current) === JSON.stringify(models);

  if (same) {
    console.log(`  ✓ src/builtin-models.json 已与 product config 同步（${models.length} 个模型）`);
    process.exit(0);
  }

  console.error(`  ✗ src/builtin-models.json 与 product config 不一致（上游 ${models.length} 个模型）`);
  if (DIFF) {
    const cur = current || [];
    const curIds = new Set(cur.map((m) => m.id));
    const newIds = new Set(models.map((m) => m.id));
    for (const m of models) {
      if (!curIds.has(m.id)) console.error(`      + ${m.id}`);
      else if (JSON.stringify(cur.find((c) => c.id === m.id)) !== JSON.stringify(m)) {
        console.error(`      ~ ${m.id}`);
      }
    }
    for (const m of cur) if (!newIds.has(m.id)) console.error(`      - ${m.id}`);
  }
  process.exit(CHECK ? 1 : 0);
}

fs.writeFileSync(OUT_PATH, text);
console.log(`  ✓ 已写入 src/builtin-models.json（${models.length} 个模型，来源 ${configPath}）`);
