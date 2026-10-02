// 用**实时**桌面端响应造一份 status payload，供 align-workbuddy.mjs 做「payload ↔ 卡片」对齐。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ★ 向上找仓库根，不用 `join(HERE,'..')` —— 本文件从 `tmp/` 迁到 `tools/verify/` 时，
//   写死的相对路径会静默指到 `tools/`，报错还完全看不出是路径问题（同一个坑修过两次）。
const HERE = dirname(fileURLToPath(import.meta.url));
function findRepoRoot(from) {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'packages', 'plugin-workbuddy', 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`cannot locate the repository root from ${from}`);
}
const ROOT = findRepoRoot(HERE);
const PKG = join(ROOT, 'packages', 'plugin-workbuddy');
void extname;

const { parseLiveCatalog, LIVE_SOURCE } =
  await import(pathToFileURL(join(PKG, 'src', 'host', 'launch', 'desktop-models.js')).href);

const live = JSON.parse(readFileSync(join(ROOT, 'tmp', 'recon-personal-models.json'), 'utf8'));
const p = parseLiveCatalog(live, Date.now());
if (p === null) { console.error('parse failed'); process.exit(1); }

const payload = {
  pluginId: 'dsh-plugin-workbuddy',
  registry: 'REGISTERED',
  registrationError: null,
  probe: { installed: true, reason: 'ok', resolvedPath: 'C:/Users/demo/.workbuddy/cache/acc-product-config-v3.json', evidence: [], at: Date.now(), method: 'desktop-cache' },
  bound: { bound: false, tail: null },
  config: { enabled: true, model: '', effort: '' },
  effort: { canonical: ['off','minimal','low','medium','high','xhigh','max'], values: { minimal:'minimal', low:'low', medium:'medium', high:'high', xhigh:'xhigh', max:'max' } },
  models: p.models,
  modelsSource: LIVE_SOURCE,
  cost: { target: 'workbuddy', models: p.cost, unknown: null, observedAt: Date.now(), available: true, source: LIVE_SOURCE, reason: null },
  sessions: [],
  inFlight: [],
  lastRun: null,
  credits: { ok: true, source: 'live', remain: 942.03, at: Date.now(), ageMs: 1200, stale: false, unit: 'credits', isPaidUser: false, packages: [], error: null, counters: {} },
  usage: null,
};
writeFileSync('tmp/live-payload.json', JSON.stringify(payload, null, 1));
console.log('models =', p.models.length, '| cost rows =', p.cost.length, '| with factor =', p.cost.filter(c => typeof c.factor === 'number').length);
