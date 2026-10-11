// 拔盘守护单测：哨兵、判定、恢复、宿主记录（与其它测试一样走 node:test）
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const W = require(path.join(ROOT, 'tools', 'watchdog.js'));
const BS = String.fromCharCode(92);

// 用临时目录假装「一块盘」
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-to-go-watch-'));
const fakeRoot = path.join(sandbox, 'drive');
fs.mkdirSync(path.join(fakeRoot, 'runtime'), { recursive: true });
const hostTmp = path.join(sandbox, 'hosttmp');
fs.mkdirSync(hostTmp, { recursive: true });
const sentinelFile = path.join(fakeRoot, 'runtime', '.drive-id');

test('哨兵路径固定在 runtime 下（跟着盘走，不写 data）', () => {
  assert.strictEqual(W.SENTINEL_REL, 'runtime' + BS + '.drive-id');
  assert.ok(W.sentinelPath(fakeRoot).endsWith('runtime' + BS + '.drive-id'));
});

test('ensureSentinel：第一次建、第二次沿用（幂等，id 不变）', () => {
  const a = W.ensureSentinel(fakeRoot);
  assert.ok(fs.existsSync(a.path), '哨兵文件没建出来');
  assert.strictEqual(a.existed, false);
  const b = W.ensureSentinel(fakeRoot);
  assert.strictEqual(a.id, b.id, 'id 不该变');
  assert.strictEqual(b.existed, true);
  assert.strictEqual(b.path, sentinelFile);
});

test('哨兵内容是 JSON：id / root / 中文提醒（提醒别删）', () => {
  const s = W.ensureSentinel(fakeRoot);
  const j = JSON.parse(fs.readFileSync(s.path, 'utf8'));
  assert.ok(j.id && j.root && j.created);
  assert.match(j.note, /别删/);
});

test('probe：盘还在 → ok', () => {
  const s = W.ensureSentinel(fakeRoot);
  assert.deepStrictEqual(W.probe(s.path, s.id), { ok: true, id: s.id });
});

test('probe：读不到 → missing（这就是拔盘）', () => {
  const s = W.ensureSentinel(fakeRoot);
  fs.rmSync(s.path);
  const r = W.probe(s.path, s.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'missing');
});

test('probe：换成另一块盘（id 变了）→ swapped', () => {
  const s = W.ensureSentinel(fakeRoot);
  fs.writeFileSync(s.path, JSON.stringify({ id: 'other-drive', root: 'X:' }), 'utf8');
  const r = W.probe(s.path, s.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'swapped');
});

test('probe：内容坏了 → corrupt（绝不能当成「盘还在」）', () => {
  const s = W.ensureSentinel(fakeRoot);
  fs.writeFileSync(s.path, 'not json at all', 'utf8');
  assert.strictEqual(W.probe(s.path, s.id).reason, 'corrupt');
  fs.writeFileSync(s.path, JSON.stringify({ root: 'X:' }), 'utf8');
  assert.strictEqual(W.probe(s.path, s.id).reason, 'corrupt', '没有 id 也算坏');
});

test('连续 maxMisses 次读不到才判定丢盘；中途恢复就清零', () => {
  const s = W.ensureSentinel(fakeRoot);
  let fired = null;
  const w = new W.DriveWatch({ root: fakeRoot, hostTempDir: hostTmp, maxMisses: 3, role: 'test', onLost: (r) => { fired = r; } });
  const saved = fs.readFileSync(s.path, 'utf8');

  fs.rmSync(s.path);
  w.tick(); w.tick();
  assert.strictEqual(fired, null, '两次还不够');
  assert.strictEqual(w.status().misses, 2);

  fs.writeFileSync(s.path, saved, 'utf8');
  w.tick();
  assert.strictEqual(fired, null);
  assert.strictEqual(w.status().misses, 0, '恢复后失败计数要清零');
  assert.ok(w.status().lastOkAt, '要记下最后一次成功');

  fs.rmSync(s.path);
  w.tick(); w.tick(); w.tick();
  assert.ok(fired, '三次连续失败应该触发');
  assert.strictEqual(fired.reason, 'missing');
  assert.strictEqual(fired.misses, 3);
  assert.strictEqual(fired.role, 'test');
  assert.strictEqual(fired.root, fakeRoot);
  assert.ok(fired.at && /T/.test(fired.at), '记录里要有时间');
  w.stop();
});

test('判定丢盘后：只回调一次、定时器停掉、状态留 lostAt', () => {
  const s = W.ensureSentinel(fakeRoot);
  let n = 0;
  const w = new W.DriveWatch({ root: fakeRoot, hostTempDir: hostTmp, maxMisses: 1, role: 'test', onLost: () => { n++; } });
  fs.rmSync(s.path);
  w.tick();
  w.tick();
  assert.strictEqual(n, 1, 'onLost 只该来一次');
  assert.ok(w.status().fired && w.status().lostAt);
  assert.strictEqual(w.status().running, false, '触发后定时器要停');
  w.stop();
});

test('onLost 回调里抛错不会把守护带崩', () => {
  const s = W.ensureSentinel(fakeRoot);
  const w = new W.DriveWatch({ root: fakeRoot, hostTempDir: hostTmp, maxMisses: 1, role: 'test', onLost: () => { throw new Error('回调炸了'); } });
  fs.rmSync(s.path);
  w.tick(); // 不该把异常抛出来
  assert.strictEqual(w.status().fired, true);
  w.stop();
});

test('start/stop 管得住定时器；用 unref 不拖住进程退出', () => {
  const w = new W.DriveWatch({ root: fakeRoot, hostTempDir: hostTmp, intervalMs: 50, role: 'test' });
  assert.strictEqual(w.start(), true);
  assert.strictEqual(w.status().running, true);
  w.stop();
  assert.strictEqual(w.status().running, false);
});

test('定时器真的会自己发现丢盘（不等外部 tick）', async () => {
  const s = W.ensureSentinel(fakeRoot);
  let fired = null;
  const w = new W.DriveWatch({ root: fakeRoot, hostTempDir: hostTmp, intervalMs: 20, maxMisses: 2, role: 'test', onLost: (r) => { fired = r; } });
  w.start();
  fs.rmSync(s.path);
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(fired, '20ms 间隔跑 250ms，应该已经判定');
  assert.strictEqual(fired.reason, 'missing');
  w.stop();
});

test('丢盘记录写在宿主临时目录，可读可清，只留最近 8 条', () => {
  for (let i = 0; i < 10; i++) W.writeLossRecord(hostTmp, { at: '2026-01-01T00:00:0' + i, reason: 'missing', n: i }, fakeRoot);
  const all = W.readLossRecords(hostTmp, fakeRoot);
  assert.strictEqual(all.length, 8, '只留最近 8 条');
  assert.strictEqual(all[7].n, 9, '留的是最新的');
  assert.ok(fs.existsSync(W.lossLogPath(hostTmp, fakeRoot)));
  assert.strictEqual(W.clearLossRecords(hostTmp, fakeRoot), true);
  assert.deepStrictEqual(W.readLossRecords(hostTmp, fakeRoot), []);
});

test('宿主目录若就在被监视的那块盘上 → 记录会改写出去（写回被拔的盘等于没写）', () => {
  const fakeHost = path.join(fakeRoot, 'sometmp');
  fs.mkdirSync(fakeHost, { recursive: true });
  const p = W.lossLogPath(fakeHost, fakeRoot);
  assert.ok(!p.startsWith(fakeHost), '必须改写，实际写成：' + p);
});

test('onLost 收到的记录里带着「记录写到哪了」，并且真写出来了', () => {
  const s = W.ensureSentinel(fakeRoot);
  let rec = null;
  const w = new W.DriveWatch({ root: fakeRoot, hostTempDir: hostTmp, maxMisses: 1, role: 'ui-server', onLost: (r) => { rec = r; } });
  fs.rmSync(s.path);
  w.tick();
  assert.ok(rec, '应该回调');
  assert.ok(rec.log && rec.log.endsWith(W.LOSS_LOG_NAME), '记录里要有落盘位置：' + rec.log);
  assert.strictEqual(rec.role, 'ui-server');
  assert.ok(fs.existsSync(rec.log), '记录文件真的写出来了');
  W.clearLossRecords(hostTmp, fakeRoot);
  w.stop();
});

test.after(() => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } });
