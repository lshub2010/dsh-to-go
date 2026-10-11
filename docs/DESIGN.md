# 设计取舍与验证记录

这份文档记录的是**为什么这么设计**，以及每个结论背后的实测依据。想改这套东西的人应该先看这里，能省掉重复踩坑的时间。

## 1. 为什么要 A/B 双槽

dsh 目前是 developer preview，版本之间不保证兼容（配置 schema、协议字段都在动）。所以升级不是「就地覆盖」，而是：

```
装到空闲槽  →  用新槽跑一次启动自检（--version / --dump-config）
            →  通过才把 runtime\current.txt 指向新槽
            →  不通过：指针不动，旧槽继续用，新文件留着给人排查
```

回滚 = 把 `current.txt` 改成另一个槽名，**秒级**。两个槽各自有完整的 `node_modules`，互不影响；`runtime\npm-cache` 共用，所以第二个槽的安装时间大约是第一个的三分之一（实测：冷装 5 分 28 秒 / 复用缓存 2 分 09 秒）。

## 2. 为什么端口必须固定

实测：端口被占时 dsh **不会**自动换端口，直接 `startup failed: … listen EADDRINUSE 127.0.0.1:3080` 然后退出码 1。所以便携实例固定用 3180（宿主版默认 3080，两者可以并存）。

浏览器 cookie 的类型是按 host+port 哈希的，所以端口不同 = 登录态互不干扰；一旦两个实例撞同一端口，第二个人会把第一个人挤下线。这也是为什么 `port.txt` 是盘上唯一的端口来源，图形页改的也是它。

## 3. 站点配置为什么用独立覆盖层

dsh 支持给 profile 打补丁（`--patch <file>`），但**它自己也会往同一个数组里追加条目**——追加的位置是数组末尾，也就是尾部注释**之前**。最初的实现把「站点配置块」用注释标记写在这个文件里，结果 dsh/Web UI 的设置被夹进了受管区：下次重新生成站点配置时，会被当成自己写的东西一起删掉。

现在：站点配置写到独立的 `data\site-patch.yml`，启动时作为 `--patch` 传入；`data\profiles\web\cordis.patch.yml` 完全归 dsh 与它的 Web UI 所有。迁移时还踩了一个连带 bug：清理标记行时把「落在 ui-theme 块里的尾部标记」连同那一整块一起删了 —— 正确做法是**对标记行做原地过滤**，并且按顶层条目判断归属。回归测试直接跑在真实文件上，断言周围三条设置全部存活。

链路验证（两端都要测）：

```
带 --patch : 组合出的配置树里有完整 provider（含 baseURL）
不带      : 只剩一个悬空的 provider: 引用  → 证明这层确实生效
```

## 4. 参数顺序：`--patch` 不能放在裸命令前面

```
--profile web --patch <f> …   ✅
--patch <f> --profile web …   ✅
--patch <f> web …             ❌ error: --profile <name> is required
web --patch <f> …             ✅
--patch <f> --version         ✅（没有命令标记时合法）
```

结论：把启动器标记插在 **profile / 命令标记之后**。教训更值钱：**`--dump-config` 能组合 ≠ 启动路径没问题**——这个顺序错误当时在「组合配置」这一项上是通过的，直到真的去起服务才暴露。所以启动器改动必须做一次真启动验收（起服务 → 取 token URL → 拉首页 → 期望 200），并且测试时把端口临时挪开，别动用户正开着的实例。

## 5. Windows ACL 沙箱与临时目录

报错原文：`sandbox-local windows-acl temp grant materialization failed and its cleanup also failed`。

用 dsh 自己的 ACL 模块做对照实验（宿主 temp vs 盘上 temp）：

| 位置 | 挂授权 | 回滚（撤销 + 删目录） |
|---|---|---|
| `%LOCALAPPDATA%\Temp` | ✅ | ✅ |
| 数据盘上的 `runtime\tmp` | ❌ `SetNamedSecurityInfoW` Win32 5 | ❌ |

根因：`workspace-write` 策略下，沙箱要在 `os.tmpdir()` 下 `mkdtempSync("dsh-")` 建私有临时目录，再给它挂一条可撤销的写权限，其中包括写**完整性标签**——这一步需要目录上的 `WRITE_OWNER`。数据盘根目录通常是 `Authenticated Users:(M)` 继承下来的「修改」权限，非提升令牌下 `Administrators:(F)` 是 deny-only，于是 `WRITE_OWNER` 缺失，`SetNamedSecurityInfoW` 返回拒绝访问；回滚同样失败，最后抛出 `AggregateError`。

处理：**默认把临时目录放在宿主**（`launch.js` 的 `tempRoot()`，自检里会打印实际使用的位置），盘上 opt-in（`runtime\usb-temp.txt`）。没有去改整块盘的 ACL——那是影响面大得多的动作，而这里根本不需要。

## 6. cmd.exe 代码页与中文

`cmd.exe` 解析 `.bat` 用的是**系统 ANSI 代码页**（中文 Windows 是 GBK）。UTF-8 的中文写在 `.cmd` 里会被按字节解析，出现截断行、括号不配对、`call` 参数错位之类的问题。所以：

- 所有 `.cmd` 保持**纯 ASCII**（换行 CRLF）
- 中文提示外置成 `tools\msg\*.txt`（UTF-8），由 `tools\say.cmd` 读取打印
- 脚本侧的交互（Node）里中文没问题，注意 `chcp 65001` 之后仍要显式按 UTF-8 读文件

Git 侧用 `.gitattributes` 固定 `*.cmd eol=crlf`，避免有人在 Linux/macOS 上改完提交，导致 Windows 上双击出问题。

## 7. 密钥模型（A2）

- **盘上只有密文**：`scrypt`（N=16384）派生 + `aes-256-gcm`（随机 IV + tag），密文文件里带 `key_name` 字段记录变量名
- **口令永不落盘**，解密只发生在启动瞬间
- **只注入进程环境变量**（`set`，不是 `setx`），因此：不污染宿主、不影响宿主上另装的 dsh、窗口关掉就没了
- **变量名可换**：以站点表的 `keyEnv` 为准（默认 `<站点ID>_API_KEY`），换官方/中转不用重新输入密钥
- 图形页里密钥只在本机请求体里传，服务端即时加密，不回显、不写日志

为什么不用「明文 YAML + 文件权限」？便携场景下盘会到处插，文件权限跟着文件系统走（FAT32/exFAT 上根本没有 ACL），口令加密是唯一不依赖宿主的手段。为什么不用系统凭据管理器？那就绑死在某一台机器上了，和「跟着盘走」冲突。

## 8. 构建器为什么要校验 SHA-256

`build.ps1` 会从网络下载一个 Node 二进制并解压执行。下载源不可控（官方站 + 镜像站都要试），所以带官方 `SHASUMS256.txt` 校验：**不匹配就中止**；拿不到清单时明确警告并继续（可以用 `-SkipChecksum` 显式跳过）。这是「给别人用的脚本」应有的最低标准。

## 9. 验证清单

改完这套东西，至少跑一遍这些（都可以在真机上自动化的）：

| 项 | 期望 |
|---|---|
| `tools\rescue\dsh-doctor.cmd` | 0 失败（端口被自己正开着的实例占用算已知警告） |
| 启动器自检 `launch.js selftest` | Node/槽位/端口/密钥/覆盖层/临时目录全部打印正常 |
| 真启动 Web UI | 首页 200、标题正确、带 token 才能开、无 token 401/403 |
| 宿主零残留 | `C:\Users\<你>\.dsh` 与 `.agents` 不因本盘启动而被创建/修改 |
| 换盘符 | `subst X:` 之后一切正常（路径不写死盘符） |
| A/B 切换与升级 | 装到空闲槽 → 自检 → 切指针 → 回滚可用 |
| 站点覆盖层 | 带/不带 `--patch` 两种组合都要看（见 §3） |
| 图形页 | 无 token 403、跨站 Origin 403、密钥落盘为密文且文件里无明文 |
| 密钥往返 | 存 → 启动注入 → 解密出的长度/变量名一致 |
