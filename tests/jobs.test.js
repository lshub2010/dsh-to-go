'use strict';
/**
 * 棒 2 单测：后台任务引擎（状态机 / 增量日志 / 互斥 / 取消 / 中断识别 / 回滚）。
 * 运行：node --test tests\jobs.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-to-go-jobs-'));
process.env.WZD_DATA_DIR = path.join(TMP, 'data');
process.env.WZD_ROOT = path.join(TMP, 'root');
fs.mkdirSync(path.join(process.env.WZD_ROOT, 'runtime'), { recursive: true });
const J = require('../tools/jobs.js');

const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const custom = (script, label) => ({ cmd: [NODE, '-e', script], label: label || '测试任务' });
/** 每个用例开始前确保没有遗留任务在跑（上一个用例失败时会有）。 */
async function ensureIdle() {
  const r = J.runningJob();
  if (r) { J.cancelJob(r.id); await J.waitFor(r.id, 8000); }
  const still = J.runningJob();
  if (still) throw new Error('上一个任务没能停下来：' + still.id);
}

test('成功任务：走出 queued → running → done，并记录退出码与日志', async () => {
  const c = J.createJob('custom', custom('console.log("第一行");console.log("第二行");console.log("第三行")'));
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.job.status, 'queued');
  const r = await J.runJob(c.job.id);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.job.status, 'done');
  assert.strictEqual(r.job.exitCode, 0);
  const log = J.readLog(c.job.id, 0);
  assert.match(log.text, /第一行/);
  assert.match(log.text, /第三行/);
  assert.match(log.text, /结束：done（退出码 0）/);
  assert.match(String(J.readMeta(c.job.id).lastLine), /第三行/);
});

test('增量日志：只取新增部分，next 偏移量正确', async () => {
  await ensureIdle();
  // 标记用运行时拼出来：日志开头会回显命令行，源码里直接写字面量会被误判成"已经输出了"
  const script = 'console.log(["A","A","A"].join(""));'
    + 'setTimeout(function(){console.log(["B","B","B"].join(""))},2500)';
  const c = J.createJob('custom', custom(script));
  const p = J.runJob(c.job.id);
  await sleep(600);
  const first = J.readLog(c.job.id, 0);
  assert.match(first.text, /AAA/);
  assert.ok(!/BBB/.test(first.text), '此刻还不该有 BBB');
  await p;
  const second = J.readLog(c.job.id, first.next);
  assert.match(second.text, /BBB/);
  assert.ok(!/AAA/.test(second.text), '增量里不应重复 AAA');
  assert.ok(second.next > first.next);
  // 越界偏移不会炸：从头给
  const reset = J.readLog(c.job.id, 999999);
  assert.match(reset.text, /AAA/);
});

test('互斥：有任务在跑时第二次创建被拒绝（busy）', async () => {
  await ensureIdle();
  const c = J.createJob('custom', custom('setTimeout(()=>{},4000)'));
  const p = J.runJob(c.job.id);
  try {
    await sleep(300);
    assert.strictEqual(J.isBusy(), true, '应当在跑');
    const second = J.createJob('custom', custom('console.log("不该跑")'));
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.busy, true);
    assert.strictEqual(second.job.id, c.job.id, 'busy 时应回报正在跑的那个任务');
  } finally {
    J.cancelJob(c.job.id);
    await p;
  }
  await sleep(150);
  assert.strictEqual(J.isBusy(), false, '取消后应空闲');
});

test('失败任务：非零退出码 → failed，并保留退出码与错误信息', async () => {
  await ensureIdle();
  const c = J.createJob('custom', custom('console.error("炸了");process.exit(3)'));
  const r = await J.runJob(c.job.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.job.status, 'failed');
  assert.strictEqual(r.job.exitCode, 3);
  assert.match(String(r.job.message), /退出码 3/);
  assert.match(J.readLog(c.job.id, 0).text, /炸了/);
});

test('取消任务：状态变 cancelled，子进程不再存活', async () => {
  const c = J.createJob('custom', custom('setTimeout(()=>{},6000)'));
  const p = J.runJob(c.job.id);
  await sleep(250);
  const pid = J.readMeta(c.job.id).pid;
  assert.ok(pid > 0);
  const rc = J.cancelJob(c.job.id);
  assert.strictEqual(rc.ok, true);
  const r = await p;
  assert.strictEqual(r.job.status, 'cancelled');
  assert.match(J.readLog(c.job.id, 0).text, /正在取消/);
  await sleep(200);
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { alive = false; }
  assert.strictEqual(alive, false, '子进程应已被杀掉');
});

test('中断识别：标着 running 但进程已不在的任务会被标成 interrupted', async () => {
  const id = '20200101000000-dead';
  fs.writeFileSync(path.join(J.JOBS_DIR, id + '.json'), JSON.stringify({
    id, kind: 'custom', label: '假任务', status: 'running', pid: 999999,
    startedAt: '2020-01-01T00:00:00.000Z', opts: {},
  }), 'utf8');
  const found = J.listJobs(50).find((j) => j.id === id);
  assert.ok(found);
  assert.strictEqual(found.status, 'interrupted');
  assert.match(String(found.message), /进程已不在/);
});

test('参数校验：install-slot 缺版本/槽名非法都被拒', () => {
  const a = J.createJob('install-slot', { slot: 'agent-A' });
  assert.strictEqual(a.ok, false);
  assert.match(a.error, /version/);
  const b = J.createJob('install-slot', { slot: 'agent-Z', version: '1.0.0' });
  assert.strictEqual(b.ok, false);
  assert.match(b.error, /槽名/);
  const c = J.createJob('没有这种任务', {});
  assert.strictEqual(c.ok, false);
  assert.match(c.error, /未知任务种类/);
});

test('回滚：原本没装过的槽失败后清掉半成品，原本有 dsh 的不动', () => {
  const root = path.join(TMP, 'rollback-root');
  const slotA = path.join(root, 'runtime', 'agent-A');
  fs.mkdirSync(path.join(slotA, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  fs.writeFileSync(path.join(slotA, 'package.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(slotA, 'package-lock.json'), '{}', 'utf8');

  // 原本没有 dsh（pre.slotHadDsh === false）→ 清理
  const prev = J.setRoots({ root });
  const rb = J.installRollback({ slot: 'agent-A' }, { slotHadDsh: false });
  J.setRoots({ root: prev.ROOT === root ? process.env.WZD_ROOT : prev.ROOT });
  assert.strictEqual(rb.rolledBack, true);
  assert.strictEqual(fs.existsSync(path.join(slotA, 'node_modules')), false, '半成品应被删掉');
  assert.strictEqual(fs.existsSync(path.join(slotA, 'package-lock.json')), false);
  assert.strictEqual(fs.existsSync(path.join(slotA, 'package.json')), true, 'package.json 保留');

  // 原本有 dsh → 不清理
  fs.mkdirSync(path.join(slotA, 'node_modules'), { recursive: true });
  J.setRoots({ root });
  const keep = J.installRollback({ slot: 'agent-A' }, { slotHadDsh: true });
  J.setRoots({ root: process.env.WZD_ROOT });
  assert.strictEqual(keep.rolledBack, false);
});

test('阶段提示：能从日志行里认出关键阶段', () => {
  assert.strictEqual(J.guessStage('  尝试 npmjs 官方源'), '从 npm 下载安装');
  assert.strictEqual(J.guessStage('  安装到 agent-A ← npmjs 官方源（第一次要几分钟）'), '从 npm 下载安装');
  assert.strictEqual(J.guessStage('  完成：agent-A ← dsh 0.2.1-alpha.2（136 秒）'), '安装完成');
  assert.strictEqual(J.guessStage('这东西不认识'), null);
});

test('取消与中断识别的竞态：被取消的任务不该被报成「崩溃」', async () => {
  await ensureIdle();
  const c = J.createJob('custom', custom('setTimeout(()=>{},5000)'));
  const p = J.runJob(c.job.id);
  await sleep(300);
  J.cancelJob(c.job.id);
  // 模拟「另一个进程先看到进程没了」：杀完之后立刻 reconcile
  const meta = J.readMeta(c.job.id);
  J.reconcile();
  const seen = J.readMeta(c.job.id);
  assert.ok(['running', 'cancelled'].includes(seen.status), 'reconcile 不该把它标成别的状态：' + seen.status);
  if (seen.status === 'cancelled') assert.match(String(seen.message), /取消/);
  const r = await p;
  assert.strictEqual(r.job.status, 'cancelled');
  assert.match(String(J.readMeta(c.job.id).message), /取消/);
  assert.strictEqual(meta.cancelled, true);
});

test('status()：给出忙碌状态与最近任务列表', async () => {
  await ensureIdle();
  const s0 = J.status();
  assert.strictEqual(s0.busy, false);
  assert.ok(Array.isArray(s0.jobs));
  assert.ok(s0.jobs.length >= 1, '之前跑过的任务应出现在列表里');
  const c = J.createJob('custom', custom('setTimeout(()=>{},1500)'));
  const p = J.runJob(c.job.id);
  await sleep(200);
  const s1 = J.status();
  assert.strictEqual(s1.busy, true);
  assert.strictEqual(s1.running.id, c.job.id);
  assert.ok(s1.running.stage, '应带上当前阶段');
  await p;
});
