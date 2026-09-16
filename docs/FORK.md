# Pi Web Fork 维护规范

本文件规定 `PriceNing/pi-web` 这个 fork 的**改动纪律、版本规则、发布与同步流程**。
目的只有一个：**长期跟得上上游，同时不丢掉我们自己的功能。**

---

## 1. 仓库关系

| | |
|---|---|
| 上游 | https://github.com/agegr/pi-web （`upstream` remote，只 fetch，禁止 push） |
| 本仓库 | https://github.com/PriceNing/pi-web （`origin`，我们的发行分支） |
| 发布包名 | `@pricening/pi-web`（**不是** `@agegr/pi-web`，避免任何人 `npm i` 时把补丁覆盖掉） |
| 上游基线 | 记录在 `package.json` 的 `forkedFrom`（name / version / commit / url） |

分支模型（刻意简单，只有 main）：

```
upstream/main ──merge──▶ origin/main  =  上游 + 本 fork 的全部补丁
```

- **同步用 `merge`，不用 `rebase`**。main 是已发布分支，改写历史会让生产机装到的版本和 git 历史对不上。
- 想试验性做功能时开 `feat/*` 分支，验证完再合回 main；main 上永远只有一个 `[pin-fork]` 补丁集。

---

## 2. 当前本地改动清单

### 2.1 服务端置顶（pin 项目 / 会话）

**动机**：项目和会话一多就找不到。且必须**服务端存储**——localStorage 是每个浏览器一份，PC / 手机 / Pad 三端会各自为政。

**新增文件（永不与上游冲突）**

| 文件 | 职责 |
|---|---|
| `lib/pin-order.ts` | 无依赖纯逻辑：payload 解析、`comparePinnedFirst`、key 校验、prune。浏览器与 Node 共用 |
| `lib/pin-store.ts` | 服务端存储：读写 `~/.pi/agent/pi-web/pins.json`，`proper-lockfile` 加锁 + 原子写 + 指纹缓存 |
| `app/api/pins/route.ts` | `GET` 读、`POST` 切换（鉴权由 `proxy.ts` 的 `/api/:path*` matcher 自动覆盖） |
| `hooks/usePins.ts` | 客户端状态：挂载时拉一次，之后采纳轮询捎带的 payload；乐观更新 + 失败回滚 |
| `components/PinButton.tsx` | 图钉按钮，`action` / `inline` 两种形态 |
| `scripts/next-version.mjs` | 版本号规则的唯一实现（见 §4） |
| `scripts/set-forked-from.mjs` | 维护 `package.json.forkedFrom`，记录对应哪个上游构建（见 §5.2） |
| `scripts/deploy-pi-web.mjs` | 生产机 status / install / rollback，强制精确版本 + 显式 registry（见 §7.1） |
| `scripts/pi-web-start.bat` | Windows 常驻启动器（含 `PI_WEB_PIN` 锁版本），由计划任务调用（见 §7.2） |
| `lib/pin-*.test.mjs`、`scripts/*.test.mjs` | 43 个测试 |

**对上游文件的改动（全部带 `// [pin-fork]` 标记）**

| 文件 | 上游改动频率 | 我们改了什么 |
|---|---|---|
| `components/SessionSidebar.tsx` | 高（48 次/90 天） | 约 45 行：import、`usePins()`、轮询采纳 pins、两处排序传参、会话行与项目行各一个 `<PinButton>`、`SessionItem` 两个新 prop |
| `lib/session-family.ts` | 极低（1 次） | 可选参数 `pinnedSessionIds` + 排序改为 pinned 优先 |
| `lib/project-groups.ts` | 极低（1 次） | 可选参数 `pinnedProjectKeys` + 排序改为 pinned 优先 |
| `app/api/agent/running/route.ts` | 低（3 次） | 响应里捎带 `pins` |
| `app/api/sessions/route.ts` | 低（5 次） | 列表加载时 `prunePins()` 清理孤儿 |
| `lib/app-update.ts` / `app/api/app-update/route.ts` | 极低 | 更新检查指向我们的包（见 §2.2） |
| `components/SessionSidebar.test.mjs`、`lib/app-update.test.mjs` | 中 | 上游两条断言按新签名/新 URL 更新 |

**行为规定**

- 排序：**pinned 组在前，组内一律按最近活跃**（不按 pin 时间）。
- 项目 pin 的 key 用服务端算出的 `projectKey`（`workspaceKeyOf()`），**不用路径字符串**——Windows 大小写、分隔符、UNC 已由上游归一化。
- 会话 pin 的 key 是 `session.id`：改名保留、**fork 不继承**、删除即清理。
- 项目下已无会话时，其 pin 自动清理（与上游"项目列表只含有会话的目录"的立场一致）。
- 图钉**不受 hover 门控**（触屏没有 hover），视觉规格与相邻的重命名/删除按钮完全一致；已置顶时常亮作为标记。
- 跨设备同步**不开新连接**：蹭侧栏已有的 2.5 秒 `GET /api/agent/running` 轮询，所以任何一端 pin，其他端 ≤2.5 秒收敛。

### 2.2 更新检查重定向

上游的 `app-update` 检查写死在 `@agegr/pi-web`。若不改，界面会提示"升级到官方最新版"，**用户一点就把补丁升没了**。现在指向 `@pricening/pi-web` 与 `PriceNing/pi-web` 的 Release 页。

---

## 3. 补丁纪律（加新功能时必须遵守）

上游非常活跃（近 90 天 **568 次提交**，约 6 次/天），所以"改动放哪里"直接决定以后同步是 5 分钟还是 5 小时。

1. **新逻辑一律开新文件**，绝不往大组件里塞。
2. **优先改冷文件**。近 90 天提交次数（越少越安全）：
   `ChatWindow.tsx` 86、`AppShell.tsx` 74、`lib/rpc-manager.ts` 72、`useAgentSession.ts` 67、`lib/i18n/messages/zh-CN.ts` 58、`SessionSidebar.tsx` 48、`lib/session-reader.ts` 31、`lib/types.ts` 20 …
   而 `lib/session-family.ts`、`lib/project-groups.ts`、`lib/app-update.ts` 只有 1 次。
3. **不要往 `lib/i18n/messages/*.ts` 加 key**（最热的文件之一，且有 key 集对齐测试）。新功能文案自带在组件里，用 `useI18n()` 的 `locale` 选。
4. **不要往 `lib/types.ts` 加字段**。需要给 `SessionInfo` 附加信息时，在 API 层做结构类型转换或另建类型。
5. **热文件里只允许"接线"级改动**，每处加 `// [pin-fork]`（或对应功能的 `[xxx-fork]`）标记。
6. **每个补丁集都要有锚点测试**。参考 `lib/pin-fork-anchors.test.mjs`：断言接缝仍然存在。这是防"**上游重构后功能静默失效、但测试全绿**"的唯一有效手段。
7. 上游文件的行为被我们改到时，**同步更新上游自带的那条断言**（我们已经改过 2 处），别留着红。

---

## 4. 版本号与 tag 规则

**必须使用纯 `x.y.z`**，原因：上游的 `lib/app-update.ts` 用 `/^(\d+)\.(\d+)\.(\d+)$/` 解析，任何预发布后缀（如 `0.9.1-pin.1`）都会让"有更新"提示**永久失效**。

规则（唯一实现见 `scripts/next-version.mjs`）：

```
next = max(上游版本, 已发布最高版本 + 0.0.1)
```

- 刚同步完上游时，`next` 就等于上游版本号 → `npm info @pricening/pi-web version` 直接能看出对应哪个上游版本。
- 同一上游版本下要单独发我们的修复，就往上走 patch（0.9.1 → 0.9.2），**永不重复、永不倒退**。
- 真实对应关系由 git 记录：`forkedFrom.commit` + merge 历史 + tag `v<version>`。

Tag 约定：

| tag | 含义 |
|---|---|
| `v0.9.2` | 我们的发布（CI 自动打，并建 GitHub Release） |
| `upstream/v0.9.2` | （可选）为上游 tag 打的本地镜像 tag，便于 diff |

---

## 5. 发布流程

### 5.1 发布通道：OIDC（当前状态 —— 仓库内**没有任何 secret**）

已实测确认（v0.9.6）：在 `gh secret list` 为空的情况下，CI 仍成功发出
`+ @pricening/pi-web@0.9.6`，且走的是 `尝试 Trusted Publishing (OIDC)` 分支。
即：无 token、不会过期、附带 provenance 证明，也不受 npm「2027-01 起绕过 2FA 的
granular token 不得直接发布」影响 —— 我们本来就不走那条路。

> **为什么不在本地发（实测）**：`npm run build`（webpack 生产构建）在本机 Windows 上会 OOM ——
> 默认 4 GB 堆约 3.5 分钟崩一次；给到 `--max-old-space-size=8192` 与 `12288` 时，
> 约 14 分钟后仍因堆耗尽失败（`Ineffective mark-compacts near heap limit`）。
> 同一份代码在 ubuntu-latest 上约 2 分钟构建完成。
> **结论：构建与发布只在 CI 里做**，本地只跑 `npm run dev` 预览与 `npm test`。

信任关系配置（npm 包页面 → Settings → Trusted publishing；**建好不能改，只能删了重建**）：

| 字段 | 值 |
|---|---|
| Organization or user | `PriceNing` |
| Repository | `pi-web` |
| Branch | `main` |
| Workflow filename | `sync-upstream.yml` ← **只填文件名，大小写敏感，不带路径** |
| Environment name | 留空 |
| **Allow npm publish** | ☑️ 必须勾（不勾则只允许 `npm stage publish`） |

#### 历史：当初如何破冰（重建时参考，已完成）

Trusted Publishing 要在**包页面**上配置，而包页面只有发布过一次之后才存在，所以上面这条路
需要一次性破冰：

1. 建一个**勾选 Bypass 2FA** 的 granular token（普通 token 会被账号 2FA 策略以 `403` 拒发）
2. `gh secret set NPM_TOKEN` → 手动触发 workflow 发首版
3. 去包页面配好 Trusted Publishing → `gh secret delete NPM_TOKEN` → 在 npm 页面 revoke 该 token
4. 再触发一次发版，确认日志是 OIDC 分支且没有走兜底 —— 到这一步才算真正拆掉梯子

> 两个花了很久才定位的坑：
> - **不勾 bypass 的 token 发不了**：`403 ... bypass 2fa enabled is required to publish packages`；
>   同理 web login 的 CLI token 也改不了 dist-tag（实测 403）。副作用：stale 的 `next: 0.9.1`
>   tag 现在删不掉，只能忽略（没人会装 `@next`，且 0.9.1 也是合法构建）。
> - **Node 22 自带的 npm 10.x 没有 OIDC 代码路径**，`npm publish --provenance` 只会报 `ENEEDAUTH`，
>   现象和「trusted publisher 没配对」完全一样。workflow 已固定先 `npm install -g npm@11` 并打印版本。

### 5.2 日常：CI 自动同步 + 发版（`.github/workflows/sync-upstream.yml`）

每天 14:30（北京时间）+ 可手动触发（`force_publish` 可跳过「无新东西」判断）：

```
fetch upstream → merge → 写 forkedFrom → npm ci → lint → tsc → npm test（含锚点测试）
→ 算版本 → 升级 npm → next build → npm publish（OIDC）→ npm pack → 打 tag → Release（附 tarball）→ push main
```

要点：

- 任何一步失败：**不推送、不发版**（已实战验证：某次发布成功但 Release 步骤失败时，
  tag 与 main 都没被动过，失败是干净的）。
- **`forkedFrom` 自动维护**：上游会提交代码而不 bump 自己的版本（HEAD 一直在动而 version
  停在 0.9.1），所以「对应哪个上游构建」只能靠这个字段记录，手写一天就过期。
  由 `scripts/set-forked-from.mjs` 负责。
- **不会重复发空版**：只有「上游有新提交」或「仓库版本 ≠ 已发布版本」才发。这里曾写错成
  比较 `next` 与 `published`，而版本规则保证 `next` 永远更大，会导致每天发一个内容相同的空版本。
- **OIDC 优先，失败不静默降级**：兜底分支只在 `NPM_TOKEN` 存在时才生效；现在没有 secret，
  所以 OIDC 一失败就直接变红，不会默默发出一个没有 provenance 的包而无人察觉。

### 5.3 灰度：放在安装层，不放在 registry tag 层

**不要用 `--tag next` 做灰度**，两条实测理由：

1. 首次发布时即使 `npm publish --tag next`，npm **仍会创建 `latest`** —— `next` 通道拦不住任何人。
2. 事后把 `latest` 挪回去需要"能改 dist-tag 的凭据"：普通 token 被 2FA 策略挡掉（实测 403），
   而 Trusted Publishing (OIDC) **只能发布、不能改 tag**。也就是说这条收口路径不可持续。

所以灰度改由**安装层**保证，效果等价且不需要任何额外凭据：

```powershell
# ① 只升 canary 一台（显式版本号）
npm i -g @pricening/pi-web@0.9.2 --registry=https://registry.npmjs.org/
# ② 用一天，确认没问题
# ③ 再改部署脚本里的 PINNED_VERSION，其余机器才会升
```

关键前提：**生产机永远按精确版本安装**（见 §7）。这样 registry 上有没有 `latest`
都不重要 —— 没有任何机器会自动跟进，坏版本最多影响 canary 一台。

---

## 6. 上游同步

### 6.1 CI 自动成功时

什么都不用做。

### 6.2 CI 报冲突时（本地手工）

```bash
git fetch upstream --tags
git merge upstream/main
# 解决冲突：优先保留上游实现，再把 [xxx-fork] 接线重新插回去
npm run lint && npx tsc --noEmit && npm test
git push origin main
```

冲突处理提示：

- `SessionSidebar.tsx` 是唯一高频冲突点。解决后**必须重跑 `npm test`**，锚点测试会告诉你哪根线掉了。
- 上游若把 `listSessionFamilies` / `getRecentProjects` 改名或删掉：不要保留旧函数名，把 pin 参数搬到新函数上，并同步改 `lib/pin-fork-anchors.test.mjs`。
- 上游若自己实现了 pin/收藏（维护者多次提到"要重新设计会话组织"）：**立即停用我们的补丁**，回归纯镜像，把 `package.json` 的改动缩到只剩包名与更新检查。

---

## 7. 生产机部署与回滚

### 7.1 一次性安装 / 升级 / 回滚

```powershell
# 推荐用本仓库的助手：它会强制精确版本、显式 registry，并提醒官方包冲突
node scripts/deploy-pi-web.mjs status            # 本机版本 + 最新可装版本
node scripts/deploy-pi-web.mjs install 0.9.5     # 安装/升级（canary 一台）
node scripts/deploy-pi-web.mjs rollback 0.9.4    # 回滚（同样是精确版本）

# 它等价于：
npm i -g @pricening/pi-web@0.9.5 --registry=https://registry.npmjs.org/

# 拉不到 npm 时，用 GitHub Release 的 tarball 兜底
npm i -g .\pricening-pi-web-0.9.5.tgz
```

从官方版切换过来的正确顺序（**先卸后装**）：

```bat
npm uninstall -g @agegr/pi-web
npm i -g @pricening/pi-web@<版本> --registry=https://registry.npmjs.org/
```

为什么不能先装后卸（实测）：两个包的全局 bin 垫片**同名**（`%APPDATA%\npm\pi-web.cmd/.ps1`），
官方包在位时 `npm i -g @pricening/pi-web` 会**直接失败**：

```
npm error EEXIST: File already exists  →  Remove the existing file and try again,
                                          or run npm with --force to overwrite files recklessly.
```

而且失败后会留下一个半成品安装（`npm ls -g` 里显示 `@pricening/pi-web@` 且版本为空），
必须先 `npm uninstall -g @pricening/pi-web` 再重来。所以：

- **正在运行的机器**（不能先卸官方，否则服务断）：`npm i -g @pricening/pi-web@<版本> --force` 装 fork
  → 切换启动器 → 停旧起新 → **确认 fork 已在服务后**再卸官方包（参考一次性脚本 `pi-web-cutover.ps1` 的顺序）
- **能停机的机器**：老实按上面的顺序先卸后装，不用 `--force`

另：卸载其中一个包时，npm 会把**共享的 `pi-web` 命令垫片一并删掉**（即使另一个包还在）。
`scripts/pi-web-start.bat` 用绝对路径 `node ...\bin\pi-web.js` 启动，不依赖那个垫片，所以服务不受影响；
但手动敲 `pi-web` 会失效。

> **实测修复方法（真实切换时踩过）**：服务在跑的时候，`npm i -g @pricening/pi-web --force` 会
> 报 `EBUSY: resource busy or locked, rename ...\@pricening\pi-web -> ...\.pi-web-xxxx`（Windows 下
> 运行中的包目录改不了）。正确的补刀是**不重装、只重建链接**，无需停机也不会掉会话：
> ```powershell
> npm rebuild -g @pricening/pi-web     # 恢复 pi-web / pi-web.cmd / pi-web.ps1 三个垫片
> ```

### 7.2 常驻启动：`scripts/pi-web-start.bat`

本仓库的 `scripts/pi-web-start.bat` 是**规范副本**，部署到跑 pi-web 的机器上并让计划任务指向它：

```bat
copy /Y scripts\pi-web-start.bat "%USERPROFILE%\Desktop\pi-web-start.bat"
schtasks /Create /TN pi-web-server /TR "\"%USERPROFILE%\Desktop\pi-web-start.bat\"" /SC ONSTART /RU <用户> /RP /RL HIGHEST /F
schtasks /Run /TN pi-web-server
```

它做的事：定位 node/npm/全局前缀 → 缺包就装 → 有新版就升 → 启动 → 写日志。
排错用 `pi-web-start.bat --check`，会打印解析到的 node / npm / prefix / registry / 入口路径 / 已装版本。

可用环境变量：

| 变量 | 作用 |
|---|---|
| `PI_WEB_HOSTNAME` / `PI_WEB_PORT` | 监听地址（默认 `0.0.0.0` / `30141`） |
| `PI_WEB_LOG` | 日志文件（默认 `%LOCALAPPDATA%\pi-web\logs\pi-web-start.log`） |
| `PI_WEB_PASSWORD` | 开启登录鉴权；`0.0.0.0` 若能被可信网络之外访问就必须设 |
| **`PI_WEB_PIN`** | 锁定精确版本并**跳过自动升级** |

> ⚠️ **生产机必须设 `PI_WEB_PIN`**。这个 launcher 每次开机都会跑一遍，而 fork 的 `@latest`
> 是 CI 自动发布的 —— 不设锁就等于把「上游提交 → CI 构建 → 自动发 npm → 所有机器下次开机
> 自动吸收」连成无人值守的一条链。CI 门禁能挡住编译/测试失败，挡不住"全绿但行为不对"。
> 例外：canary 那台不设 `PI_WEB_PIN`，让它自动吃 `@latest`，正是它的用途。

### 7.3 Windows 上踩过的坑（都已实测）

| 坑 | 现象 | 结论 |
|---|---|---|
| `Start-Process pi-web` | `%1 is not a valid Win32 application` | npm 的全局垫片是 `pi-web.ps1`，不能当可执行文件启动。必须 `node <prefix>\node_modules\@pricening\pi-web\bin\pi-web.js`（launcher 就是这么做的） |
| 用 SSH 起分离进程 | `Start-Process` / `Win32_Process.Create` 起的进程随 SSH 会话回收而死 | 常驻只能靠计划任务（或服务），不要指望远程会话里后台拉起 |
| 只读镜像 | `npm login` / `npm publish` 打到镜像报 409 `user registration disabled`；新 scoped 包安装 404 | `~/.npmrc` 的 `registry` 是全局的，launcher 与文档里的每条 npm 命令都显式带 `--registry` |
| 防火墙 | 30141 入站从别的机器不通 | 远程验证要在目标机本机做（`Invoke-WebRequest http://127.0.0.1:30141/...`） |
| 本地构建 | `npm run build` 在 Windows 上 OOM（见 §5.1） | 构建/发布只在 CI；本机只跑 dev 预览和 `npm test` |

### 7.4 切换后的自检

```powershell
# 服务是否活着、pin 接口是否存在（旧版官方版没有这个路由，可用来确认切换成功）
(Invoke-WebRequest http://127.0.0.1:30141/api/pins -UseBasicParsing).Content
# 期望：{"sessions":[],"projects":[]}
```

规定：

- **精确版本号安装**，禁止 `^` / `latest` 落到运维脚本里；版本记录在部署仓库里，让"谁升到了哪"可审计。
  `deploy-pi-web.mjs install` 会直接拒收非 `x.y.z` 的参数，launcher 用 `PI_WEB_PIN` 表达同一约束。
- 同一台机器**只保留一个** pi-web 包（原因见 §7.1）。
- 升级前先停服务：`pi-web` 会 idle 回收 AgentSession，但 `node-pty` 终端会话会断。
- 数据安全：卸载/升级**不会动 `~/.pi/agent/`**，会话、配置以及 `pi-web/pins.json`（置顶记录）都完整保留，本地 pi CLI 不受影响。
- `PI_WEB_SKIP_VERSION_CHECK=1` 现在**不再是必须**（更新检查已指向我们自己的包），但如果你不希望界面出现任何升级提示，它仍是有效的开关。

---

## 8. 与 local pi 共享状态的边界（红线）

pi-web 的优秀设计是**与本地 pi 共享 `~/.pi/agent`**。我们绝不破坏它：

| 允许 | 禁止 |
|---|---|
| 在 `getAgentDir()/pi-web/` 子目录下写自有状态（先例：上游自己的 `pi-web-session-index.json`） | 写 `settings.json`、`auth.json`、`models.json`（这些归 pi CLI 所有，两边写会互相覆盖） |
| 只读 `sessions/` 下的会话 | 修改任何会话 `.jsonl` 内容或元数据 |
| 用 `getAgentDir()` 取路径，从而跟随 `PI_CODING_AGENT_DIR` 一起迁移 | 写死 `~/.pi/agent` |
| 附加纯展示性元数据（pin） | 伪造 `modified` 等真实时间字段来骗排序 |

pin 数据落在 `~/.pi/agent/pi-web/pins.json`：备份/迁移 agentDir 时自动跟着走；pi CLI 不枚举未知文件，所以对它完全不可见。

---

## 9. npm 认证政策（当前状态）

| 场景 | 用什么 | 备注 |
|---|---|---|
| CI 发版 | **Trusted Publishing (OIDC)** —— 唯一通道 | 无 secret、无过期、带 provenance。已在 v0.9.6 实测（仓库 secrets 为空仍发布成功） |
| 本机应急发布 | **web login**：`npm login --registry=https://registry.npmjs.org/ --auth-type=web` | 2FA 走交互（通行密钥），不绕过。注意本机 `~/.npmrc` 若指向只读镜像，必须显式带 `--registry` |
| CI 兜底 token | **当前不存在**（已删除并 revoke） | 重建见 §5.1「历史：如何破冰」 |

三条实测出来的硬约束（别凭直觉配置）：

1. **账号开启"发布需要 2FA"后，普通 granular token 发不了**（`403 ... bypass 2fa enabled is
   required to publish packages`）。能发的只有勾了 Bypass 2FA 的 token —— 而 npm 已公告
   **2027-01 起这类 token 不再允许直接发布**。所以"建个普通 token 当兜底"这个直觉是错的，
   兜底要么用 bypass token（临时、用完即撤），要么没有。
2. **dist-tag 操作同样要 2FA 级凭据**：web login 的 CLI token 执行 `npm dist-tag rm` 实测 403。
   因此灰度不能设计成"CI 发 `next`、人工提升 `latest`"（提升这步没人能做），只能放在安装层（§5.3）。
3. **Node 22 自带 npm 10.x 不支持 OIDC**，`npm publish --provenance` 报 `ENEEDAUTH`，与"没配好
   trusted publisher"现象相同。CI 里必须先 `npm install -g npm@11`。

---

## 10. 已知取舍

| 未做 | 原因 |
|---|---|
| 置顶分区 / 可折叠 "Pinned" 标题 | 会话列表是虚拟化的（行高写死 54px），插 section header 要在热文件改高度与窗口计算，冲突面暴涨。当前实现是"直接排到最前" |
| 打开页面默认选中"置顶的项目" | 首屏项目自动选择在 effect 里，改它要动依赖数组；目前默认项目仍按最近活跃 |
| 归档（archive） | 上游 #406 提过，本 fork 暂未实现 |
| 删除项目路径 / 隐藏项目 | 项目列表由会话派生，没有独立注册表；上游维护者明确认为不需要（#543） |
| 多服务器间同步 pin | 我们的 pi-web 只有一台服务器，服务端存储已满足跨设备。若将来多实例，把 `~/.pi/agent` 放共享存储即可 |
| 清掉 npm 上 stale 的 `next: 0.9.1` tag | 需要 2FA 级凭据，而 bypass token 已 revoke、CLI 又只能吃 TOTP（我们用的是通行密钥）。影响为零，见 §9 第 2 条 |
| 本地 Windows 构建 | `npm run build` 会 OOM（§5.1）。构建与发布只在 CI 做，本地只跑 dev 与测试 |

---

## 11. 每次同步后的最小验证清单

```bash
npm run lint
npx tsc --noEmit
npm test          # 必须包含 lib/pin-fork-anchors.test.mjs 全绿
```

**不要在本地跑 `npm run build`**（见 §5.1 的 OOM 实测）；构建属于 CI。

手工抽查（2 分钟）：

1. 侧栏项目下拉：图钉出现、点击置顶、顺序变化、刷新后仍在
2. 会话行：hover 时图钉与重命名/删除同框；已置顶行常亮
3. 手机/Pad 打开同一实例：一端 pin，另一端 ≤2.5 秒自动置顶
4. `~/.pi/agent/pi-web/pins.json` 内容符合预期；删掉一个已 pin 会话后其记录消失
5. `node scripts/deploy-pi-web.mjs status` 能看到新版本；`node -p "require('./package.json').forkedFrom.commit"` 已指向上游最新 commit；CI 发布日志出现 `✅ OIDC 发布成功`（不是兜底分支）
