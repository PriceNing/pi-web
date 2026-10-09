# @pricening/pi-web

[English](./README.md)

这是 [agegr/pi-web](https://github.com/agegr/pi-web) 的**个人 fork**。上游是 [pi coding agent](https://github.com/earendil-works/pi) 的本地浏览器界面。

## 为什么要 fork

上游 Pi Web 本身很好，也非常活跃。这个仓库的目的是：**在跟得上上游的前提下，加上我自己要用的高级功能**，而不是等上游合并（历史上 pin / 收藏一类的会话组织 PR 都被关掉了，维护者计划另做一轮设计）。

| | |
|---|---|
| 上游 | [agegr/pi-web](https://github.com/agegr/pi-web)（只 fetch，不 push） |
| 本仓库 | [PriceNing/pi-web](https://github.com/PriceNing/pi-web) |
| npm 包 | **`@pricening/pi-web`**（不要装 `@agegr/pi-web`，否则补丁会被盖掉） |
| 上游基线 | `package.json` 的 `forkedFrom` |

只想要官方行为，请直接用上游包。只有需要下面这些额外功能时才用本包。

同步、版本、发布与补丁纪律见 **[docs/FORK.md](./docs/FORK.md)**（维护规范，不是这篇 README 的重复）。

## 本 fork 多出来的功能

- **置顶与归档现在由上游提供**（自 v0.11.0）：统一的服务端状态文件 `~/.pi/agent/pi-web-session-state.json` 保存已置顶/已归档的会话族、置顶项目、手动项目顺序、折叠态和侧栏内的归档视图，并用 revision 计数器让同一台服务器上的每个窗口看到同一份。我们读写都走它。
- **本 fork 在它之上加的**：**设置 → 归档** 这个全局页（不依赖当前项目），以及按项目的**批量删除**——需要输入确认词（`confirm` / `确认` / `確認`）、有运行中的 agent 时返回 409、subagent 级联、绝不删磁盘上的代码目录。另外仍然属于我们的：pinned-first 排序（上游只按活跃度和手动拖动排），以及为退役存储留下的一次性 importer `lib/ui-state-migrate.ts`。
- 采纳上游时接受的语义位移：归档条目按**会话族根**落键，同族多个兄弟折叠到最早的那个时间戳；迁移过去的项目 pin 会盖上迁移时刻的时间戳；迁移期间不凭空生成手动顺序。详见 [docs/FORK.md](./docs/FORK.md)。

其余能力与上游相同：与本地 pi CLI 共享 `~/.pi/agent`、同一套会话文件、同一套模型 / 登录 / 技能。

## 快速开始

需要 Node.js 22.19.0 或更高（`node --version`）。

```bash
npm install -g @pricening/pi-web@latest --registry=https://registry.npmjs.org/
pi-web
```

或不装全局命令：

```bash
npx @pricening/pi-web@latest --registry=https://registry.npmjs.org/
```

服务就绪后会尝试打开浏览器；没有打开就访问 [http://127.0.0.1:30141](http://127.0.0.1:30141)。默认只监听 `127.0.0.1`。

还没配模型时，打开 **模型（Models）** 面板登录或填 API Key。

更新：先 `Ctrl+C` 停掉再装同一条命令。卸载：`npm uninstall -g @pricening/pi-web`。

生产机请锁精确版本（Windows 用 `PI_WEB_PIN`，Linux 的 systemd 本来就不会 `npm update`）。不要每台机器都追 `@latest`，见 [docs/FORK.md §7](./docs/FORK.md)。

## 配置

命令行参数优先于对应环境变量。`--no-open` 或 `PI_WEB_NO_OPEN=1` 不自动开浏览器。`pi-web --help` 打印选项并退出。

| 参数或环境变量 | 用途 | 默认 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动选项并退出 | — |
| `--port` / `-p` / `PORT` | 端口 | `30141` |
| `--hostname` / `-H` / `PI_WEB_HOSTNAME` | 监听地址 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_SKIP_VERSION_CHECK=1` | 关闭更新检查 | 未设置 |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的主机名，逗号分隔，精确匹配 | 未设置 |
| `PI_WEB_PASSWORD` | 浏览器密码登录；API 可用用户名 `pi` 的 Basic Auth | 不启用 |
| `PI_WEB_IDLE_TIMEOUT_MS` | 会话空闲超时（毫秒）；`0` 关闭 | `600000`（10 分钟） |

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### 远程访问

绑到非回环地址等于把可执行高权限操作的 agent 暴露出去。可信局域网请设足够长的随机密码：

```bash
PI_WEB_PASSWORD='足够长的随机密码' pi-web --hostname 0.0.0.0
```

密码认证不加密连接。不要用明文 HTTP 把 Pi Web 暴露到公网。

## 注意事项

- **智能体数据**：默认读 `~/.pi/agent`，会话在 `sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`。可用 `PI_CODING_AGENT_DIR` 改目录。
- **与本地 pi 共享**：模型、设置、凭据仍是 pi 的文件。本 fork 不再写属于自己的状态文件——置顶、归档、顺序都在上游的 `~/.pi/agent/pi-web-session-state.json` 里。原先放在 `~/.pi/agent/pi-web/` 下的那两个文件会被导入一次，然后改名成 `*.migrated-<utc>`，不删除。不改 `settings.json` / `auth.json` / 会话 jsonl 内容。
- **文件访问**仅限已知的项目 / 会话根目录，不是通用文件浏览器。
- **Git worktree**：见 [Pi Web 里的 Worktree](./docs/worktrees.zh-CN.md)。

## 开发

```bash
npm install
npm run dev
```

开发服务器：[http://127.0.0.1:30141](http://127.0.0.1:30141)。检查：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

日常开发**不要**跑 `next build` / `npm run build`（会污染 `.next/`，干扰 `npm run dev`）。构建放在 CI。

补丁纪律、版本与上游同步：[docs/FORK.md](./docs/FORK.md)。架构地图：[AGENTS.md](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)，与上游相同。
