#!/usr/bin/env node
// [pin-fork] 生产机安装/回滚助手。
//
// 为什么需要它：官方 @agegr/pi-web 装在同一个全局前缀里会覆盖同名 bin，而且国内
// 镜像对新发布的 scoped 包可能还没回源。所以安装必须**显式 registry + 显式精确版本**。
// 灰度靠"先只升一台 canary、验证后再改其余机器的版本"实现（见 docs/FORK.md §5.3/§7）。
//
// 用法：
//   node scripts/deploy-pi-web.mjs status
//   node scripts/deploy-pi-web.mjs latest
//   node scripts/deploy-pi-web.mjs install 0.9.2
//   node scripts/deploy-pi-web.mjs rollback 0.9.1

import { spawnSync } from "node:child_process";

const PKG = "@pricening/pi-web";
const UPSTREAM_PKG = "@agegr/pi-web";
const REGISTRY = "https://registry.npmjs.org/";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function run(command, args, { capture = false } = {}) {
  const needsShell = process.platform === "win32"; // npm 的入口是 npm.cmd
  // shell:true 配 args 数组会触发 DEP0190（参数只拼接不转义）。本工具的参数
  // 全是常量，唯一的外部输入（版本号）在 install() 里已被 ^\d+\.\d+\.\d+$ 拦住，
  // 所以 Windows 下改为拼成单条命令字符串，语义相同且无警告。
  const invocation = needsShell
    ? [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ")
    : command;
  const result = spawnSync(invocation, needsShell ? null : args, {
    encoding: "utf8",
    shell: needsShell,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} 失败（exit ${result.status}）\n${detail}`);
  }
  return capture ? result.stdout.trim() : "";
}

function npm(args, options) {
  return run("npm", [...args, "--registry", REGISTRY], options);
}

function parseInstalled(json) {
  if (!json) return null;
  try {
    const data = JSON.parse(json);
    const entry = (data.dependencies ?? {})[PKG] ?? (data.dependencies ?? {})[PKG.split("/")[1]];
    return entry?.version ?? null;
  } catch {
    return null;
  }
}

function installedVersion() {
  try {
    return parseInstalled(npm(["ls", "-g", PKG, "--depth=0", "--json"], { capture: true }));
  } catch {
    return null;
  }
}

function registryVersion(field) {
  try {
    return npm(["view", PKG, field], { capture: true });
  } catch (error) {
    // 新包发布后 registry 各路由传播速度不一致，查询失败不代表没有版本。
    return `查询失败：${error.message.split("\n")[0]}`;
  }
}

function warnIfUpstreamInstalled() {
  let out = "";
  try {
    out = npm(["ls", "-g", UPSTREAM_PKG, "--depth=0", "--json"], { capture: true });
  } catch {
    return; // 没装，正好
  }
  if (/"version"/.test(out)) {
    console.warn(
      `⚠️  全局还装着官方 ${UPSTREAM_PKG}。两者的 bin 都叫 pi-web，后装的会覆盖前者。\n`
      + `    只保留一个：npm uninstall -g ${UPSTREAM_PKG}`,
    );
  }
}

function status() {
  console.log(`包名        : ${PKG}`);
  console.log(`registry    : ${REGISTRY}`);
  console.log(`本机已装版本: ${installedVersion() ?? "(未安装)"}`);
  console.log(`最新可装版本: ${registryVersion("version")}`);
  warnIfUpstreamInstalled();
}

function install(version) {
  if (!EXACT_VERSION.test(String(version ?? ""))) {
    console.error(`必须指定精确版本号（x.y.z），收到：${version ?? "(空)"}`);
    console.error("不要用 latest / ^ —— 灰度是靠锁版本实现的，见 docs/FORK.md §5.3");
    process.exit(1);
  }
  warnIfUpstreamInstalled();
  console.log(`→ npm i -g ${PKG}@${version} --registry=${REGISTRY}`);
  run("npm", ["i", "-g", `${PKG}@${version}`, "--registry", REGISTRY]);
  console.log("\n安装完成。重启服务前确认：");
  console.log("  1. 旧 pi-web 进程已停（node-pty 终端会话会断）");
  console.log("  2. 用 status 子命令核对版本");
  status();
}

const [command, argument] = process.argv.slice(2);

try {
  if (command === "status" || command === undefined) {
    status();
  } else if (command === "latest") {
    console.log(registryVersion("version"));
  } else if (command === "install" || command === "rollback") {
    install(argument);
  } else {
    console.error(`未知子命令：${command}`);
    console.error("用法：deploy-pi-web.mjs [status|latest|install <x.y.z>|rollback <x.y.z>]");
    process.exit(1);
  }
} catch (error) {
  console.error(`\n✖ ${error.message}`);
  process.exit(1);
}
