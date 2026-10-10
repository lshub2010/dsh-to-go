# dsh-to-go

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）装成一个**插上就能用、拔下来什么都不留**的便携 Agent：所有状态都在 U 盘/移动硬盘上，跟着盘走，随时能升级、能回滚。

> 非官方项目。dsh 由 DeepSeek AI 开发（MIT），本仓库只提供便携化的外壳与运维工具，不修改、不重打包它的代码——构建时从 npm 官方源现装。

---

## 它解决什么问题

| 直接装在机器上 | dsh-to-go |
|---|---|
| 要先有 Node/npm，装完散落各处 | 盘上自带便携 Node，宿主什么都不用装 |
| 写注册表/PATH，换台机器状态就丢 | 只用**进程内**环境变量，绝不 `setx`，拔盘即走 |
| 会话、工作区、缓存留在宿主家目录 | `DSH_HOME` 指向盘上 `data\`，宿主零残留 |
| 密钥明文放在 YAML 里 | 口令派生密钥 + AES-256-GCM 加密，只在启动时解密进内存 |
| 升级出问题回不去 | **A/B 双槽**：装到空闲槽 → 自检通过 → 才切指针；回滚改一行 |
| 用中转/自建网关要手改上游配置 | 站点配置是**独立覆盖层**，由 `--patch` 加载，不碰上游文件 |
| 命令行配置又长又乱 | 浏览器里的**图形配置页**（站点/密钥/槽位/升级/自检） |

## 快速开始

```bat
git clone https://github.com/wanzhang-xr/dsh-to-go.git
cd dsh-to-go
build.cmd        :: 下载并校验便携 Node，装 dsh 到两个槽（约 10 分钟 / 1.4 GB）
```

构建完成后：

```bat
dsh-config.cmd   :: 维护台：5) key 存密钥、7) site 配站点   ← 或直接用 dsh-ui.cmd 图形配置
dsh.cmd          :: 日常入口：启动 Web UI 并打开浏览器
```

**要求**：Windows 10/11 x64；2 GB 空闲空间；构建时需要联网。**运行时不要求宿主装 Node。**

想直接塞进 U 盘：把整个仓库目录拷到盘上再跑 `build.cmd`，或者构建完再拷——路径会跟着盘符自动适配（`subst X:` 换盘符也正常，盘符不作为标识）。

## 目录结构

```
dsh-to-go\
├─ build.cmd                一次性构建（无依赖引导）
├─ dsh.cmd                  日常入口：起 Web UI（默认 3180）并开浏览器
├─ dsh-cli.cmd              命令行入口：dsh --version / headless "任务" …
├─ dsh-config.cmd           维护台（终端菜单）
├─ dsh-ui.cmd               图形配置页（浏览器）
├─ dsh-doctor.cmd           一键自检
├─ runtime\                 构建产物（不进 git）
│   ├─ node\                便携 Node
│   ├─ agent-A\ agent-B\    两个 dsh 槽（各有自己的 node_modules）
│   ├─ npm-cache\           盘内 npm 缓存
│   ├─ current.txt          当前活动槽
│   └─ port.txt             网页端口
├─ data\                    DSH_HOME：会话/工作区/配置（不进 git）
├─ secrets\                 AES 加密的密钥文件（不进 git）
├─ backups\                 槽位备份 zip（不进 git）
├─ tools\                   启动器 / 密钥 / 站点 / 维护台 / 构建器
└─ ui\config.html           图形配置页（单文件，无外链）
```

## 五个入口

| 入口 | 用途 |
|---|---|
| `dsh.cmd` | 起 Web UI：解锁密钥 → 选活动槽 → 校验站点覆盖层 → 起服务并开浏览器 |
| `dsh-cli.cmd` | 不打开界面的用法：`dsh-cli.cmd --version`、`dsh-cli.cmd headless "改个 bug"` |
| `dsh-config.cmd` | 终端维护台：自检 / 升级 / 切槽 / 备份 / 密钥 / 站点配置 / 图形页 |
| `dsh-ui.cmd` | 图形配置页：概览、站点与模型、密钥、槽位与升级、诊断 |
| `dsh-doctor.cmd` | 一键体检：Node、槽位、端口、密钥、站点、残留进程、宿主污染 |

## 密钥是怎么保住的

选的是「**盘上放密文，口令不落盘**」的方案：

1. `dsh-config.cmd → 5) key`：输入两遍口令（不回显、不落盘）＋粘贴 API key（隐藏输入）
2. 用 `scrypt` 从口令派生密钥，`aes-256-gcm` 加密后写入 `secrets\model-key.enc`
3. 启动时解密，**只注入当前进程环境变量**（`launch.js` 内 `set`，绝不用 `setx`），不写回 `data\`、不进命令行参数、不进日志
4. 变量名以 `secrets\key-name.txt` 为准——换网关只要改这个名字，**密钥不用重新输入**

**换机器/换人用**：口令不对就是解不开，`dsh-config.cmd → 5` 重设即可（会覆盖旧密文）。**盘丢了**：密文 + 口令双重门槛，比明文 YAML 强得多；但请自行判断口令强度。

## 站点配置（官方 / 中转 / 自建）

dsh 自己的凭据分层是「启动环境 > `.credentials.yaml` > 项目 `.env` > 家目录 `.env`」。本工具走**最高优先级那层**，并额外解决「非官方网关」的问题：

- 站点 ID、接口地址、协议（`openai-completions` / `openai-responses` / `anthropic-messages`）、模型清单、兼容开关（如拒收 `role: developer`、只认 `max_tokens`）
- 写进 `data\site-patch.yml`，启动时作为 `dsh --patch <file>` 传入——**上游文件 `data\profiles\web\cordis.patch.yml` 完全归 dsh 与它的 Web UI 所有**，本工具不往里写
- 配完可以点「验收」：跑 `--dump-config` 组合一遍，确认站点 provider 真的进了配置树

## 图形配置页

`dsh-ui.cmd` 在 `127.0.0.1` 上起一个本地页面：概览 / 站点与模型 / 密钥 / 槽位与升级 / 诊断五页。

安全姿态（浏览器是共享进程，所以按服务来防）：只绑回环；每次启动生成随机令牌，页面必须带 `?token=` 打开、API 必须带 `x-config-token` 头；带外部 `Origin` 的请求直接 403；不发 CORS 头；密钥只在本地请求体里传，进程内加密，不回显、不落日志。

## 已知坑（替你踩过了）

| 现象 | 原因与处理 |
|---|---|
| `sandbox-local … temp grant materialization failed and its cleanup also failed` | Windows ACL 沙箱要在 `os.tmpdir()` 下建私有临时目录并写安全描述符（含完整性标签），这一步需要目录的 `WRITE_OWNER`。数据盘根目录通常只给登录用户 `Modify`（非提升令牌下 `Administrators:(F)` 是 deny-only），于是 `SetNamedSecurityInfoW` 返回 Win32 5。**启动器默认把临时目录放在宿主 `%LOCALAPPDATA%\Temp`**；确实想放盘上，建 `runtime\usb-temp.txt`，并确保那块盘给足 `WRITE_OWNER`。 |
| `error: --profile <name> is required` | dsh 的参数解析不接受「启动器标记 + 裸命令名」的顺序（`--patch f web` 会被拒）。启动器现在把标记插在 profile/命令之后（`--profile web --patch f …`、`web --patch f …` 均可）。 |
| 中文提示在命令行里变乱码/截断 | `cmd.exe` 用系统 ANSI（中文机器是 GBK）解析 `.bat`，UTF-8 中文会破坏行与括号配对。所以所有 `.cmd` 保持**纯 ASCII**，中文提示放在 `tools\msg\*.txt`（UTF-8）里由 `tools\say.cmd` 打印。 |
| 宿主上也装了 dsh，两边互相打架 | 共享的是端口（宿主默认 3080，本盘用 3180）、浏览器 cookie（类型按 host+port 哈希，所以分端口即分登录）与 PATH/模块解析。启动器对 `DSH_HOME`/`DSH_AGENTS_HOME`/`npm_config_cache` 等**无条件覆盖**，并且从不碰宿主的 `C:\Users\<你>\.agents`。 |
| 端口被占就直接起不来 | 实测 dsh 端口冲突时**不会自动换端口**，直接 `EADDRINUSE` 退出。改端口：`dsh-config.cmd → 4` 或图形页「槽位与升级」。 |
| 升级后想退回去 | 改 `runtime\current.txt` 一行（或维护台 `3) switch`）。两个槽各自独立，随时互切。 |

## 自己构建时都发生了什么

1. `build.cmd` → `tools\build.ps1`：下载官方 Node win-x64 zip（**校验 SHA-256**，失败则中止）、解压成 `runtime\node`
2. → `tools\install.js`：为每个槽写 `package.json` 并在槽目录里 `npm install --cache=runtime\npm-cache`，官方源失败自动换 npmmirror；然后写 `current.txt`/`port.txt`/`VERSION.txt`
3. 之后所有启动都走 `tools\launch.js`：解锁密钥 → 组装环境 → 注入站点覆盖层 → 起 dsh

更细的设计取舍与验证记录见 [`docs/DESIGN.md`](docs/DESIGN.md)，日常使用说明见 [`docs/USAGE.md`](docs/USAGE.md)。

## 与上游的关系

- dsh 的所有权与许可是 DeepSeek AI 的（MIT）；本仓库不打包、不改写它的代码，构建时从 npm 现装。
- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>。遇到 dsh 本身的功能/协议问题，请以上游为准。
- 本项目只提供「便携化 + 多站点 + 密钥保护 + 双槽升级 + 图形配置」这些外壳能力。

## 许可

本仓库代码：[MIT](LICENSE)。你可以自由使用、修改、再分发（保留版权声明即可）。dsh 本体仍是 DeepSeek AI 的 MIT 项目。

## 致谢

- DeepSeek AI —— [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- `hermes-portable` —— 便携化思路的早期参考
