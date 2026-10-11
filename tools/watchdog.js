'use strict';
/**
 * 拔盘守护。
 *
 * 为什么要它：U 盘被拔走之后，进程**不会**自己死——它继续在内存里跑，dsh 以为
 * data\ 还在，会话/工作区写得进去（其实是写到缓存的空文件句柄上），结果就是
 * 「盘没了、活还在干、聊天记录回不去」。等用户把盘插回来，看到的是盘上那份旧状态。
 *
 * 办法：启动时在盘上写一个哨兵文件（runtime\.drive-id，带随机 id + 根目录），
 * 之后每隔几秒读一次：
 *   - 读不到（ENOENT/EBUSY/EIO…）  → 盘被拔了
 *   - 读得到但 id/根目录不对        → 这块盘被换成了另一块
 * 连续 maxMisses 次（默认 3 次，约 9 秒）都异常 → 判定「盘没了」，回调 onLost，
 * 由调用方收摊：先写宿主日志（盘没了只能写宿主临时目录），再杀子进程树，然后退出。
 *
 * 它只负责「判断 + 报告」，不负责杀谁——进程树的样子只有调用方清楚。
 */
const fs = require('fs');
const path = require('path');

const SENTINEL_REL = path.join('runtime', '.drive-id');
const LOSS_LOG_NAME = 'drive-lost.json';
const NEW_ID = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function repoRoot() { return path.resolve(__dirname, '..'); }
function sentinelPath(root) { return path.join(root || repoRoot(), SENTINEL_REL); }

/** 启动时确保盘上有哨兵；返回 {path, id, existed}。盘上已有的沿用（换盘重建也认）。 */
function ensureSentinel(root) {
  const r = root || repoRoot();
  const f = sentinelPath(r);
  try {
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (cur && cur.id && (!cur.root || path.resolve(cur.root) === path.resolve(r))) {
      return { path: f, id: cur.id, existed: true };
    }
  } catch (e) { /* 没有或坏了 → 重写一个 */ }
  const rec = { id: NEW_ID(), root: r, created: new Date().toISOString(), note: 'dsh-to-go 拔盘守护的哨兵文件，别删（删了守护会以为盘被拔走）' };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  return { path: f, id: rec.id, existed: false };
}

/** 读一次哨兵：{ok:true} 或 {ok:false, reason:'missing'|'swapped'|'error', detail} */
function probe(sentinel, expectedId) {
  try {
    const txt = fs.readFileSync(sentinel, 'utf8');
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { return { ok: false, reason: 'corrupt', detail: '哨兵内容不是 JSON' }; }
    if (!j || !j.id) return { ok: false, reason: 'corrupt', detail: '哨兵里没有 id' };
    if (expectedId && j.id !== expectedId) return { ok: false, reason: 'swapped', detail: '哨兵 id 变了（换了一块盘）' };
    return { ok: true, id: j.id };
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing', detail: '读不到哨兵文件（盘不在了）' };
    return { ok: false, reason: 'error', detail: (code || '') + ' ' + ((e && e.message) || e) };
  }
}

/** 宿主临时目录下的一份「盘没了」记录（盘都没了，只能写宿主） */
function lossLogPath(hostTempDir, watchRoot) {
  let dir = hostTempDir || require('os').tmpdir();
  // 兜底：给的目录要是就在被监视的那块盘上，写进去等于没写（盘已经没了）
  try {
    const watched = path.parse(path.resolve(watchRoot || repoRoot())).root.toLowerCase();
    if (path.resolve(dir).toLowerCase().startsWith(watched)) dir = require('os').tmpdir();
  } catch (e) { /* 用原值 */ }
  return path.join(dir, 'dsh-to-go', LOSS_LOG_NAME);
}
function writeLossRecord(hostTempDir, rec, watchRoot) {
  const f = lossLogPath(hostTempDir, watchRoot);
  let all = [];
  try { all = JSON.parse(fs.readFileSync(f, 'utf8')); if (!Array.isArray(all)) all = []; } catch (e) { all = []; }
  all.push(rec);
  all = all.slice(-8); // 只留最近 8 条
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(all, null, 2) + '\n', 'utf8');
  return f;
}
function readLossRecords(hostTempDir, watchRoot) {
  try {
    const all = JSON.parse(fs.readFileSync(lossLogPath(hostTempDir, watchRoot), 'utf8'));
    return Array.isArray(all) ? all : [];
  } catch (e) { return []; }
}
function clearLossRecords(hostTempDir, watchRoot) {
  try { fs.rmSync(lossLogPath(hostTempDir, watchRoot), { force: true }); return true; } catch (e) { return false; }
}

class DriveWatch {
  /**
   * @param {object} opts
   *   root        仓库/盘根（默认本文件上一级）
   *   intervalMs  探测间隔（默认 3000）
   *   maxMisses   连续失败几次算「盘没了」（默认 3）
   *   onLost      ({reason, detail, misses, at}) => void  判定丢盘时的回调
   *   hostTempDir 宿主临时目录（写「盘没了」记录用；盘上写不了）
   *   role        写日志用：'launcher' | 'ui-server'
   *   log         可选，内部行为日志 (line) => void
   */
  constructor(opts = {}) {
    this.root = opts.root ? path.resolve(opts.root) : repoRoot();
    // 环境变量可调：探测间隔与「连续几次算丢盘」（WZD_DRIVE_POLL_MS / WZD_DRIVE_MISSES）
    this.intervalMs = opts.intervalMs || Number(process.env.WZD_DRIVE_POLL_MS) || 3000;
    this.maxMisses = opts.maxMisses || Number(process.env.WZD_DRIVE_MISSES) || 3;
    this.onLost = opts.onLost || function () {};
    this.hostTempDir = opts.hostTempDir || null;
    this.role = opts.role || 'unknown';
    this.log = opts.log || function () {};
    this.timer = null;
    this.misses = 0;
    this.oks = 0;
    this.lastOkAt = null;
    this.lastMissAt = null;
    this.lastReason = null;
    this.fired = false;
    this.lostAt = null;
    this.sentinel = null;
    this.startError = null;
    try {
      this.sentinel = ensureSentinel(this.root);
    } catch (e) {
      this.startError = (e && e.message) || String(e);
    }
  }

  /** 探测一次并记账（单元测试直接用这个，不必等定时器） */
  probeOnce() {
    if (!this.sentinel) return { ok: false, reason: 'no-sentinel', detail: this.startError };
    const r = probe(this.sentinel.path, this.sentinel.id);
    if (r.ok) {
      this.oks++;
      this.misses = 0;
      this.lastOkAt = new Date().toISOString();
      return r;
    }
    this.misses++;
    this.lastMissAt = new Date().toISOString();
    this.lastReason = r.reason + (r.detail ? '（' + r.detail + '）' : '');
    return r;
  }

  start() {
    if (this.timer) return true;
    if (!this.sentinel) { this.log('拔盘守护未启动：哨兵写不进去（' + this.startError + '）'); return false; }
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref(); // 别拖住进程退出
    return true;
  }

  tick() {
    if (this.fired) return;
    const r = this.probeOnce();
    if (r.ok) return;
    this.log('拔盘守护：第 ' + this.misses + '/' + this.maxMisses + ' 次读不到本盘（' + r.reason + '）');
    if (this.misses >= this.maxMisses) this.fire(r);
  }

  fire(r) {
    if (this.fired) return;
    this.fired = true;
    this.lostAt = new Date().toISOString();
    this.stop();
    const rec = {
      at: this.lostAt, role: this.role, root: this.root,
      reason: (r && r.reason) || 'unknown', detail: (r && r.detail) || '',
      misses: this.misses, sentinel: this.sentinel ? this.sentinel.path : null,
    };
    try { rec.log = writeLossRecord(this.hostTempDir, rec, this.root); } catch (e) { rec.logWriteError = (e && e.message) || String(e); }
    try { this.onLost(rec); } catch (e) { this.log('onLost 里抛错：' + ((e && e.message) || e)); }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return {
      running: !!this.timer, fired: this.fired, misses: this.misses, oks: this.oks,
      intervalMs: this.intervalMs, maxMisses: this.maxMisses,
      lastOkAt: this.lastOkAt, lastMissAt: this.lastMissAt, lastReason: this.lastReason,
      lostAt: this.lostAt, sentinel: this.sentinel ? this.sentinel.path : null,
      startError: this.startError,
    };
  }
}

module.exports = {
  DriveWatch, ensureSentinel, probe, sentinelPath, repoRoot,
  lossLogPath, writeLossRecord, readLossRecords, clearLossRecords,
  SENTINEL_REL, LOSS_LOG_NAME,
};
