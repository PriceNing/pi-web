# @pricening/pi-web

[简体中文](./README.zh-CN.md)

A **personal fork** of [agegr/pi-web](https://github.com/agegr/pi-web), the local browser UI for the [pi coding agent](https://github.com/earendil-works/pi).

## Why this fork exists

Upstream Pi Web is excellent and very active. This repository exists so I can add **advanced features I actually use** without waiting for (or expecting) them to land upstream — historically, session-organization PRs such as pin/favorite have been closed in favor of a planned redesign.

The fork is meant to **keep following upstream**, not to replace it:

| | |
|---|---|
| Upstream | [agegr/pi-web](https://github.com/agegr/pi-web) — fetch only |
| This repo | [PriceNing/pi-web](https://github.com/PriceNing/pi-web) |
| npm package | **`@pricening/pi-web`** (not `@agegr/pi-web`) |
| Upstream baseline | `package.json` → `forkedFrom` |

Install the official package if you want an unmodified Pi Web. Install this package only if you want the extra features below.

How we stay in sync, version, and publish: **[docs/FORK.md](./docs/FORK.md)** (the maintenance spec).

## Extra features (this fork)

- **Server-side pins** for projects and sessions. Pins live under `~/.pi/agent/pi-web/pins.json`, so every browser hitting the same server (PC / phone / tablet) sees the same order. Pinned items sort first; within a group they stay ordered by recent activity.
- **Project archive**. The sidebar “project” row is only a grouping of sessions, not a first-class pi object. Archive hides that group from the sidebar without moving session files. Manage / unarchive / bulk-delete those chats from **Settings → Archives**. Deleting sessions never deletes the code folder on disk.

Everything else is upstream Pi Web: same `~/.pi/agent` sharing with the local pi CLI, same session files, same models/auth/skills.

## Quick start

Requires Node.js 22.19.0 or newer (`node --version`).

```bash
npm install -g @pricening/pi-web@latest --registry=https://registry.npmjs.org/
pi-web
```

Or without a global install:

```bash
npx @pricening/pi-web@latest --registry=https://registry.npmjs.org/
```

The CLI opens a browser when the server is ready. If it does not, open [http://127.0.0.1:30141](http://127.0.0.1:30141). By default Pi Web listens only on `127.0.0.1`.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key.

To update, stop the running process (`Ctrl+C`) and install the same package again. To uninstall: `npm uninstall -g @pricening/pi-web`.

Production machines should pin an exact version (`PI_WEB_PIN` on Windows, or a systemd unit that does not run `npm update`). Do not blindly follow `@latest` on every box; see [docs/FORK.md §7](./docs/FORK.md).

## Configuration

Command-line options override the matching environment variables. `--no-open` or `PI_WEB_NO_OPEN=1` skips opening a browser. `pi-web --help` prints startup options and exits.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_WEB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Disable Pi Web update checks | Unset |
| `PI_WEB_ALLOWED_HOSTS` | Extra exact proxy/custom hostnames, comma-separated | Unset |
| `PI_WEB_PASSWORD` | Browser password login; API clients may use Basic Auth as user `pi` | Auth disabled |
| `PI_WEB_IDLE_TIMEOUT_MS` | Session idle timeout in ms; `0` disables idle shutdown | `600000` (10 min) |

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### Remote access

Binding to a non-loopback address exposes an agent that can run high-privilege actions. On a trusted LAN, set a long random password:

```bash
PI_WEB_PASSWORD='a-long-random-password' pi-web --hostname 0.0.0.0
```

Password auth does not encrypt the connection. Do not put Pi Web on the public internet over plain HTTP.

## Notes

- **Agent data**: reads `~/.pi/agent` by default (session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`). Override with `PI_CODING_AGENT_DIR`.
- **Shared with local pi**: models, settings, and credentials are pi’s files. This fork only writes extra state under `~/.pi/agent/pi-web/` (`pins.json`, `archives.json`). It does not rewrite `settings.json` / `auth.json` / session jsonl content.
- **File access** is limited to known project/session roots; it is not a general filesystem browser.
- **Git worktrees**: [Worktrees in Pi Web](./docs/worktrees.md).

## Development

```bash
npm install
npm run dev
```

Dev server: [http://127.0.0.1:30141](http://127.0.0.1:30141). Checks:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Do **not** run `next build` / `npm run build` during normal development — it pollutes `.next/` and can break `npm run dev`. Builds belong in CI.

Patch discipline, versioning, and upstream sync: [docs/FORK.md](./docs/FORK.md). Architecture map: [AGENTS.md](./AGENTS.md).

## License

[MIT](./LICENSE), same as upstream.
