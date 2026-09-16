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
| `lib/pin-*.test.mjs`、`scripts/next-version.test.mjs` | 31 个测试 |

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

### 5.1 首版（由 CI 发，**不要**在 Windows 本地发）

> **实测环境限制**：`npm run build`（webpack 生产构建）在本机 Windows 上会 OOM ——
> 默认 4 GB 堆约 3.5 分钟崩一次；给到 `--max-old-space-size=8192` 与 `12288` 时，
> 分别在约 14 分钟后仍因堆耗尽失败（`Ineffective mark-compacts near heap limit`）。
> 同一份代码在 ubuntu-latest 上约 2 分钟构建完成（上游 `ci.yml` 的 e2e job 就是证据）。
> **结论：构建与发布只在 CI 里做。** 本地只做 `npm run dev` 预览与 `npm test`。

npm 的 Trusted Publishing 需要在 npmjs.com 的**包页面**上配置，而包页面只有发布过之后才存在，
所以**第一次发布用 `NPM_TOKEN`**（一次性），之后切换到 OIDC：

1. 在 npm 建 granular token：权限 `Read and write (publish and stage)`、scope 限定 `@pricening`、
   **不勾 Bypass 2FA**、**不填 IP 白名单**（Actions 出口 IP 会变）。
2. `gh secret set NPM_TOKEN --repo PriceNing/pi-web`（交互粘贴，别让 token 进聊天记录）。
3. 手动触发 `Sync upstream & publish fork` workflow（`force_publish` 可选）。
4. 首版上线后，去包页面配好 Trusted Publishing，然后**删掉 `NPM_TOKEN` secret**，
   CI 会自动走 OIDC 分支（见 `sync-upstream.yml` 的发布步骤）。

### 5.2 之后（CI 自动，`.github/workflows/sync-upstream.yml`）

每天 14:30（北京时间）+ 可手动触发：

```
fetch upstream → merge → npm ci → lint → tsc → npm test（含锚点测试）
→ 算版本 → next build → npm publish --tag next → 打 tag → GitHub Release（附 tarball）→ push main
```

任何一步失败：**不推送、不发版**。合并冲突会在 CI 里明确列出可能涉及的文件。

### 5.3 灰度与提升

CI 只发到 **`next`** tag。人工确认后才提正式：

```bash
npm dist-tag add @pricening/pi-web@0.9.2 latest
```

生产机 `npm update` 只会看到 `latest`，所以有天然的缓冲。

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

```powershell
# 安装/升级（必须显式指定 registry：国内镜像对新 scoped 包可能尚未回源）
npm i -g @pricening/pi-web@0.9.2 --registry=https://registry.npmjs.org/

# 拉不到 npm 时，用 GitHub Release 的 tarball 兜底
npm i -g .\pricening-pi-web-0.9.2.tgz

# 回滚
npm i -g @pricening/pi-web@0.9.1 --registry=https://registry.npmjs.org/
```

规定：

- **精确版本号安装**，禁止 `^` / `latest` 落到运维脚本里；版本记录在部署仓库里，让"谁升到了哪"可审计。
- 同一台机器**不要同时安装** `@agegr/pi-web` 和 `@pricening/pi-web`：两个包的 `bin` 都叫 `pi-web`，后装的会覆盖前者。
- 升级前先停服务，`pi-web` 会 idle 回收 AgentSession，但 `node-pty` 终端会话会断。
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

## 9. npm 认证政策（会过期的部分）

- 本地发布：**web login**（`npm login --registry=https://registry.npmjs.org/ --auth-type=web`），2FA 正常交互，不绕过。
- CI 首选：**Trusted Publishing (OIDC)**。在 npm 包页面绑定 GitHub `PriceNing/pi-web` + workflow 文件 + branch，CI 里 `npm publish --provenance`，**无需 secret、永不过期**。
- CI 兜底：`NPM_TOKEN` secret（granular token，权限 `publish and stage`、scope 限定 `@pricening`、**不要勾 Bypass 2FA**、**不要填 IP 白名单**）。
  ⚠️ npm 官方公告：**2027 年 1 月起绕过 2FA 的 granular token 不再允许直接发布**。所以 token 只是过渡，OIDC 是终态。

---

## 10. 已知取舍

| 未做 | 原因 |
|---|---|
| 置顶分区 / 可折叠 "Pinned" 标题 | 会话列表是虚拟化的（行高写死 54px），插 section header 要在热文件改高度与窗口计算，冲突面暴涨。当前实现是"直接排到最前" |
| 打开页面默认选中"置顶的项目" | 首屏项目自动选择在 effect 里，改它要动依赖数组；目前默认项目仍按最近活跃 |
| 归档（archive） | 上游 #406 提过，本 fork 暂未实现 |
| 删除项目路径 / 隐藏项目 | 项目列表由会话派生，没有独立注册表；上游维护者明确认为不需要（#543） |
| 多服务器间同步 pin | 我们的 pi-web 只有一台服务器，服务端存储已满足跨设备。若将来多实例，把 `~/.pi/agent` 放共享存储即可 |

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
