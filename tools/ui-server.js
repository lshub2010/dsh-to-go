'use strict';
/**
 * Local configuration server for the portable DeepSeek Harness.
 *
 * Serves ui/config.html and a small JSON API so the whole bundle can be
 * configured from a browser instead of the console menu.
 *
 * Security posture (the page is local, but a browser is a shared process):
 *   - binds 127.0.0.1 only, never 0.0.0.0;
 *   - mints a random per-run token; the page must be opened with ?token=<token>,
 *     and every API call must carry the same token in the x-config-token header,
 *     which a cross-origin page cannot read or forge (so no CSRF);
 *   - any request that carries a foreign Origin header is refused;
 *   - no CORS headers are ever sent;
 *   - the model key travels only inside a loopback POST body and is encrypted
 *     in-process; it is never written to a log, never echoed back.
 *
 *   node tools/ui-server.js [--port 3181] [--no-open]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { spawnSync } = require('child_process');
const secretLib = require('./secret.js');
const siteLib = require('./site.js');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const DATA = path.join(ROOT, 'data');
const NODE_EXE = path.join(RUNTIME, 'node', 'node.exe');
const PAGE = path.join(ROOT, 'ui', 'config.html');
const PORT_FILE = path.join(RUNTIME, 'port.txt');
const SLOT_FILE = path.join(RUNTIME, 'current.txt');
const VERSION_FILE = path.join(ROOT, 'VERSION.txt');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = parseInt(flag('--port', '3181'), 10);
const TOKEN = crypto.randomBytes(24).toString('base64url');
const NO_OPEN = argv.includes('--no-open');

function slotName() {
  try {
    const v = fs.readFileSync(SLOT_FILE, 'utf8').trim();
    return /^agent-[AB]$/.test(v) ? v : 'agent-A';
  } catch (e) { return 'agent-A'; }
}
function otherSlot() { return slotName() === 'agent-A' ? 'agent-B' : 'agent-A'; }
function dshBin(slot) { return path.join(RUNTIME, slot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'); }
function dshVersion(slot) {
  try { return JSON.parse(fs.readFileSync(path.join(RUNTIME, slot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version; }
  catch (e) { return 'not-installed'; }
}
function readPort() {
  try { const v = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10); if (v > 0) return v; } catch (e) { /* default */ }
  return 3180;
}
function nodeVersion() {
  const r = spawnSync(NODE_EXE, ['-v'], { encoding: 'utf8' });
  return String(r.stdout || '').trim() || 'missing';
}
function tail(file, lines) {
  try {
    const t = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    return t.slice(-lines).join('\n');
  } catch (e) { return ''; }
}
function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + ' ' + u[i];
}
function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else { try { total += fs.statSync(full).size; } catch (err) { /* skip */ } }
    }
  }
  return total;
}
function freeSpace() {
  try {
    const s = fs.statfsSync(ROOT);
    return s.bsize * s.bavail;
  } catch (e) { return -1; }
}
/** Whatever `node tools/config.js <args>` prints, as text. */
function runConfig(args) {
  const r = spawnSync(NODE_EXE, [path.join(__dirname, 'config.js')].concat(args), {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 1800000,
  });
  return { status: r.status, text: (String(r.stdout || '') + String(r.stderr || '')).trim() };
}
function runSite(args) {
  const r = spawnSync(NODE_EXE, [path.join(__dirname, 'site.js')].concat(args), {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, text: (String(r.stdout || '') + String(r.stderr || '')).trim() };
}

// ------------------------------------------------------------------ API
function state() {
  const cur = slotName();
  const other = otherSlot();
  const site = (() => { try { return JSON.parse(fs.readFileSync(siteLib.STATE, 'utf8')); } catch (e) { return null; } })();
  const keyFile = secretLib.secretFile();
  const legacyKeyFile = secretLib.legacyFile();
  let keyMeta;
  const keyStore = secretLib.readStore(keyFile);
  if (keyStore) {
    const items = secretLib.listKeys();
    keyMeta = {
      configured: items.length > 0, store: 'v2', verifier: !!keyStore.verifier,
      algo: (keyStore.algo || '') + ' / ' + (keyStore.kdf || ''), bytes: fs.statSync(keyFile).size,
      created: keyStore.updated || null, sites: items,
    };
  } else if (fs.existsSync(legacyKeyFile)) {
    try {
      const blob = JSON.parse(fs.readFileSync(legacyKeyFile, 'utf8'));
      keyMeta = { configured: true, store: 'legacy', created: blob.created || null, algo: blob.algo + ' / ' + blob.kdf, bytes: fs.statSync(legacyKeyFile).size, sites: [] };
    } catch (e) { keyMeta = { configured: false, store: null, sites: [] }; }
  } else {
    keyMeta = { configured: false, store: null, sites: [] };
  }
  return {
    root: ROOT,
    slot: { active: cur, activeVersion: dshVersion(cur), idle: other, idleVersion: dshVersion(other) },
    node: nodeVersion(),
    webPort: readPort(),
    configPort: PORT,
    key: Object.assign({ envName: secretLib.keyName() }, keyMeta),
    site: site ? Object.assign({}, site, { overlayActive: fs.existsSync(siteLib.OVERLAY) }) : null,
    overlayPath: siteLib.OVERLAY,
    profilePatchPath: siteLib.PROFILE_PATCH,
    tempRoot: fs.existsSync(path.join(RUNTIME, 'usb-temp.txt'))
      ? 'runtime\\tmp（在 U 盘上 · ACL 沙箱可能失败）'
      : ((process.env.LOCALAPPDATA || 'C:\\Windows') + '\\Temp（宿主，推荐）'),
    sizes: {
      runtime: human(dirSize(RUNTIME)),
      data: human(dirSize(DATA)),
      cache: human(dirSize(path.join(RUNTIME, 'npm-cache'))),
      free: freeSpace() >= 0 ? human(freeSpace()) : 'unknown',
    },
    lastUpgradeLines: tail(VERSION_FILE, 40).split('\n').filter((l) => l.includes('registry=')).slice(-3),
    launcherLog: tail(path.join(DATA, 'logs', 'launcher.log'), 12),
  };
}

async function handleApi(req, res, url) {
  const send = (code, obj) => {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const bodyText = await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
  let body = {};
  if (bodyText) { try { body = JSON.parse(bodyText); } catch (e) { return send(400, { error: '请求体不是合法 JSON' }); } }

  const p = url.pathname;
  try {
    if (p === '/api/state') return send(200, state());

    if (p === '/api/site' && req.method === 'POST') {
      const s = {
        id: String(body.id || '').trim(),
        baseURL: String(body.baseURL || '').trim(),
        api: String(body.api || 'openai-completions'),
        keyEnv: String(body.keyEnv || 'GATEWAY_API_KEY').trim(),
        models: (Array.isArray(body.models) ? body.models : []).map((m) => ({ id: String(m.id || '').trim(), image: !!m.image })).filter((m) => m.id),
        compat: body.compat === false ? null : { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        updated: new Date().toISOString(),
      };
      if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id)) return send(400, { error: '站点 ID 只能是小写字母/数字/连字符' });
      if (!/^https?:\/\//.test(s.baseURL)) return send(400, { error: '接口地址必须以 http:// 或 https:// 开头' });
      if (!s.models.length) return send(400, { error: '至少需要一个模型 ID' });
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.keyEnv)) return send(400, { error: '密钥变量名必须是合法的环境变量名' });
      const cleaned = siteLib.writeOverlay(s);
      secretLib.setKeyName(s.keyEnv);
      return send(200, { ok: true, cleanedLines: cleaned, overlay: siteLib.OVERLAY, state: state() });
    }

    if (p === '/api/site/clear' && req.method === 'POST') {
      if (fs.existsSync(siteLib.OVERLAY)) fs.unlinkSync(siteLib.OVERLAY);
      const cleaned = siteLib.stripFromProfilePatch(state().site ? state().site.id : undefined);
      try { fs.unlinkSync(siteLib.STATE); } catch (e) { /* already gone */ }
      return send(200, { ok: true, cleanedLines: cleaned, state: state() });
    }

    if (p === '/api/key' && req.method === 'POST') {
      const pass = String(body.pass || '');
      const key = String(body.key || '');
      if (!pass) return send(400, { error: '口令不能为空' });
      if (!key) return send(400, { error: '密钥不能为空' });
      const sitesLib2 = require('./sites.js');
      const st = sitesLib2.readState();
      let siteId = String(body.siteId || '').trim();
      if (!siteId) {
        const en = st.sites.filter((s) => s.enabled !== false);
        siteId = (st.default && st.default.siteId) || (en.length === 1 ? en[0].id : 'default');
      }
      const site = st.sites.find((s) => s.id === siteId);
      const keyName = String(body.keyEnv || (site && site.keyEnv) || '').trim();
      try {
        const r = secretLib.setKey(siteId, key, pass, keyName ? { keyName } : undefined);
        return send(200, { ok: true, siteId: r.siteId, bytes: r.bytes, keyName: r.keyName, length: r.length, state: state() });
      } catch (e) {
        return send(400, { error: String(e && e.message || e) });
      }
    }

    if (p === '/api/key/clear' && req.method === 'POST') {
      const siteId = String(body.siteId || '').trim();
      if (siteId) {
        const removed = secretLib.removeKey(siteId);
        return send(200, { ok: removed, removed, siteId, state: state() });
      }
      secretLib.destroyStore();
      return send(200, { ok: true, destroyedAll: true, state: state() });
    }

    if (p === '/api/keys/migrate' && req.method === 'POST') {
      const pass = String(body.pass || '');
      if (!pass) return send(400, { error: '口令不能为空' });
      const siteId = String(body.siteId || '').trim() || undefined;
      const r = secretLib.migrateLegacy(pass, siteId);
      if (!r.ok) return send(r.reason === 'badpass' ? 400 : 404, { ok: false, error: r.reason === 'badpass' ? '口令不对，无法解密旧密钥' : '没有可迁移的旧密钥文件' });
      return send(200, { ok: true, siteId: r.siteId, keyName: r.keyName, length: r.length, state: state() });
    }

    if (p === '/api/port' && req.method === 'POST') {
      const v = parseInt(body.port, 10);
      if (!(v >= 1 && v <= 65535)) return send(400, { error: '端口必须在 1-65535 之间' });
      fs.writeFileSync(PORT_FILE, String(v) + '\n', 'utf8');
      return send(200, { ok: true, state: state() });
    }

    if (p === '/api/slot/switch' && req.method === 'POST') {
      const r = runConfig(['switch']);
      return send(r.status === 0 ? 200 : 500, { ok: r.status === 0, text: r.text, state: state() });
    }

    if (p === '/api/portable-temp' && req.method === 'POST') {
      const f = path.join(RUNTIME, 'usb-temp.txt');
      if (body.usbTemp) fs.writeFileSync(f, '把临时目录放回 U 盘。注意：ACL 沙箱需要该盘给足 WRITE_OWNER，否则 workspace-write 会失败。\n', 'utf8');
      else { try { fs.unlinkSync(f); } catch (e) { /* already off */ } }
      return send(200, { ok: true, state: state() });
    }

    if (p === '/api/doctor' && req.method === 'POST') {
      const r = runConfig(['doctor']);
      return send(200, { ok: true, text: r.text, state: state() });
    }
    if (p === '/api/dump' && req.method === 'POST') {
      const r = runSite(['dump']);
      return send(200, { ok: true, text: r.text, state: state() });
    }
    if (p === '/api/backup' && req.method === 'POST') {
      const r = runConfig(['backup']);
      return send(200, { ok: true, text: r.text, state: state() });
    }
    if (p === '/api/upgrade' && req.method === 'POST') {
      const v = String(body.version || '').trim();
      if (!v) return send(400, { error: '请填写目标版本号' });
      const r = runConfig(['upgrade', v, '--yes']);
      return send(r.status === 0 ? 200 : 500, { ok: r.status === 0, text: r.text, state: state() });
    }
    return send(404, { error: '没有这个接口：' + p });
  } catch (e) {
    return send(500, { error: String(e && e.message || e) });
  }
}

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const origin = req.headers.origin;
  if (origin && origin !== 'http://127.0.0.1:' + PORT && origin !== 'http://localhost:' + PORT) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('跨站来源被拒绝');
  }
  const tokenOk = url.searchParams.get('token') === TOKEN || req.headers['x-config-token'] === TOKEN;
  if (!tokenOk) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('需要访问令牌：请使用启动时打印的带 token 的地址打开配置页。');
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let html = '';
    try { html = fs.readFileSync(PAGE, 'utf8'); } catch (e) { html = '<h1>缺少 ui/config.html</h1>'; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const link = 'http://127.0.0.1:' + PORT + '/?token=' + TOKEN;
  console.log('');
  console.log('  便携版 DeepSeek Harness —— 图形配置页');
  console.log('  地址：' + link);
  console.log('  （令牌每次启动随机生成；页面只在 127.0.0.1 上提供，关闭本窗口即失效）');
  console.log('  按 Ctrl+C 结束。');
  console.log('');
  if (!NO_OPEN) {
    try { spawnSync('cmd', ['/c', 'start', '', link], { windowsHide: true }); } catch (e) { /* user can click the link */ }
  }
});
