'use strict';
/**
 * 密钥层 v2（棒 1）：一个文件存多站点密钥，统一用一个口令加密。
 *
 * secrets\keys.enc
 *   {
 *     version: 2, algo: 'aes-256-gcm', kdf: 'scrypt', kdf_params: {…},
 *     verifier: { salt, iv, tag, ct },        // 加密固定串，仅用于校验口令
 *     keys: { <站点ID>: { key_name, salt, iv, tag, ct, length, created } },
 *     updated: '…'
 *   }
 *
 * 设计约束：
 *   - 口令永不落盘、不进日志、不进命令行；只在该请求处理的那一瞬间出现在进程内存里。
 *   - verifier 让「口令对不对」能在不解密任何密钥的前提下判断。
 *   - 兼容旧文件 secrets\model-key.enc（单密钥）+ secrets\key-name.txt：migrateLegacy()
 *     在拿到口令后把旧密钥导入 v2，旧文件保留不删，可回退。
 *
 * CLI: node tools/secret.js <set|status|migrate|selftest> [--site ID]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SECRET_DIR = path.join(ROOT, 'secrets');
const DEFAULT_FILE = path.join(SECRET_DIR, 'keys.enc');
const LEGACY_FILE = path.join(SECRET_DIR, 'model-key.enc');
const KEYNAME_FILE = path.join(SECRET_DIR, 'key-name.txt');
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const VERIFY_PLAINTEXT = 'dsh-to-go:verify';

/** v2 密钥库文件（测试可用 WZD_SECRET_FILE 重定向）。 */
function secretFile() {
  return process.env.WZD_SECRET_FILE || DEFAULT_FILE;
}
/** 旧版单密钥文件（测试可用 WZD_LEGACY_FILE 重定向）。 */
function legacyFile() {
  return process.env.WZD_LEGACY_FILE || LEGACY_FILE;
}

function keyName() {
  try {
    const v = fs.readFileSync(KEYNAME_FILE, 'utf8').trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return v;
  } catch (e) { /* fall through to default */ }
  return 'DEEPSEEK_API_KEY';
}

/**
 * 该注入哪个环境变量名。
 *
 * 多站点下变量名来自「密钥自己记的名字」（或站点表的 keyEnv）；`secrets\key-name.txt`
 * 只作旧单密钥路径的兜底覆盖——它是个**全局单名**，用它盖掉每个密钥自己的名字会让
 * 多站点互相对不上（实测过：旧密钥会以错误的变量名注入）。
 */
function currentKeyName(storedName) {
  if (storedName) return storedName;
  let override = null;
  try {
    const v = fs.readFileSync(KEYNAME_FILE, 'utf8').trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) override = v;
  } catch (e) { /* no override file */ }
  return override || 'DEEPSEEK_API_KEY';
}

function setKeyName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('变量名必须是合法的环境变量标识符');
  fs.mkdirSync(SECRET_DIR, { recursive: true });
  fs.writeFileSync(KEYNAME_FILE, name + '\n', 'utf8');
}

// ------------------------------------------------------------------ 加解密原语
function derive(pass, salt, params) {
  const p = params || SCRYPT;
  return crypto.scryptSync(pass, salt, p.keylen || SCRYPT.keylen, { N: p.N, r: p.r, p: p.p });
}

/** 加密一段文本，返回 { salt, iv, tag, ct }（base64）。 */
function seal(plain, pass, params) {
  const p = params || SCRYPT;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = derive(pass, salt, p);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64'),
  };
}

function openSealed(block, pass, params) {
  const p = params || SCRYPT;
  const key = derive(pass, Buffer.from(block.salt, 'base64'), p);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(block.iv, 'base64'));
  d.setAuthTag(Buffer.from(block.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(block.ct, 'base64')), d.final()]).toString('utf8');
}

/** 兼容旧接口：v1 单密钥 blob（读旧文件、写旧格式时用）。 */
function encrypt(secret, pass) {
  return Object.assign({
    v: 1, algo: 'aes-256-gcm', kdf: 'scrypt', kdf_params: SCRYPT,
    key_name: keyName(), created: new Date().toISOString(),
  }, seal(secret, pass));
}

function decrypt(blob, pass) {
  if (!blob || blob.v !== 1 || blob.algo !== 'aes-256-gcm') throw new Error('不支持的密钥文件格式');
  return openSealed(blob, pass, blob.kdf_params || SCRYPT);
}

// ------------------------------------------------------------------ v2 密钥库
function emptyStore() {
  return { version: 2, algo: 'aes-256-gcm', kdf: 'scrypt', kdf_params: SCRYPT, verifier: null, keys: {}, updated: null };
}

function readStore(file) {
  const f = file || secretFile();
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && j.version === 2 && j.keys) return j;
  } catch (e) { /* missing */ }
  return null;
}

function writeStore(store, file) {
  const f = file || secretFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  store.version = 2;
  store.updated = new Date().toISOString();
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
  return f;
}

/** 首次设置口令时建立校验器；已有则原样返回。 */
function ensurePass(pass, file) {
  if (!pass) throw new Error('口令不能为空');
  const f = file || secretFile();
  const store = readStore(f) || emptyStore();
  if (!store.verifier) {
    store.verifier = seal(VERIFY_PLAINTEXT, pass);
    writeStore(store, f);
  }
  return store;
}

/** 口令对不对（只看校验器，不解任何密钥）。 */
function verifyPass(pass, file) {
  const store = readStore(file);
  if (!store || !store.verifier) return false;
  try {
    return openSealed(store.verifier, pass, store.kdf_params) === VERIFY_PLAINTEXT;
  } catch (e) {
    return false;
  }
}

/** 写入/更新某站点的密钥（口令必须是本库的口令）。 */
function setKey(siteId, secret, pass, opts) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(siteId || ''))) throw new Error('站点 ID 不合法：' + siteId);
  if (!secret) throw new Error('密钥不能为空');
  const o = opts || {};
  const f = o.file || secretFile();
  const store = ensurePass(pass, f);
  if (!verifyPass(pass, f)) throw new Error('口令与本密钥库的校验器不匹配');
  const name = o.keyName || keyName();
  store.keys[siteId] = Object.assign(seal(secret, pass, store.kdf_params), {
    key_name: name, length: secret.length, created: new Date().toISOString(),
  });
  writeStore(store, f);
  return { siteId, keyName: name, length: secret.length, bytes: fs.statSync(f).size };
}

function removeKey(siteId, file) {
  const f = file || secretFile();
  const store = readStore(f);
  if (!store || !store.keys[siteId]) return false;
  delete store.keys[siteId];
  writeStore(store, f);
  return true;
}

/** 已保存的密钥清单（不含明文）。 */
function listKeys(file) {
  const store = readStore(file);
  if (!store) return [];
  return Object.keys(store.keys).sort().map((id) => ({
    siteId: id,
    keyName: store.keys[id].key_name || null,
    length: store.keys[id].length || null,
    created: store.keys[id].created || null,
  }));
}

/** 删除整个密钥库（等于作废全部密钥与口令校验器）。 */
function destroyStore(file) {
  const f = file || secretFile();
  try { fs.unlinkSync(f); return true; } catch (e) { return false; }
}

/** 用口令解开全部密钥。@returns { ok, keys: {siteId: 明文}, meta, reason } */
function unlockAll(pass, file) {
  const store = readStore(file);
  if (!store) return { ok: false, reason: 'missing', keys: {} };
  if (store.verifier && !verifyPass(pass, file)) return { ok: false, reason: 'badpass', keys: {} };
  const keys = {};
  for (const id of Object.keys(store.keys)) {
    try {
      keys[id] = openSealed(store.keys[id], pass, store.kdf_params);
    } catch (e) {
      return { ok: false, reason: 'badpass', keys: {} };
    }
  }
  return { ok: true, keys, meta: listKeys(file) };
}

/**
 * 兼容旧调用（启动器仍在用）：返回「主密钥」。
 * 新库存在 → 取 key-name.txt 指定的那个，否则唯一的那个，否则第一个。
 * 只有旧文件 → 走旧逻辑（单密钥）。
 */
function unlock(opts) {
  const o = opts || {};
  const file = o.file || secretFile();
  if (readStore(o.file)) {
    if (o.pass === undefined) return { ok: false, reason: 'noprompt', file, keyName: currentKeyName() };
    const r = unlockAll(o.pass, o.file);
    if (!r.ok) return { ok: false, reason: r.reason, file, keyName: currentKeyName() };
    const want = currentKeyName();
    const ids = Object.keys(r.keys);
    const byName = r.meta.find((m) => m.keyName === want);
    const pick = (byName && byName.siteId) || (ids.length === 1 ? ids[0] : ids.find((id) => id === want)) || ids[0];
    if (!pick) return { ok: false, reason: 'empty', file, keyName: want };
    const meta = r.meta.find((m) => m.siteId === pick) || {};
    return {
      ok: true, secret: r.keys[pick], keyName: meta.keyName || currentKeyName(),
      file, created: meta.created, keys: r.keys, all: r.meta, siteId: pick,
    };
  }
  let blob;
  try {
    blob = JSON.parse(fs.readFileSync(o.file || legacyFile(), 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'missing', file: o.file || legacyFile(), keyName: keyName() };
  }
  const name = blob.key_name || currentKeyName();
  let pass;
  if (o.pass !== undefined) pass = o.pass;
  else {
    try {
      pass = promptPass('U 盘密钥口令');
    } catch (e) {
      return { ok: false, reason: 'noprompt', error: e.message, file: o.file || legacyFile(), keyName: name };
    }
  }
  try {
    return { ok: true, secret: decrypt(blob, pass), keyName: name, file: o.file || legacyFile(), created: blob.created, keys: {}, legacy: true };
  } catch (e) {
    return { ok: false, reason: 'badpass', file: o.file || legacyFile(), keyName: name };
  }
}

/** 把旧单密钥文件导入 v2（旧文件保留，可回退）。 */
function migrateLegacy(pass, siteId, opts) {
  const o = opts || {};
  const file = o.file || secretFile();
  // 先确认 v2 库的口令一致：否则 setKey 会抛异常，调用方拿到的是崩溃而不是可处理的结果
  const store = readStore(file);
  if (store && store.verifier && !verifyPass(pass, file)) return { ok: false, reason: 'badpass' };
  let blob;
  try {
    blob = JSON.parse(fs.readFileSync(o.legacyFile || legacyFile(), 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'missing' };
  }
  let secret;
  try {
    secret = decrypt(blob, pass);
  } catch (e) {
    return { ok: false, reason: 'badpass' };
  }
  const name = blob.key_name || currentKeyName();
  const id = siteId || (name && name !== 'DEEPSEEK_API_KEY'
    ? (name.replace(/_API_KEY$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default')
    : 'default');
  // 目标站点已经有密钥时不静默覆盖（旧值可能是用户更需要的那个）
  if (store && store.keys[id] && !o.overwrite) return { ok: false, reason: 'exists', siteId: id };
  const res = setKey(id, secret, pass, { keyName: name, file });
  return { ok: true, siteId: id, length: secret.length, keyName: res.keyName };
}

// ------------------------------------------------------------------ 交互
function askHidden(prompt) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$p = Read-Host -AsSecureString '" + String(prompt).replace(/'/g, "''") + "'",
    '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p)',
    '$s = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)',
    '[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)',
    "[Console]::Out.Write('V:' + $s)",
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.error) throw new Error('无法启动 PowerShell 读取掩码口令：' + r.error.message);
  const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l.indexOf('V:') === 0);
  if (!lines.length) throw new Error('掩码提示没有返回值（状态码 ' + r.status + '）');
  return lines[lines.length - 1].slice(2);
}

function promptPass(label) {
  if (process.env.WZD_KEY_PASS !== undefined) return process.env.WZD_KEY_PASS;
  if (!process.stdin.isTTY) {
    throw new Error('当前环境没有控制台，无法弹出掩码口令提示（非交互启动）。' +
      '请设置 WZD_KEY_PASS、加 --no-key，或在真正的 cmd 窗口里运行。');
  }
  return askHidden(label);
}

// ------------------------------------------------------------------ CLI
function cmdSet(argv) {
  const siteId = (argv.indexOf('--site') >= 0 ? argv[argv.indexOf('--site') + 1] : null) || 'default';
  const explicitName = argv.indexOf('--key-name') >= 0 ? argv[argv.indexOf('--key-name') + 1] : null;
  // 变量名以站点表里的 keyEnv 为准（单一事实来源）；站点表里没有这个站点才按规则推导。
  const sitesLib = require('./sites.js');
  let declared = null;
  try {
    const s = sitesLib.readState().sites.find((x) => x.id === siteId);
    if (s && s.keyEnv) declared = s.keyEnv;
  } catch (e) { /* 站点表还没建起来 */ }
  const nameForSite = explicitName || declared || (siteId === 'default' ? keyName() : sitesLib.keyEnvFor(siteId));
  const stdinMode = argv.includes('--pass-stdin') || !process.stdin.isTTY;
  let pass, secret;
  if (stdinMode) {
    const text = (() => { try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; } })();
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (process.env.WZD_KEY_PASS !== undefined) { pass = process.env.WZD_KEY_PASS; secret = lines[0] || ''; }
    else { pass = lines[0] || ''; secret = lines[1] || ''; }
  } else {
    pass = promptPass('设置口令（不保存在任何地方）');
    const again = askHidden('再输入一次口令');
    if (pass !== again) { console.log('两次口令不一致，没有写入任何内容。'); return 2; }
    secret = askHidden('站点 ' + siteId + ' 的 API 密钥（隐藏输入，不落盘）');
  }
  if (!pass) { console.log('口令不能为空，已拒绝。'); return 2; }
  if (!secret) { console.log('密钥不能为空，已拒绝（要清除某站点密钥请用图形界面或删除文件）。'); return 2; }
  const r = setKey(siteId, secret, pass, { keyName: nameForSite });
  console.log('加密密钥已写入：' + secretFile());
  console.log('  算法     : aes-256-gcm / scrypt (N=16384)');
  console.log('  站点     : ' + r.siteId);
  console.log('  变量名   : ' + r.keyName);
  console.log('  密钥长度 : ' + r.length + ' 字符（明文不在本盘任何位置）');
  return 0;
}

function cmdStatus() {
  const f = secretFile();
  console.log('密钥库       : ' + f + (fs.existsSync(f) ? '' : '（不存在）'));
  const store = readStore(f);
  if (store) {
    const items = listKeys(f);
    console.log('口令校验器   : ' + (store.verifier ? '已设置' : '未设置'));
    console.log('已存密钥     : ' + items.length + ' 个');
    for (const it of items) {
      console.log('  - ' + it.siteId + '  ' + (it.keyName || '(未记名)') + '  ' + (it.length || '?') + ' 字符  ' + (it.created || ''));
    }
  } else {
    console.log('状态         : 尚未建立密钥库');
  }
  const lf = legacyFile();
  if (fs.existsSync(lf)) {
    console.log('旧版单密钥   : 仍在（' + lf + '）');
    console.log('               导入：WZD_KEY_PASS=<口令> node tools/secret.js migrate --site <站点ID>');
  }
  return 0;
}

function cmdMigrate(argv) {
  const site = argv.indexOf('--site') >= 0 ? argv[argv.indexOf('--site') + 1] : null;
  const pass = process.env.WZD_KEY_PASS !== undefined ? process.env.WZD_KEY_PASS : null;
  if (!pass) { console.log('请先设置环境变量 WZD_KEY_PASS（避免口令进命令行），或在图形界面里迁移。'); return 2; }
  const overwrite = argv.includes('--overwrite');
  const r = migrateLegacy(pass, site, { overwrite });
  if (!r.ok) {
    if (r.reason === 'badpass') console.log('迁移失败：口令不对（新密钥库与旧文件的口令不一致，或旧文件口令错了）。');
    else if (r.reason === 'exists') console.log('迁移失败：站点 ' + r.siteId + ' 已经有密钥了；确认要覆盖就加 --overwrite。');
    else console.log('迁移失败：找不到可迁移的旧密钥文件。');
    return 1;
  }
  console.log('已导入站点 ' + r.siteId + '（变量名 ' + r.keyName + '，' + r.length + ' 字符）。旧文件保留未删。');
  return 0;
}

function cmdSelftest() {
  const dir = process.env.WZD_SELFTEST_DIR || require('os').tmpdir();
  const tmp = path.join(dir, 'secret-selftest-' + crypto.randomBytes(4).toString('hex') + '.enc');
  const pass = 'selftest-pass';
  const store = emptyStore();
  store.verifier = seal(VERIFY_PLAINTEXT, pass);
  store.keys['site-a'] = Object.assign(seal('sk-aaa', pass), { key_name: 'SITE_A_API_KEY', length: 6 });
  store.keys['site-b'] = Object.assign(seal('sk-bbb', pass), { key_name: 'SITE_B_API_KEY', length: 6 });
  writeStore(store, tmp);
  const raw = fs.readFileSync(tmp, 'utf8');
  const ok1 = verifyPass(pass, tmp) === true;
  const ok2 = verifyPass('wrong-pass', tmp) === false;
  const un = unlockAll(pass, tmp);
  const ok3 = un.ok && un.keys['site-a'] === 'sk-aaa' && un.keys['site-b'] === 'sk-bbb';
  const ok4 = listKeys(tmp).length === 2;
  const leaks = raw.includes('sk-aaa') || raw.includes('sk-bbb') || raw.includes(pass);
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  console.log('口令校验器 : ' + (ok1 && ok2 ? '通过（对的通过、错的拒绝）' : '失败'));
  console.log('多站点往返 : ' + (ok3 ? '通过' : '失败'));
  console.log('密钥清单   : ' + (ok4 ? '2 条（正确）' : '异常'));
  console.log('明文泄漏   : ' + (leaks ? '文件里发现明文（错误！）' : '文件里没有明文（正确）'));
  return (ok1 && ok2 && ok3 && ok4 && !leaks) ? 0 : 1;
}

module.exports = {
  ROOT, SECRET_DIR, secretFile, legacyFile, keyName, currentKeyName, setKeyName,
  askHidden, promptPass, encrypt, decrypt, unlock,
  emptyStore, readStore, writeStore, ensurePass, verifyPass, setKey, removeKey, listKeys,
  destroyStore, unlockAll, migrateLegacy, seal, openSealed,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || 'status').toLowerCase();
  const rest = argv.slice(1);
  let rc = 0;
  try {
    if (cmd === 'set') rc = cmdSet(rest);
    else if (cmd === 'status') rc = cmdStatus();
    else if (cmd === 'migrate') rc = cmdMigrate(rest);
    else if (cmd === 'selftest') rc = cmdSelftest();
    else { console.log('用法：node tools/secret.js <set|status|migrate|selftest> [--site ID]'); rc = 2; }
  } catch (e) {
    console.error('密钥模块错误：' + e.message);
    rc = 1;
  }
  process.exit(rc);
}
