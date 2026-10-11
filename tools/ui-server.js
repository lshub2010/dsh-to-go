'use strict';
/**
 * Local configuration server for the portable DeepSeek Harness.
 *
 * Serves ui/app.html and a small JSON API so the whole bundle can be
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
const { spawn, spawnSync } = require('child_process');
const secretLib = require('./secret.js');
const siteLib = require('./site.js');
const jobsLib = require('./jobs.js');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const DATA = path.join(ROOT, 'data');
const NODE_EXE = path.join(RUNTIME, 'node', 'node.exe');
const PAGE = path.join(ROOT, 'ui', 'app.html');
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

// ---------------------------------------------------------------- 口令会话
// 口令只活在这个进程的内存里：页面用 /api/login 交一次，之后凡是「碰密钥 / 启停 dsh /
// 跑安装任务」的操作都要求已登录。进程一退，口令就没了（这正是设计目标）。
const SESSION = { pass: null, since: null, tries: 0 };
const DSH_STATE_FILE = () => path.join(DATA, 'dsh-web.json');
let dshChild = null;      // 本进程启动的 dsh 子进程
let dshInfo = null;       // { pid, port, url, startedAt }

function readDshInfo() {
  if (dshInfo) return dshInfo;
  try { dshInfo = JSON.parse(fs.readFileSync(DSH_STATE_FILE(), 'utf8')); } catch (e) { dshInfo = null; }
  return dshInfo;
}
function writeDshInfo(info) {
  dshInfo = info;
  try {
    if (info) fs.writeFileSync(DSH_STATE_FILE(), JSON.stringify(info, null, 2) + '\n', 'utf8');
    else { try { fs.unlinkSync(DSH_STATE_FILE()); } catch (e) { /* 已无 */ } }
  } catch (e) { /* 状态文件写不了不影响使用 */ }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
let portCache = { at: 0, port: 0, value: false };
function portListening(port) {
  const now = Date.now();
  if (portCache.port === port && now - portCache.at < 2000) return portCache.value;
  let value = false;
  try {
    const ns = String(spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '');
    value = ns.split(/\r?\n/).some((l) => l.includes(':' + port + ' ') && /LISTENING/i.test(l));
  } catch (e) { value = false; }
  portCache = { at: now, port, value };
  return value;
}
/** dsh 是否在跑：优先看我们自己起的子进程，其次看端口是否有人监听。 */
function dshStatus() {
  const info = readDshInfo() || {};
  const webPort = readPort();
  const mine = dshChild && dshChild.exitCode === null;
  const alive = mine || pidAlive(info.pid);
  const listening = portListening(webPort);
  return {
    running: !!(alive && listening) || (listening && pidAlive(info.pid)),
    startedByThisProcess: !!mine,
    pid: alive ? (mine ? dshChild.pid : info.pid) : null,
    port: webPort,
    url: listening ? (info.url || null) : null,
    startedAt: info.startedAt || null,
  };
}
function requireLogin() {
  return !!SESSION.pass;
}
/** 插件停用清单（data\plugins.json，由插件页维护）。 */
function readDisabledPlugins() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, 'plugins.json'), 'utf8'));
    return Array.isArray(j.disabled) ? j.disabled : [];
  } catch (e) { return []; }
}
function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}
/** 某个 PID 的命令行（结束进程前用它确认「这确实是 dsh」，避免 PID 复用误杀）。 */
function pidCommandLine(pid) {
  if (!pid) return '';
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      '(Get-CimInstance Win32_Process -Filter "ProcessId = ' + Number(pid) + '").CommandLine'],
      { encoding: 'utf8', timeout: 8000 });
    return String(r.stdout || '').trim();
  } catch (e) { return ''; }
}

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
    loggedIn: requireLogin(),
    loginAt: SESSION.since,
    dsh: dshStatus(),
    jobs: jobsLib.status(),
    sites: (() => {
      try {
        const st = require('./sites.js').readState();
        return { list: st.sites, default: st.default };
      } catch (e) { return { list: [], default: null }; }
    })(),
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
  // 需要「已输入口令」才允许的写操作：碰密钥、跑安装/插件、启停进程。
  // 端口/临时目录这类不碰密钥的设置不在此列。
  const NEEDS_LOGIN = ['/api/key', '/api/key/clear', '/api/keys/migrate', '/api/site', '/api/site/clear',
    '/api/upgrade', '/api/jobs/install', '/api/jobs/upgrade', '/api/jobs/pnpm', '/api/jobs/cancel',
    '/api/dsh/start', '/api/dsh/stop', '/api/backup'];
  if (req.method === 'POST' && NEEDS_LOGIN.indexOf(p) >= 0 && !requireLogin()) {
    return send(401, { error: '需要先输入口令解锁（口令只存在本服务的内存里）' });
  }
  try {
    if (p === '/api/state') return send(200, state());

    if (p === '/api/site' && req.method === 'POST') {
      // 旧的单站点接口：站点表（data\sites.json）已是唯一事实来源，这条路会让浏览器里
      // 缓存的旧页面绕开新逻辑、写进另一个状态文件（data\site.json），所以直接下线。
      return send(410, { error: '该接口已下线，请刷新页面（新接口是 /api/sites）' });
    }

    if (p === '/api/site/clear' && req.method === 'POST') {
      return send(410, { error: '该接口已下线，请刷新页面（新接口是 /api/sites/delete）' });
    }

    if (p === '/api/key' && req.method === 'POST') {
      // 口令优先用请求体里的；页面已登录时直接复用会话里的口令——
      // 前端就不必把口令再存一份，也就没有"口令在页面里长久驻留"的问题。
      const pass = String(body.pass || '') || (requireLogin() ? SESSION.pass : '');
      const key = String(body.key || '');
      if (!pass) return send(400, { error: '口令不能为空（请先解锁）' });
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
      // 删除整个密钥库是重操作：必须显式确认 + 再验一次口令。
      // 缺字段/拼错字段的请求一律拒绝——不能让一个前端 bug 把用户所有密钥删掉。
      if (String(body.confirm || '') !== 'DELETE_ALL') {
        return send(400, { error: '要删除整个密钥库，请显式传 confirm: "DELETE_ALL"（并带上 siteId 则只删该站点）' });
      }
      if (!body.pass || !secretLib.verifyPass(String(body.pass))) {
        return send(400, { error: '删除整个密钥库需要再输入一次当前口令' });
      }
      secretLib.destroyStore();
      SESSION.pass = null;      // 口令校验器一起没了，本次会话随之失效
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
    if (p === '/api/login' && req.method === 'POST') {
      const pass = String(body.pass || '');
      if (!pass) return send(400, { error: '口令不能为空' });
      const siteCount = require('./sites.js').readState().sites.length;
      const store = secretLib.readStore();
      if (!store || !store.verifier) {
        // 首次：设置口令（只建立校验器，不解密任何东西）
        if (!body.setup) {
          return send(200, { ok: true, firstRun: true, message: '还没有设置过口令 —— 请确认后设置口令（它会同时用来加密站点密钥）' });
        }
        secretLib.ensurePass(pass);
        SESSION.pass = pass; SESSION.since = new Date().toISOString(); SESSION.tries = 0;
        return send(200, { ok: true, firstRun: true, created: true, loginAt: SESSION.since, state: state() });
      }
      if (!secretLib.verifyPass(pass)) {
        SESSION.tries++;
        return send(401, { ok: false, error: '口令不对（第 ' + SESSION.tries + ' 次）' });
      }
      SESSION.pass = pass; SESSION.since = new Date().toISOString(); SESSION.tries = 0;
      return send(200, { ok: true, loginAt: SESSION.since, siteCount, state: state() });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      SESSION.pass = null; SESSION.since = null;
      return send(200, { ok: true, loggedIn: false, state: state() });
    }

    // ------------------------------------------------------------ dsh 启停
    if (p === '/api/dsh/start' && req.method === 'POST') {
      if (!requireLogin()) return send(401, { error: '需要先输入口令解锁' });
      const before = dshStatus();
      if (before.running) return send(409, { error: 'dsh 已经在运行', state: state() });
      const webPort = readPort();
      if (portListening(webPort)) return send(409, { error: '端口 ' + webPort + ' 已被别的程序占用（dsh 不会自动换端口）', state: state() });
      // 口令只经子进程环境变量传递：不进命令行、不落盘
      const child = spawn(NODE_EXE, [path.join(__dirname, 'launch.js'), 'web', '--no-open'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { WZD_KEY_PASS: SESSION.pass }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      dshChild = child;
      let out = '';
      const onData = (b) => {
        out += b.toString();
        const m = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/.exec(out);
        if (m) writeDshInfo({ pid: child.pid, port: webPort, url: m[1], startedAt: new Date().toISOString() });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => {
        writeDshInfo(null);
        dshChild = null;
        try {
          fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
          fs.appendFileSync(path.join(DATA, 'logs', 'launcher.log'),
            '[' + new Date().toISOString() + '] ui-server: dsh web exited code=' + code + '\n', 'utf8');
        } catch (e) { /* 日志不是关键路径 */ }
      });
      const t0 = Date.now();
      while (Date.now() - t0 < 45000) {
        if (portListening(webPort)) break;
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const after = dshStatus();
      return send(after.running ? 200 : 500, {
        ok: after.running,
        text: out.split('\n').filter(Boolean).slice(-8).join('\n'),
        state: state(),
      });
    }

    if (p === '/api/dsh/stop' && req.method === 'POST') {
      if (!requireLogin()) return send(401, { error: '需要先输入口令解锁' });
      const st = dshStatus();
      if (!st.running) { writeDshInfo(null); return send(200, { ok: true, already: true, state: state() }); }
      const pid = st.pid;
      const cmdline = pidCommandLine(pid);
      if (!cmdline || !/launch\.js|@deepseek-ai|dsh/i.test(cmdline)) {
        return send(409, { error: 'PID ' + pid + ' 看起来不是 dsh（命令行不匹配），拒绝结束进程以免误杀', cmdline: cmdline.slice(0, 200) });
      }
      try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }); } catch (e) { /* 忽略 */ }
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && portListening(readPort())) await new Promise((r) => setTimeout(r, 400));
      writeDshInfo(null);
      dshChild = null;
      const released = !portListening(readPort());
      return send(released ? 200 : 500, { ok: released, state: state() });
    }

    // ------------------------------------------------------------ 后台任务
    if (p === '/api/jobs' && req.method === 'GET') return send(200, jobsLib.status());
    if (p === '/api/jobs/log' && req.method === 'GET') {
      return send(200, jobsLib.readLog(url.searchParams.get('id'), Number(url.searchParams.get('from') || 0)));
    }
    if ((p === '/api/jobs/install' || p === '/api/jobs/upgrade' || p === '/api/jobs/pnpm') && req.method === 'POST') {
      if (!requireLogin()) return send(401, { error: '需要先输入口令解锁' });
      if (dshStatus().running) return send(409, { error: 'dsh 正在运行 —— 先停止它再做安装/升级/插件操作', state: state() });
      let r;
      if (p === '/api/jobs/install') r = jobsLib.spawnJob('install-slot', { slot: String(body.slot || 'agent-A'), version: String(body.version || '').trim() });
      else if (p === '/api/jobs/upgrade') r = jobsLib.spawnJob('upgrade', { version: String(body.version || '').trim() });
      else r = jobsLib.spawnJob('plugin-pnpm', { args: Array.isArray(body.args) ? body.args.map(String) : [], profile: String(body.profile || 'web') });
      if (!r.ok) return send(r.busy ? 409 : 400, { ok: false, error: r.error, busy: !!r.busy, job: r.job || null });
      return send(200, { ok: true, job: r.job });
    }
    if (p === '/api/jobs/cancel' && req.method === 'POST') {
      if (!requireLogin()) return send(401, { error: '需要先输入口令解锁' });
      const r = jobsLib.cancelJob(String(body.id || ''));
      return send(r.ok ? 200 : 400, { ok: r.ok, error: r.error, job: r.job || null, state: state() });
    }

    // ------------------------------------------------------------ 站点表
    // 唯一事实来源是 data\sites.json（sites.js）；覆盖层由它生成。
    // 旧的单站点接口 /api/site 保留，但同样写进 sites.js，避免出现两套事实。
    if (p === '/api/sites' && req.method === 'GET') {
      const sitesLib = require('./sites.js');
      const st = sitesLib.readState();
      return send(200, {
        sites: st.sites, default: st.default,
        overlay: sitesLib.OVERLAY, overlayExists: fs.existsSync(sitesLib.OVERLAY),
        disabledPlugins: readDisabledPlugins(),
      });
    }

    if (p === '/api/sites' && req.method === 'POST') {
      const sitesLib = require('./sites.js');
      try {
        let st = sitesLib.upsert(sitesLib.readState(), body.site || body);
        const siteId = (body.site && body.site.id) || body.id;
        if (body.default && body.default.siteId) st = sitesLib.setDefault(st, body.default.siteId, body.default.model);
        else if (!st.default) {
          const s = st.sites.find((x) => x.id === siteId);
          if (s && s.enabled !== false) st = sitesLib.setDefault(st, s.id, s.models[0].id);
        }
        sitesLib.writeState(st);
        const w = sitesLib.writeOverlay(st, { disabled: readDisabledPlugins() });
        return send(200, { ok: true, overlay: w.overlay, backup: w.backup, sites: st.sites, default: st.default, state: state() });
      } catch (e) {
        return send(400, { error: String(e && e.message || e) });
      }
    }

    if (p === '/api/sites/delete' && req.method === 'POST') {
      const sitesLib = require('./sites.js');
      const siteId = String(body.siteId || '').trim();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(siteId)) return send(400, { error: '站点 ID 不合法' });
      let st = sitesLib.removeSite(sitesLib.readState(), siteId);
      sitesLib.writeState(st);
      const w = sitesLib.writeOverlay(st, { disabled: readDisabledPlugins() });
      let keyRemoved = false;
      if (body.removeKey) keyRemoved = secretLib.removeKey(siteId);
      return send(200, { ok: true, keyRemoved, overlay: w.overlay, sites: st.sites, default: st.default, state: state() });
    }

    if (p === '/api/sites/probe' && req.method === 'POST') {
      const sitesLib = require('./sites.js');
      let key = String(body.key || '');
      // 没带密钥时（页面刚打开、用户还没重输）就用已保存的那把，需要已登录
      if (!key && body.siteId && requireLogin()) {
        const un = secretLib.unlockAll(SESSION.pass);
        if (un.ok && un.keys[String(body.siteId)]) key = un.keys[String(body.siteId)];
      }
      const r = await sitesLib.probeModels({
        baseURL: String(body.baseURL || ''), api: String(body.api || 'openai-completions'),
        key, timeoutMs: Number(body.timeoutMs) || 15000,
      });
      return send(r.ok ? 200 : 502, r);
    }

    if (p === '/api/overlay/rebuild' && req.method === 'POST') {
      const sitesLib = require('./sites.js');
      const st = sitesLib.readState();
      const w = sitesLib.writeOverlay(st, { disabled: readDisabledPlugins() });
      const dump = runSite(['dump']);
      return send(200, { ok: true, overlay: w.overlay, backup: w.backup, dump: dump.text, state: state() });
    }

    // 旧的单站点接口：保留可用，但改为写 sites.js（单一事实来源）
    if (p === '/api/site' && req.method === 'POST') {
      const sitesLib = require('./sites.js');
      try {
        let st = sitesLib.upsert(sitesLib.readState(), {
          id: body.id, baseURL: body.baseURL, api: body.api, keyEnv: body.keyEnv,
          models: body.models, compat: body.compat === false ? null : body.compat,
        });
        const s = st.sites.find((x) => x.id === String(body.id || '').trim());
        if (s && s.enabled !== false && (!st.default || st.default.siteId === s.id)) st = sitesLib.setDefault(st, s.id, s.models[0].id);
        sitesLib.writeState(st);
        const w = sitesLib.writeOverlay(st, { disabled: readDisabledPlugins() });
        return send(200, { ok: true, legacy: true, overlay: w.overlay, cleanedLines: 0, state: state() });
      } catch (e) {
        return send(400, { error: String(e && e.message || e) });
      }
    }

    if (p === '/api/site/clear' && req.method === 'POST') {
      const sitesLib = require('./sites.js');
      const st = { version: 1, default: null, sites: [] };
      sitesLib.writeState(st);
      try { fs.unlinkSync(sitesLib.OVERLAY); } catch (e) { /* 本来就没有 */ }
      return send(200, { ok: true, cleanedLines: 0, state: state() });
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
    try { html = fs.readFileSync(PAGE, 'utf8'); } catch (e) { html = '<h1>缺少 ui/app.html</h1>'; }
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
