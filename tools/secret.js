'use strict';
/**
 * A2 secret store for the portable DeepSeek Harness.
 *
 * AES-256-GCM with a scrypt-derived key. The passphrase is never stored anywhere;
 * the plaintext model key never touches the disk -- it lives only in the launcher
 * process memory and in the child `dsh` process environment.
 *
 * CLI:
 *   node tools/secret.js set   [--file PATH] [--key-name NAME] [--pass-stdin] [--secret-stdin]
 *   node tools/secret.js status
 *   node tools/secret.js selftest
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SECRET_DIR = path.join(ROOT, 'secrets');
const DEFAULT_FILE = path.join(SECRET_DIR, 'model-key.enc');
const KEYNAME_FILE = path.join(SECRET_DIR, 'key-name.txt');
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function secretFile() {
  return process.env.WZD_SECRET_FILE || DEFAULT_FILE;
}

function keyName() {
  try {
    const v = fs.readFileSync(KEYNAME_FILE, 'utf8').trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return v;
  } catch (e) { /* fall through to default */ }
  return 'DEEPSEEK_API_KEY';
}

/**
 * Which environment variable should carry the key right now.
 *
 * `secrets\key-name.txt` wins over the name recorded inside the encrypted blob:
 * the same stored key has to be re-pointable at a different provider (official
 * DeepSeek vs. a relay that reads GATEWAY_API_KEY) without re-entering it.
 */
function currentKeyName(storedName) {
  const override = keyName();
  if (override !== 'DEEPSEEK_API_KEY') return override;
  try {
    const v = fs.readFileSync(KEYNAME_FILE, 'utf8').trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return v;
  } catch (e) { /* no override file */ }
  return storedName || override;
}

function setKeyName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('变量名必须是合法的环境变量标识符');
  fs.mkdirSync(SECRET_DIR, { recursive: true });
  fs.writeFileSync(KEYNAME_FILE, name + '\n', 'utf8');
}

/**
 * Masked prompt via PowerShell Read-Host -AsSecureString.
 * The entered text is written to stdout only, prefixed with "V:" so stray
 * PowerShell output can never be mistaken for the value.
 */
function askHidden(prompt) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$p = Read-Host -AsSecureString '" + String(prompt).replace(/'/g, "''") + "'",
    '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p)',
    '$s = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)',
    '[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)',
    "[Console]::Out.Write('V:' + $s)"
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

function encrypt(secret, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    v: 1,
    algo: 'aes-256-gcm',
    kdf: 'scrypt',
    kdf_params: SCRYPT,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    key_name: keyName(),
    created: new Date().toISOString()
  };
}

function decrypt(blob, pass) {
  if (!blob || blob.v !== 1 || blob.algo !== 'aes-256-gcm') throw new Error('不支持的密钥文件格式');
  const p = blob.kdf_params || SCRYPT;
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const key = crypto.scryptSync(pass, salt, p.keylen || SCRYPT.keylen, { N: p.N, r: p.r, p: p.p });
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

/** Unlock the stored key. Returns { ok, secret, reason, keyName }. */
function unlock(opts) {
  const file = (opts && opts.file) || secretFile();
  let blob;
  try {
    blob = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'missing', file, keyName: keyName() };
  }
  const name = currentKeyName(blob.key_name);
  let pass;
  if (opts && opts.pass !== undefined) pass = opts.pass;
  else {
    try {
      pass = promptPass('U 盘密钥口令');
    } catch (e) {
      return { ok: false, reason: 'noprompt', error: e.message, file, keyName: name };
    }
  }
  try {
    return { ok: true, secret: decrypt(blob, pass), keyName: name, file, created: blob.created };
  } catch (e) {
    return { ok: false, reason: 'badpass', file, keyName: name };
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function cmdSet(argv) {
  const file = valueOf(argv, '--file') || secretFile();
  const name = valueOf(argv, '--key-name');
  if (name) setKeyName(name);
  const stdinMode = argv.includes('--pass-stdin') || argv.includes('--secret-stdin') || !process.stdin.isTTY;
  let pass, secret;
  if (stdinMode) {
    const lines = readStdin().replace(/\r\n/g, '\n').split('\n');
    const passFromEnv = process.env.WZD_KEY_PASS;
    if (passFromEnv !== undefined) {
      pass = passFromEnv;
      secret = lines[0] || '';
    } else {
      pass = lines[0] || '';
      secret = lines[1] || '';
    }
  } else {
    pass = promptPass('设置新口令（不保存在任何地方）');
    const again = askHidden('再输入一次口令');
    if (pass !== again) {
      console.log('两次口令不一致，没有写入任何内容。');
      return 2;
    }
    secret = askHidden('模型 API 密钥（隐藏输入，不写入磁盘）');
  }
  if (!pass) { console.log('口令不能为空，已拒绝。'); return 2; }
  if (!secret) { console.log('密钥不能为空，已拒绝（要清除请删除文件，而不是留空）。'); return 2; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(encrypt(secret, pass), null, 2), 'utf8');
  fs.renameSync(tmp, file);
  console.log('加密密钥已写入：' + file);
  console.log('  算法      : aes-256-gcm / scrypt (N=16384)');
  console.log('  变量名    : ' + keyName());
  console.log('  密钥长度  : ' + secret.length + ' 字符（明文不在本盘任何位置）');
  return 0;
}

function cmdStatus(argv) {
  const file = valueOf(argv, '--file') || secretFile();
  console.log('当前注入变量名 : ' + currentKeyName());
  console.log('密钥文件       : ' + file);
  try {
    const st = fs.statSync(file);
    const blob = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log('状态           : 已配置');
    console.log('  文件中记录名 : ' + (blob.key_name || '未记录'));
    console.log('  大小         : ' + st.size + ' 字节');
    console.log('  创建时间     : ' + (blob.created || '未知'));
    console.log('  算法         : ' + blob.algo + ' / ' + blob.kdf);
  } catch (e) {
    console.log('状态           : 未配置（启动器会不带密钥启动 dsh）');
  }
  return 0;
}

function cmdSelftest(argv) {
  const tmp = path.join(ROOT, 'secrets', '.selftest.enc');
  const pass = 'selftest-pass';
  const secret = 'sk-selftest-' + crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(encrypt(secret, pass)), 'utf8');
  const blob = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  const back = decrypt(blob, pass);
  let wrongPass = false;
  try { decrypt(blob, 'wrong-pass'); } catch (e) { wrongPass = true; }
  const raw = fs.readFileSync(tmp, 'utf8');
  const leaks = raw.includes(secret) || raw.includes(pass);
  fs.unlinkSync(tmp);
  console.log('加解密往返 : ' + (back === secret ? '通过' : '失败'));
  console.log('错误口令   : ' + (wrongPass ? '已拒绝（正确）' : '竟然通过（错误！）'));
  console.log('明文泄漏   : ' + (leaks ? '文件里发现明文（错误！）' : '文件里没有明文（正确）'));
  return (back === secret && wrongPass && !leaks) ? 0 : 1;
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

module.exports = { ROOT, SECRET_DIR, secretFile, keyName, currentKeyName, setKeyName, askHidden, promptPass, encrypt, decrypt, unlock };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  const rest = argv.slice(1);
  let rc = 0;
  try {
    if (cmd === 'set') rc = cmdSet(rest);
    else if (cmd === 'status') rc = cmdStatus(rest);
    else if (cmd === 'selftest') rc = cmdSelftest(rest);
    else { console.log('用法：node tools/secret.js <set|status|selftest> [...]'); rc = 2; }
  } catch (e) {
    console.error('密钥模块错误：' + e.message);
    rc = 1;
  }
  process.exit(rc);
}
