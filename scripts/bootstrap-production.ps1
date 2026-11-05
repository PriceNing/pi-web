# [pin-fork] 生产机一键接入：装 fork 包 + 部署启动器 + 建开机自启任务。
#
# 幂等：重复运行安全；已存在的启动器只会备份一次，不会覆盖备份。
# 默认不会杀正在跑的服务 —— 需要立刻切换时显式加 -RestartNow。
#
# 用法（在本仓库根目录，管理员 PowerShell）：
#   .\scripts\bootstrap-production.ps1 -Check            # 只体检，不改任何东西
#   .\scripts\bootstrap-production.ps1                   # 接入（用 @latest）
#   .\scripts\bootstrap-production.ps1 -Pin 0.9.6       # 接入并锁版本
#   .\scripts\bootstrap-production.ps1 -RestartNow      # 接入并立刻切换（会断当前 pi-web 会话）
#
# 注意：-RestartNow 会停掉 30141 上的服务。如果你就是通过 pi-web 在操作这台机器，
# 那等于自断 —— 那种情况请改用计划任务在进程外执行（见 docs/FORK.md §7.5）。

[CmdletBinding()]
param(
  [string]$Pin,                       # 锁定的精确版本；留空表示跟随 @latest
  [string]$LauncherPath,              # 启动器落盘位置；留空则自动探测/默认
  [string]$TaskName = "pi-web-server",
  [string]$Port = "30141",
  [switch]$Check,                     # 只读体检
  [switch]$RestartNow
)

$ErrorActionPreference = "Stop"
$pkg      = "@pricening/pi-web"
$official = "@agegr/pi-web"
$registry = "https://registry.npmjs.org/"
$launcherSrc = Join-Path $PSScriptRoot "pi-web-start.bat"

function Say($m)  { Write-Output $m }
function DoIt($m) { if (-not $Check) { Write-Output "→ $m" } else { Write-Output "[check] $m" } }

if (-not (Test-Path $launcherSrc)) { throw "找不到启动器源文件：$launcherSrc（请在仓库根目录运行本脚本）" }

# ---------- 1. 体检 ----------
$installed = npm ls -g --depth=0 2>$null | Out-String
$hasFork     = $installed -match [regex]::Escape($pkg) + '@\d'
$hasOfficial = $installed -match [regex]::Escape($official)
$forkVersion = if ($hasFork)     { ($installed | Select-String -Pattern ([regex]::Escape($pkg) + '@([\d.]+)')).Matches[0].Groups[1].Value } else { "(未安装)" }
$offVersion  = if ($hasOfficial) { ($installed | Select-String -Pattern ([regex]::Escape($official) + '@([\d.]+)')).Matches[0].Groups[1].Value } else { "(未安装)" }

$candidates = @(
  (Join-Path $env:USERPROFILE "pi-web-start.bat"),
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "pi-web-start.bat"),
  (Join-Path $env:PUBLIC "Desktop\pi-web-start.bat")
)
if (-not $LauncherPath) {
  # 必须用 @() 强制成数组：只匹到一个结果时 Where-Object 会返回裸字符串，
  # 而字符串的 [0] 是首字符（曾经算出过 "C"）。
  $existing = @($candidates | Where-Object { Test-Path $_ })
  $LauncherPath = if ($existing.Count -gt 0) { $existing[0] } else { $candidates[0] }
}
$launcherPointsTo = "(不存在)"
if (Test-Path $LauncherPath) {
  $content = Get-Content $LauncherPath -Raw
  if     ($content -match "@pricening") { $launcherPointsTo = "@pricening（fork）" }
  elseif ($content -match "@agegr")     { $launcherPointsTo = "@agegr（上游）" }
}

$task = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
$taskTarget = if ($task.Count) { ($task[0].Actions | Select-Object -First 1).Execute } else { "(无任务)" }

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$serving = "(30141 无监听)"
if ($listener) {
  $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)").CommandLine
  if     ($cl -match "@pricening") { $serving = "fork 在服务" }
  elseif ($cl -match "@agegr")     { $serving = "官方包在服务" }
  else                             { $serving = "有监听但来源未知" }
}
$pinNow = [Environment]::GetEnvironmentVariable("PI_WEB_PIN", "User")

Say ""
Say "=========== pi-web 生产机体检 ==========="
Say "  已装 fork      : $pkg @ $forkVersion"
Say "  已装官方包     : $official @ $offVersion"
Say "  启动器         : $LauncherPath  ->  $launcherPointsTo"
Say "  计划任务       : $TaskName  ->  $taskTarget"
Say "  当前服务       : $serving"
Say "  版本锁         : $(if ($pinNow) { $pinNow } else { '(未设置，跟随 @latest)' })"
Say "========================================="
Say ""

if ($Check) {
  $gaps = @()
  if (-not $hasFork)         { $gaps += "fork 包未安装" }
  if ($launcherPointsTo -notlike "*fork*") { $gaps += "启动器未指向 fork" }
  if ($task.Count -eq 0) { $gaps += "缺少开机自启任务" }
  if ($serving -ne "fork 在服务") { $gaps += "当前服务的不是 fork" }
  if ($gaps.Count) { Say "待处理： $($gaps -join '；')" } else { Say "一切正常，无需操作。" }
  return
}

# ---------- 2. 装 fork ----------
if (-not $hasFork -or $Pin -and $forkVersion -ne $Pin) {
  $spec = if ($Pin) { "$pkg@$Pin" } else { "$pkg@latest" }
  # 官方包在位时共享同名 bin 垫片，npm 会 EEXIST 直接失败，必须 --force（见 docs/FORK.md §7.1）
  if ($hasOfficial) {
    DoIt "npm i -g $spec --force（官方包在位，不用 --force 会 EEXIST 失败）"
    if (-not $Check) { npm i -g $spec --registry $registry --force }
  } else {
    DoIt "npm i -g $spec"
    if (-not $Check) { npm i -g $spec --registry $registry }
  }
} else {
  Say "  fork 包已就位（$forkVersion），跳过安装"
}

# ---------- 3. 部署启动器（只备份一次，不覆盖备份） ----------
if (Test-Path $LauncherPath) {
  $current = Get-Content $LauncherPath -Raw
  if ($current -notmatch "@pricening") {
    $bak = "$LauncherPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    DoIt "备份原启动器 -> $bak"
    if (-not $Check) { Copy-Item $LauncherPath $bak }
  }
}
DoIt "部署启动器 -> $LauncherPath"
if (-not $Check) { Copy-Item $launcherSrc $LauncherPath -Force }

# ---------- 4. 开机自启任务 ----------
if ($task.Count -eq 0) {
  DoIt "创建计划任务 $TaskName（开机触发，最高权限）"
  if (-not $Check) {
    $action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$LauncherPath`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -User "$env:USERDOMAIN\$env:USERNAME" | Out-Null
  }
} elseif ($taskTarget -notlike "*pi-web-start.bat*") {
  throw "已存在任务 $TaskName 但它指向 `$taskTarget`，请人工确认后再改（避免误动别的程序）"
} else {
  Say "  计划任务已存在且指向启动器，跳过"
}

# ---------- 5. 版本锁 ----------
if ($Pin) {
  DoIt "setx PI_WEB_PIN $Pin（下次登录/服务生效）"
  if (-not $Check) { [Environment]::SetEnvironmentVariable("PI_WEB_PIN", $Pin, "User") }
}

# ---------- 6. 切换运行中的服务 ----------
if ($serving -eq "官方包在服务") {
  if ($RestartNow) {
    DoIt "停任务 + 停官方进程"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*@agegr*pi-web*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 5
    Start-ScheduledTask -TaskName $TaskName
    $ok = $false
    foreach ($i in 1..60) {
      Start-Sleep -Seconds 1
      if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $ok = $true; break }
    }
    if ($ok) {
      DoIt "fork 已在服务 -> 卸载官方包"
      npm uninstall -g $official
      # 卸官方包会连带删掉共享的 pi-web 垫片；服务在跑时不能重装（EBUSY），用 rebuild 重建链接
      DoIt "npm rebuild -g $pkg（恢复被一起删掉的 pi-web 垫片）"
      npm rebuild -g $pkg
    } else {
      throw "fork 未能在 60 秒内监听 $Port；官方包未卸载，可用备份启动器回滚"
    }
  } else {
    Say ""
    Say "⚠ 当前 30141 上跑的还是官方包，本脚本没有动它（避免掐断你正在用的会话）。"
    Say "  立刻切换：  .\scripts\bootstrap-production.ps1 -RestartNow"
    Say "  或者：      重启机器（开机任务会用 fork 起来）"
    Say ""
  }
}

# ---------- 7. 自检 ----------
Say ""
Say "自检："
try {
  $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/pins" -UseBasicParsing -TimeoutSec 20
  Say "  /api/pins -> $($r.Content)"
  Say "  （这个路由只有 fork 有，能返回就说明跑的是 @pricening/pi-web）"
} catch {
  Say "  /api/pins 不可达：$($_.Exception.Message)"
  Say "  若刚部署完还没切换，属正常；按上面的提示执行 -RestartNow 或重启机器。"
}
