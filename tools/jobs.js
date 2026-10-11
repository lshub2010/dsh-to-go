'use strict';
/**
 * 后台任务引擎（棒 2）
 *
 * 图形界面里「选好版本先下着、同时继续配站点」靠它。设计要点：
 *   - 同一个时刻只允许一个任务（互斥），第二个请求会拿到 busy 而不是排队等死。
 *   - 任务是**独立子进程**：网页服务不会被 npm 卡住，随时能响应别的请求。
 *   - 日志边跑边落盘，界面用 `readLog(id, fromByte)` 增量取，不重复传输。
 *   - 失败会**自动回滚**：装到一个原本没装过的槽失败时，把半成品删掉，便于重试。
 *   - 记录在 data\jobs\ 里，进程被杀/拔盘后重开能看到状态（标成 interrupted 而不是假装还在跑）。
 *
 * 任务种类：
 *   install-slot  {slot, version}   只装指定槽（向导「选版本」用）
 *   upgrade       {version}         装到空闲槽 → 启动检查 → 切指针（config.js 的升级流程）
 *   plugin-pnpm   {args, profile}   dsh plugin --profile <名> <pnpm 参数>（插件页用）
 *   custom        {cmd}             直接给命令（测试/扩展用）
 *
 * CLI:
 *   node tools/jobs.js run <kind> [--key value ...]
 *   node tools/jobs.js list | status | log <id> [fromByte] | wait <id> | cancel <id>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// 路径可以重定向（测试用；也方便将来把工具装到别处）
let ROOT = process.env.WZD_ROOT || path.resolve(__dirname, '..');
let RUNTIME = path.join(ROOT, 'runtime');
let DATA = process.env.WZD_DATA_DIR || path.join(ROOT, 'data');
let JOBS_DIR = path.join(DATA, 'jobs');
let LOCK = path.join(JOBS_DIR, '.lock');
const LOG_CAP = 4 * 1024 * 1024;      // 单个任务日志上限，超出只保留尾部
const KEEP_JOBS = 30;                  // 最多保留多少条历史记录

/** 只在测试/特殊部署里用：把根目录与数据目录指到别处。 */
function setRoots(o) {
  const opts = o || {};
  if (opts.root) { ROOT = opts.root; RUNTIME = path.join(ROOT, 'runtime'); }
  if (opts.data) { DATA = opts.data; JOBS_DIR = path.join(DATA, 'jobs'); LOCK = path.join(JOBS_DIR, '.lock'); }
  return { ROOT, RUNTIME, DATA, JOBS_DIR };
}
function nodeExe() {
  const portable = path.join(RUNTIME, 'node', 'node.exe');
  return fs.existsSync(portable) ? portable : process.execPath;
}

// ------------------------------------------------------------------ 工具
function slotBin(slot) {
  return path.join(RUNTIME, slot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}
function readSlot() {
  try {
    const v = fs.readFileSync(path.join(RUNTIME, 'current.txt'), 'utf8').trim();
    if (/^agent-[AB]$/.test(v)) return v;
  } catch (e) { /* default */ }
  return 'agent-A';
}
function nowIso() { return new Date().toISOString(); }
function ensureDirs() { fs.mkdirSync(JOBS_DIR, { recursive: true }); }
function metaFile(id) { return path.join(JOBS_DIR, id + '.json'); }
function logFile(id) { return path.join(JOBS_DIR, id + '.log'); }
function newId() { return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex'); }

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')); } catch (e) { return null; }
}
function writeMeta(meta) {
  ensureDirs();
  meta.updated = nowIso();
  const tmp = metaFile(meta.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, metaFile(meta.id));
  return meta;
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function appendLog(id, text) {
  ensureDirs();
  fs.appendFileSync(logFile(id), text, 'utf8');
  // 超上限只留尾部，避免一次安装把盘写满
  try {
    const st = fs.statSync(logFile(id));
    if (st.size > LOG_CAP) {
      const keep = 512 * 1024;
      const buf = fs.readFileSync(logFile(id));
      fs.writeFileSync(logFile(id), buf.slice(buf.length - keep));
      appendLog(id, '\n…（较早的日志已被截断，只保留尾部）\n');
    }
  } catch (e) { /* 忽略 */ }
}

// ------------------------------------------------------------------ 任务定义
function installRollback(opts, pre) {
  const slotDir = path.join(RUNTIME, opts.slot);
  // 只有在「这个槽原本没有可用的 dsh」时才清理，避免删掉正在工作的安装
  if (!pre || pre.slotHadDsh !== false) {
    return { rolledBack: false, reason: '槽里原本就有 dsh，保留现场以便排查' };
  }
  for (const p of ['node_modules', 'package-lock.json']) {
    try { fs.rmSync(path.join(slotDir, p), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  return { rolledBack: true, reason: '已清掉半成品，可直接重试' };
}

const KINDS = {
  'install-slot': {
    label: (o) => '安装 dsh ' + o.version + ' 到 ' + o.slot,
    cmd: (o) => [nodeExe(), path.join(__dirname, 'install.js'), '--slot', o.slot, '--version', o.version],
    validate: (o) => {
      if (!/^agent-[AB]$/.test(String(o.slot || ''))) return '槽名只能是 agent-A 或 agent-B';
      if (!o.version) return '缺少 version';
      return null;
    },
    pre: (o) => ({ slotHadDsh: fs.existsSync(slotBin(o.slot)) }),
    rollback: installRollback,
  },
  upgrade: {
    label: (o) => '升级 dsh 到 ' + o.version,
    cmd: (o) => [nodeExe(), path.join(__dirname, 'config.js'), 'upgrade', o.version, '--yes'],
    validate: (o) => (o.version ? null : '缺少 version'),
  },
  'plugin-pnpm': {
    label: (o) => '插件操作：' + (Array.isArray(o.args) ? o.args.join(' ') : ''),
    cmd: (o) => {
      const slot = o.slot || readSlot();
      return [nodeExe(), slotBin(slot), 'plugin', '--profile', o.profile || 'web'].concat(o.args || []);
    },
    validate: (o) => (Array.isArray(o.args) && o.args.length ? null : '缺少 pnpm 参数'),
  },
  custom: {
    label: (o) => o.label || '自定义任务',
    cmd: (o) => o.cmd,
    validate: (o) => (Array.isArray(o.cmd) && o.cmd.length ? null : '缺少 cmd'),
  },
};

// ------------------------------------------------------------------ 状态
/** 把「标着 running 但进程已经不在」的任务标成 interrupted。 */
function reconcile() {
  ensureDirs();
  let changed = 0;
  for (const id of listIds()) {
    const m = readMeta(id);
    if (!m || m.status !== 'running') continue;
    if (!pidAlive(m.pid)) {
      m.status = 'interrupted';
      m.endedAt = m.endedAt || nowIso();
      m.message = '进程已不在（服务窗口被关掉、拔盘或崩溃），任务按中断处理';
      writeMeta(m);
      appendLog(id, '\n=== 任务中断：进程已不在 ===\n');
      changed++;
    }
  }
  if (changed) releaseLockIfStale();
  return changed;
}

function listIds() {
  ensureDirs();
  return fs.readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function listJobs(limit) {
  reconcile();
  const ids = listIds().slice(-(limit || 20));
  return ids.map((id) => readMeta(id)).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function runningJob() {
  reconcile();
  for (const m of listJobs(50)) if (m.status === 'running') return m;
  return null;
}
function isBusy() { return !!runningJob(); }

// ------------------------------------------------------------------ 锁
function readLock() {
  try { return fs.readFileSync(LOCK, 'utf8').trim(); } catch (e) { return null; }
}
function releaseLockIfStale() {
  const holder = readLock();
  if (!holder) return;
  const m = readMeta(holder);
  if (!m || m.status !== 'running' || !pidAlive(m.pid)) {
    try { fs.unlinkSync(LOCK); } catch (e) { /* 已释放 */ }
  }
}
function acquireLock(id) {
  ensureDirs();
  try {
    fs.writeFileSync(LOCK, id, { flag: 'wx' });
    return true;
  } catch (e) {
    // 锁被占：如果持有者已经不在跑，就接手（避免死锁）
    releaseLockIfStale();
    try { fs.writeFileSync(LOCK, id); return true; } catch (e2) { return false; }
  }
}
function releaseLock(id) {
  if (readLock() === id) { try { fs.unlinkSync(LOCK); } catch (e) { /* 忽略 */ } }
}

// ------------------------------------------------------------------ 创建与执行
function createJob(kind, opts) {
  const def = KINDS[kind];
  if (!def) return { ok: false, error: '未知任务种类：' + kind };
  const o = opts || {};
  const bad = def.validate ? def.validate(o) : null;
  if (bad) return { ok: false, error: bad };

  const running = runningJob();
  if (running) return { ok: false, busy: true, error: '已有任务在跑：' + running.label, job: running };

  const id = newId();
  const meta = {
    id, kind,
    label: def.label(o),
    opts: o,
    status: 'queued',
    createdAt: nowIso(), startedAt: null, endedAt: null,
    pid: null, exitCode: null, message: '', stage: '排队中',
    pre: def.pre ? def.pre(o) : null,
  };
  ensureDirs();
  writeMeta(meta);
  fs.writeFileSync(logFile(id), '=== ' + meta.label + ' ===\n开始时间：' + meta.createdAt + '\n', 'utf8');
  pruneOld();
  return { ok: true, job: meta };
}

function pruneOld() {
  const ids = listIds();
  if (ids.length <= KEEP_JOBS) return;
  for (const id of ids.slice(0, ids.length - KEEP_JOBS)) {
    const m = readMeta(id);
    if (m && m.status === 'running') continue;
    try { fs.unlinkSync(metaFile(id)); } catch (e) { /* 忽略 */ }
    try { fs.unlinkSync(logFile(id)); } catch (e) { /* 忽略 */ }
  }
}

/** 猜当前阶段（供界面显示；不做假的百分比）。 */
function guessStage(line) {
  const l = String(line);
  if (/便携 Node 就绪/.test(l)) return '准备运行环境';
  if (/尝试 npmjs|尝试 npmmirror|正在安装到|安装到 agent-/.test(l)) return '从 npm 下载安装';
  if (/完成：agent-/.test(l)) return '安装完成';
  if (/启动检查|校验/.test(l)) return '安装后检查';
  if (/切换|活动槽已切到/.test(l)) return '切换活动槽';
  if (/失败|error|ERR!/.test(l)) return '出错';
  return null;
}

function runJob(id) {
  const meta = readMeta(id);
  if (!meta) return { ok: false, error: '没有这个任务：' + id };
  const def = KINDS[meta.kind];
  const cmd = def.cmd(meta.opts);
  if (!cmd || !cmd.length) return { ok: false, error: '任务命令为空' };

  if (!acquireLock(id)) {
    meta.status = 'failed';
    meta.message = '拿不到执行锁（可能另一个窗口正在跑任务）';
    meta.endedAt = nowIso();
    writeMeta(meta);
    return { ok: false, error: meta.message };
  }

  meta.status = 'running';
  meta.startedAt = nowIso();
  meta.stage = '启动中';
  meta.cmdLine = cmd.map((c) => (c === nodeExe() ? 'node' : c)).join(' ');
  writeMeta(meta);
  appendLog(id, '\n$ ' + meta.cmdLine + '\n\n');

  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      DSH_HOME: DATA,
      DSH_AGENTS_HOME: path.join(DATA, 'agents'),
      npm_config_cache: path.join(RUNTIME, 'npm-cache'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  meta.pid = child.pid;
  writeMeta(meta);

  const onData = (buf) => {
    const text = buf.toString();
    appendLog(id, text);
    const m = readMeta(id);
    if (m && m.status === 'running') {
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length) {
        m.lastLine = lines[lines.length - 1].slice(0, 300);
        m.stage = guessStage(lines[lines.length - 1]) || m.stage;
        writeMeta(m);
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  return new Promise((resolve) => {
    child.on('error', (err) => {
      const m = readMeta(id) || meta;
      m.status = 'failed';
      m.message = '无法启动命令：' + err.message;
      m.endedAt = nowIso();
      writeMeta(m);
      appendLog(id, '\n=== 无法启动命令：' + err.message + ' ===\n');
      releaseLock(id);
      resolve({ ok: false, job: m });
    });
    child.on('exit', (code, signal) => {
      const m = readMeta(id) || meta;
      m.exitCode = code;
      m.endedAt = nowIso();
      if (m.cancelled) {
        m.status = 'cancelled';
        m.stage = '已取消';
        m.message = m.message || '被用户取消';
      } else if (code === 0) {
        m.status = 'done';
        m.stage = '完成';
        m.message = '成功';
      } else {
        m.status = 'failed';
        m.stage = '失败';
        m.message = '退出码 ' + code + (signal ? '（信号 ' + signal + '）' : '');
        const rb = def.rollback ? def.rollback(meta.opts, meta.pre || {}) : null;
        if (rb) {
          m.rollback = rb;
          appendLog(id, '\n=== 自动回滚：' + rb.reason + ' ===\n');
        }
      }
      appendLog(id, '\n=== 结束：' + m.status + (m.exitCode === null ? '' : '（退出码 ' + m.exitCode + '）') + ' ===\n');
      writeMeta(m);
      releaseLock(id);
      resolve({ ok: m.status === 'done', job: m });
    });
  });
}

/** 建了就跑；界面里用「先建后跑」是为了拿到 id 再返回。 */
async function startJob(kind, opts) {
  const c = createJob(kind, opts);
  if (!c.ok) return c;
  const r = await runJob(c.job.id);
  return r;
}
function spawnJob(kind, opts) {
  const c = createJob(kind, opts);
  if (!c.ok) return c;
  setTimeout(() => { runJob(c.job.id); }, 0);   // 立刻返回，任务在后台跑
  return c;
}

function readLog(id, from) {
  const f = logFile(id);
  let size = 0;
  try { size = fs.statSync(f).size; } catch (e) { return { ok: false, error: '没有这个任务的日志', text: '', next: 0, size: 0 }; }
  const start = Number.isFinite(from) && from >= 0 && from <= size ? from : 0;
  let text = '';
  try {
    const fd = fs.openSync(f, 'r');
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (e) {
    return { ok: false, error: e.message, text: '', next: size, size };
  }
  return { ok: true, text, next: size, size };
}

function cancelJob(id) {
  const m = readMeta(id);
  if (!m) return { ok: false, error: '没有这个任务：' + id };
  if (m.status !== 'running') return { ok: false, error: '任务当前状态是 ' + m.status + '，不需要取消' };
  m.cancelled = true;
  writeMeta(m);
  appendLog(id, '\n=== 正在取消（杀掉子进程树）===\n');
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(m.pid)], { windowsHide: true }); } catch (e) { /* 忽略 */ }
  return { ok: true, job: readMeta(id) };
}

function waitFor(id, timeoutMs) {
  const t0 = Date.now();
  const limit = timeoutMs || 30 * 60 * 1000;
  return new Promise((resolve) => {
    const tick = () => {
      const m = readMeta(id);
      if (!m) return resolve({ ok: false, error: '没有这个任务：' + id });
      if (m.status !== 'running' && m.status !== 'queued') return resolve({ ok: m.status === 'done', job: m });
      if (Date.now() - t0 > limit) return resolve({ ok: false, timeout: true, job: m });
      setTimeout(tick, 500);
    };
    tick();
  });
}

function status() {
  const running = runningJob();
  return {
    busy: !!running,
    running: running ? { id: running.id, kind: running.kind, label: running.label, stage: running.stage, startedAt: running.startedAt } : null,
    jobs: listJobs(10),
  };
}

module.exports = {
  KINDS, setRoots, nodeExe,
  createJob, spawnJob, runJob, startJob, cancelJob, waitFor,
  listJobs, status, isBusy, runningJob, reconcile, readMeta, readLog, guessStage,
  installRollback,
  get ROOT() { return ROOT; },
  get DATA() { return DATA; },
  get JOBS_DIR() { return JOBS_DIR; },
};

// ------------------------------------------------------------------ CLI
async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || 'status').toLowerCase();
  const kv = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { kv[k] = next; i++; } else kv[k] = true;
    }
  }
  if (cmd === 'status' || cmd === 'list') {
    const s = status();
    console.log('');
    console.log('  忙碌：' + (s.busy ? '是（' + s.running.label + '　阶段：' + s.running.stage + '）' : '否'));
    for (const j of s.jobs) {
      console.log('  - ' + j.id + '  ' + j.status.padEnd(11) + ' ' + j.label + (j.message ? '  [' + j.message + ']' : ''));
    }
    console.log('');
    return 0;
  }
  if (cmd === 'run') {
    const kind = argv[1];
    if (kind === 'install-slot') { kv.slot = kv.slot || 'agent-A'; kv.version = kv.version || kv.a; }
    if (kind === 'custom' && kv.cmdline) kv.cmd = String(kv.cmdline).split(' ');
    if (kind === 'plugin-pnpm' && kv.args) kv.args = String(kv.args).split(' ');
    const c = createJob(kind, kv);
    if (!c.ok) { console.log('  无法创建任务：' + c.error); return 1; }
    console.log('  任务已创建：' + c.job.id + '　（' + c.job.label + '）');
    // 命令行下必须等任务结束：进程一退，子进程的收尾（写状态、清锁）就没人做了。
    // 网页端走的是 spawnJob（非阻塞），那边由长驻的服务进程负责收尾。
    const r = await runJob(c.job.id);
    console.log('  结果：' + r.job.status + '　' + (r.job.message || '') +
      (r.job.rollback ? '　回滚：' + r.job.rollback.reason : ''));
    console.log('  日志：node tools/jobs.js log ' + c.job.id);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'wait') {
    const r = await waitFor(argv[1]);
    if (!r.job) { console.log('  ' + r.error); return 1; }
    console.log('  结果：' + r.job.status + '　' + (r.job.message || ''));
    return r.ok ? 0 : 1;
  }
  if (cmd === 'log') {
    const r = readLog(argv[1], argv[2] ? Number(argv[2]) : 0);
    process.stdout.write(r.text);
    console.error('\n(下一偏移量 ' + r.next + ' / 共 ' + r.size + ' 字节)');
    return 0;
  }
  if (cmd === 'cancel') {
    const r = cancelJob(argv[1]);
    console.log(r.ok ? '  已发送取消。' : '  ' + r.error);
    return r.ok ? 0 : 1;
  }
  console.log('用法：node tools/jobs.js <run <kind> [--k v]|status|list|log <id> [from]|wait <id>|cancel <id>>');
  return 2;
}

if (require.main === module) {
  main().then((rc) => process.exit(rc)).catch((e) => { console.error('任务引擎错误：' + e.message); process.exit(1); });
}
