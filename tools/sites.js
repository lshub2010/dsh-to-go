'use strict';
/**
 * 多站点存储 + 覆盖层生成（棒 1）
 *
 * 单一事实来源是 data\sites.json；data\site-patch.yml 是**生成物**，启动器把它作为
 * `--patch` 传给 dsh。写入前会备份到 backups\。
 *
 * 关键事实（已实测，勿再猜）：
 *   - 一个覆盖层条目（`- id: llm-pi-ai`）的 config.providers 里可以放多个站点；
 *   - 覆盖层条目可以写 `disabled: true` 停掉一个已有插件条目（打印位置在 config 之后）；
 *   - patch 的 config **整块替换**，所以 providers 里的内容以 sites.json 为准，
 *     不要指望能跟别处的 provider 合并。
 *
 * 兼容：老的 data\site.json（单站点）会被自动读成多站点结构，且不会被删除。
 *
 * CLI: node tools/sites.js list|overlay|probe <url> [key]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.WZD_DATA_DIR || path.join(ROOT, 'data');
const SITES_FILE = path.join(DATA, 'sites.json');
const LEGACY_SITE_FILE = path.join(DATA, 'site.json');
const OVERLAY = path.join(DATA, 'site-patch.yml');
const BACKUP_DIR = path.join(ROOT, 'backups');

const PROVIDER_ENTRY = 'llm-pi-ai';
const DEFAULT_MODEL_ENTRY = 'agent-default-model';
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 站点 ID → 环境变量名：my-relay → MY_RELAY_API_KEY */
function keyEnvFor(id) {
  let base = String(id || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'SITE';
  if (/^[0-9]/.test(base)) base = '_' + base;
  return base + '_API_KEY';
}

function emptyState() {
  return { version: 1, default: null, sites: [] };
}

function normalizeModel(m) {
  const id = String((m && m.id) || '').trim();
  if (!id) return null;
  return { id, image: !!(m && m.image) };
}

/** 校验并补全一个站点对象；不合法则抛错（带中文原因）。 */
function normalizeSite(site) {
  const s = site || {};
  const id = String(s.id || '').trim();
  if (!ID_RE.test(id)) throw new Error('站点 ID 只能是小写字母/数字/连字符，且不能以连字符开头：' + id);
  const baseURL = String(s.baseURL || '').trim();
  if (!/^https?:\/\//.test(baseURL)) throw new Error('接口地址必须以 http:// 或 https:// 开头');
  const api = String(s.api || 'openai-completions');
  if (PROTOCOLS.indexOf(api) < 0) throw new Error('不支持的协议：' + api + '（可选：' + PROTOCOLS.join(' / ') + '）');
  const keyEnv = String(s.keyEnv || keyEnvFor(id)).trim();
  if (!ENV_RE.test(keyEnv)) throw new Error('密钥变量名不是合法的环境变量名：' + keyEnv);
  const models = (Array.isArray(s.models) ? s.models : []).map(normalizeModel).filter(Boolean);
  if (!models.length) throw new Error('站点 ' + id + ' 至少要有一个模型');
  const out = {
    id,
    name: String(s.name || '').trim(),
    baseURL,
    api,
    keyEnv,
    enabled: s.enabled !== false,
    models,
    // compat 只在「显式配置」时才产出：undefined 视为未配置（不要替用户做决定、也不要覆盖
    // dsh 的默认行为）；null / false 同样表示不要兼容修正。
    compat: (s.compat === true || (s.compat && typeof s.compat === 'object'))
      ? {
        supportsDeveloperRole: s.compat.supportsDeveloperRole === true,
        maxTokensField: s.compat.maxTokensField || 'max_tokens',
      }
      : null,
    updated: new Date().toISOString(),
  };
  if (s.reasoning) out.reasoning = String(s.reasoning);
  return out;
}

/** 读站点表；不存在时尝试把老的 data\site.json 转成新结构。 */
function readState(dir) {
  const file = dir ? path.join(dir, 'sites.json') : SITES_FILE;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j.sites)) {
      return {
        version: 1,
        default: j.default || null,
        sites: j.sites.map((s) => {
          const models = (s.models || []).map(normalizeModel).filter(Boolean);
          return Object.assign({}, s, { models, enabled: s.enabled !== false });
        }),
      };
    }
  } catch (e) { /* fall through to legacy */ }
  const legacyFile = dir ? path.join(dir, 'site.json') : LEGACY_SITE_FILE;
  try {
    const old = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    if (old && old.id) {
      const models = (old.models || []).map(normalizeModel).filter(Boolean);
      return {
        version: 1,
        default: models.length ? { siteId: old.id, model: models[0].id } : null,
        sites: [{
          id: old.id, name: '', baseURL: old.baseURL, api: old.api || 'openai-completions',
          keyEnv: old.keyEnv || keyEnvFor(old.id), enabled: true, models,
          compat: old.compat || null, updated: old.updated || null,
        }],
      };
    }
  } catch (e) { /* nothing configured yet */ }
  return emptyState();
}

function writeState(state, dir) {
  const file = dir ? path.join(dir, 'sites.json') : SITES_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 增改站点；返回新的 state（不改原对象）。 */
function upsert(state, site) {
  const s = normalizeSite(site);
  const next = { version: 1, default: state && state.default ? Object.assign({}, state.default) : null, sites: (state && state.sites ? state.sites : []).slice() };
  // 变量名必须唯一：不同站点 ID 可能推导出同一个环境变量名（如 a-b 与 a--b），
  // 撞了就会互相覆盖密钥，所以要在这里拦住并要求显式指定一个不同的名字。
  const clash = next.sites.find((x) => x.id !== s.id && x.keyEnv === s.keyEnv);
  if (clash) {
    throw new Error('变量名 ' + s.keyEnv + ' 已被站点 ' + clash.id + ' 占用（' + s.id + ' 与它推导出同一个名字），请手动指定一个不同的密钥变量名');
  }
  const i = next.sites.findIndex((x) => x.id === s.id);
  if (i >= 0) next.sites[i] = Object.assign({}, next.sites[i], s);
  else next.sites.push(s);
  // 默认站点被停用后不能继续当默认（否则覆盖层会写出指向不存在 provider 的默认模型）
  if (next.default && next.default.siteId === s.id) {
    const cur = next.sites.find((x) => x.id === s.id);
    if (!cur || cur.enabled === false || !cur.models.some((m) => m.id === next.default.model)) next.default = null;
  }
  return next;
}

function removeSite(state, id) {
  const next = { version: 1, default: state && state.default ? Object.assign({}, state.default) : null, sites: (state && state.sites ? state.sites : []).filter((x) => x.id !== id) };
  if (next.default && next.default.siteId === id) next.default = null;
  return next;
}

/** 设置默认模型；siteId/model 必须存在且已启用模型。传 null 清空。 */
function setDefault(state, siteId, model) {
  const next = { version: 1, default: null, sites: (state && state.sites ? state.sites : []).slice() };
  if (!siteId || !model) return next;
  const site = next.sites.find((s) => s.id === siteId);
  if (!site) throw new Error('没有这个站点：' + siteId);
  if (site.enabled === false) throw new Error('站点 ' + siteId + ' 已停用，不能作为默认模型来源');
  if (!site.models.some((m) => m.id === model)) throw new Error('站点 ' + siteId + ' 里没有这个模型：' + model);
  next.default = { siteId, model };
  return next;
}

/** 只在真正有歧义时才加引号（`a: b`/行首符号/布尔数字等），保持输出可读。 */
function yamlScalar(v) {
  const s = String(v);
  const needsQuote =
    s === '' ||
    /^\s|\s$/.test(s) ||
    /:\s|#/.test(s) ||
    /:$/.test(s) ||
    /[\n\r\t]/.test(s) ||
    /^[!&*\-?|>%@`"'[\]{},]/.test(s) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /^[-+]?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(s);
  return needsQuote ? JSON.stringify(s) : s;
}

/**
 * 生成覆盖层文本。
 * @param state 站点表
 * @param opts.disabled  要停用的插件条目 id 数组（变成 `- id: X` + `disabled: true`）
 */
function buildOverlay(state, opts) {
  const o = opts || {};
  const L = [];
  L.push('# 站点/插件覆盖层 —— 本文件由 dsh-to-go 生成，请勿手改（下次保存会被覆盖）。');
  L.push('# 单一事实来源：data\\sites.json（站点）与 data\\plugins.json（插件启停）。');
  L.push('# 启动器把它作为 --patch 传给 dsh；profile 的 cordis.patch.yml 始终归 dsh 与其 Web UI 所有。');
  const enabled = (state.sites || []).filter((s) => s.enabled !== false);
  if (enabled.length) {
    L.push('- id: ' + PROVIDER_ENTRY);
    L.push('  config:');
    L.push('    providers:');
    for (const s of enabled) {
      L.push('      ' + s.id + ':');
      L.push('        apiKeyEnv: ' + yamlScalar(s.keyEnv));
      L.push('        api: ' + yamlScalar(s.api));
      L.push('        baseURL: ' + yamlScalar(s.baseURL));
      if (s.compat) {
        L.push('        compat:');
        L.push('          supportsDeveloperRole: ' + (s.compat.supportsDeveloperRole ? 'true' : 'false'));
        L.push('          maxTokensField: ' + yamlScalar(s.compat.maxTokensField || 'max_tokens'));
      }
      if (s.reasoning) L.push('        reasoning: ' + yamlScalar(s.reasoning));
      L.push('        models:');
      for (const m of s.models) {
        L.push('          - id: ' + yamlScalar(m.id));
        if (m.image) L.push('            input: [text, image]');
      }
    }
  }
  // 默认模型只在「该站点已启用且模型还在」时才写：否则会留下指向不存在 provider 的悬空引用
  const defSite = state.default ? enabled.find((s) => s.id === state.default.siteId) : null;
  const defOk = !!(defSite && defSite.models.some((m) => m.id === state.default.model));
  if (defOk) {
    L.push('- id: ' + DEFAULT_MODEL_ENTRY);
    L.push('  config:');
    L.push('    provider: ' + yamlScalar(state.default.siteId));
    L.push('    model: ' + yamlScalar(state.default.model));
  } else if (state.default) {
    L.push('# 注意：默认模型指向的站点已停用或该模型已删除，本次没有写入 ' + DEFAULT_MODEL_ENTRY);
  }
  // 我们自己占用的条目 id 绝不能被当成「要停用的插件」——否则会把 provider 覆盖层整块关掉
  const reserved = [PROVIDER_ENTRY, DEFAULT_MODEL_ENTRY];
  for (const id of (o.disabled || []).slice().filter((x) => reserved.indexOf(x) < 0).sort()) {
    L.push('- id: ' + yamlScalar(id));
    L.push('  disabled: true');
  }
  return L.join('\n') + '\n';
}

/** 写覆盖层（内容没变就不写、也不备份；变了才先备份旧文件）。返回 { overlay, backup, text, unchanged }。 */
function writeOverlay(state, opts) {
  fs.mkdirSync(DATA, { recursive: true });
  const text = buildOverlay(state, opts);
  let prev = null;
  try { prev = fs.readFileSync(OVERLAY, 'utf8'); } catch (e) { /* 首次生成 */ }
  if (prev === text) return { overlay: OVERLAY, backup: null, text, unchanged: true };
  let backup = null;
  if (prev !== null) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = path.join(BACKUP_DIR, 'overlay-' + stamp + '.yml');
    fs.copyFileSync(OVERLAY, backup);
  }
  const tmp = OVERLAY + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, OVERLAY);
  return { overlay: OVERLAY, backup, text, unchanged: false };
}

/**
 * 探测站点的模型列表。两种常见形状都认：
 *   OpenAI  : { data: [ { id } ] }
 *   Anthropic 风格 / 其它: { models: [ { id } ] } 或 { data: [ { name } ] }
 */
async function probeModels(cfg) {
  const c = cfg || {};
  const baseURL = String(c.baseURL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseURL)) return { ok: false, error: '接口地址必须以 http:// 或 https:// 开头' };
  const url = baseURL + '/models';
  const headers = { Accept: 'application/json' };
  if (c.key) {
    if (c.api === 'anthropic-messages') { headers['x-api-key'] = c.key; headers['anthropic-version'] = '2023-06-01'; }
    else headers.Authorization = 'Bearer ' + c.key;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), c.timeoutMs || 15000);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: 'HTTP ' + res.status + '：' + text.slice(0, 200) };
    }
    let j = null;
    try { j = JSON.parse(text); } catch (e) { return { ok: false, status: res.status, error: '返回不是 JSON（前 120 字）：' + text.slice(0, 120) }; }
    const list = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : (Array.isArray(j) ? j : []));
    const ids = list.map((m) => String((m && (m.id || m.name || m.model)) || '').trim()).filter(Boolean);
    return { ok: true, status: res.status, models: Array.from(new Set(ids)), raw: list.length };
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? ('超时（' + (c.timeoutMs || 15000) + 'ms 内没有响应）') : String(e && e.message || e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ CLI
async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || 'list').toLowerCase();
  if (cmd === 'list') {
    const st = readState();
    console.log('');
    console.log('  站点数：' + st.sites.length + '   默认模型：' + (st.default ? st.default.siteId + ' / ' + st.default.model : '（未设置）'));
    for (const s of st.sites) {
      console.log('  - ' + s.id + (s.enabled === false ? '（已停用）' : '') + '  ' + s.baseURL);
      console.log('      协议 ' + s.api + ' · 密钥变量 ' + s.keyEnv + ' · 模型 ' + s.models.map((m) => m.id + (m.image ? '(含图)' : '')).join(', '));
    }
    console.log('  文件：' + SITES_FILE + (fs.existsSync(SITES_FILE) ? '' : '（不存在，尚未配置）'));
    console.log('');
    return 0;
  }
  if (cmd === 'overlay') {
    const st = readState();
    const r = writeOverlay(st);
    console.log('  已生成覆盖层：' + r.overlay + (r.backup ? '（旧文件备份到 ' + r.backup + '）' : ''));
    console.log(r.text.split('\n').map((l) => '  ' + l).join('\n'));
    return 0;
  }
  if (cmd === 'probe') {
    const baseURL = argv[1];
    // 密钥只从环境变量取：放进命令行会出现在进程列表与命令历史里（硬规则）
    const key = process.env.WZD_PROBE_KEY || '';
    const r = await probeModels({ baseURL, key, api: argv[2] || 'openai-completions' });
    if (!r.ok) { console.log('  探测失败：' + r.error); return 1; }
    console.log('  探测成功（HTTP ' + r.status + '），模型 ' + r.models.length + ' 个：');
    for (const m of r.models) console.log('    ' + m);
    return 0;
  }
  console.log('用法：');
  console.log('  node tools/sites.js list');
  console.log('  node tools/sites.js overlay');
  console.log('  node tools/sites.js probe <接口地址> [协议]     （密钥放环境变量 WZD_PROBE_KEY，勿用命令行传）');
  return 2;
}

module.exports = {
  ROOT, DATA, SITES_FILE, LEGACY_SITE_FILE, OVERLAY, BACKUP_DIR,
  PROVIDER_ENTRY, DEFAULT_MODEL_ENTRY, PROTOCOLS,
  keyEnvFor, emptyState, normalizeSite, readState, writeState, upsert, removeSite, setDefault,
  buildOverlay, writeOverlay, probeModels,
};

if (require.main === module) {
  main().then((rc) => process.exit(rc)).catch((e) => { console.error('站点模块错误：' + e.message); process.exit(1); });
}
