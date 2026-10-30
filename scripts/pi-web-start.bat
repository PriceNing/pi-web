@echo off
setlocal EnableExtensions
REM pi-web fork launcher (Windows). Canonical copy lives in this repo at
REM scripts/pi-web-start.bat; deploy it to the machine that runs pi-web, e.g.
REM   copy /Y scripts\pi-web-start.bat "%USERPROFILE%\Desktop\pi-web-start.bat"
REM and point the scheduled task that starts pi-web at that path.
REM
REM It resolves the current user's Node.js, npm global prefix and log directory,
REM installs the package when missing, updates it when a newer version exists,
REM then starts the server. Run with --check to print what it resolved.
REM
REM Fork note: the package is @pricening/pi-web, a fork of @agegr/pi-web that adds
REM server-side pinned projects and sessions. Never point this back at
REM @agegr/pi-web and never keep both installed: both packages ship a bin shim
REM named "pi-web", so whichever was installed last owns the command, and
REM uninstalling either one deletes that shared shim.
REM
REM Environment overrides:
REM   PI_WEB_HOSTNAME / PI_WEB_PORT   bind address (default 0.0.0.0 / 30141)
REM   PI_WEB_LOG                      log file (default %LOCALAPPDATA%\pi-web\logs)
REM   PI_WEB_PASSWORD                 enables login; required if 0.0.0.0 is reachable
REM                                   beyond a trusted network
REM   PI_WEB_PIN                      exact version to stay on, e.g. 0.9.5. When set,
REM                                   the auto-update check is skipped. Recommended on
REM                                   production machines: this launcher runs at every
REM                                   boot and the fork's @latest tag is published by
REM                                   CI automatically, so without a pin a bad build
REM                                   would roll onto every machine by itself.

if not defined PI_WEB_HOSTNAME set "PI_WEB_HOSTNAME=0.0.0.0"
if not defined PI_WEB_PORT set "PI_WEB_PORT=30141"

REM Always name the public registry explicitly. A machine whose ~/.npmrc points at a
REM read-only mirror cannot resolve this scoped package reliably: mirrors answer 404
REM for freshly published scoped packages until they sync, and reject logins and
REM publishes outright.
set "REGISTRY=https://registry.npmjs.org/"

set "LOG_DIR=%LOCALAPPDATA%\pi-web\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
if not defined PI_WEB_LOG set "PI_WEB_LOG=%LOG_DIR%\pi-web-start.log"
set "LOG=%PI_WEB_LOG%"

set "NODE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

set "NPM="
for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM set "NPM=%%I"
if not defined NPM if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM=%ProgramFiles%\nodejs\npm.cmd"

if not defined NODE (
  echo Node.js was not found in PATH.
  echo Install Node.js 22.19 or newer, then run this script again.
  exit /b 1
)

if not defined NPM (
  echo npm was not found in PATH.
  echo Reinstall Node.js with npm included, then run this script again.
  exit /b 1
)

set "NPM_PREFIX="
for /f "usebackq delims=" %%P in (`call "%NPM%" prefix -g 2^>nul`) do set "NPM_PREFIX=%%P"
if not defined NPM_PREFIX (
  echo Could not determine the npm global prefix.
  exit /b 1
)

set "npm_config_prefix=%NPM_PREFIX%"
set "PIWEB_DIR=%NPM_PREFIX%\node_modules\@pricening\pi-web"
set "PIWEB=%PIWEB_DIR%\bin\pi-web.js"
set "VERSION_FILE=%TEMP%\pi-web-version-%RANDOM%-%RANDOM%.txt"
set "LATEST_FILE=%TEMP%\pi-web-latest-%RANDOM%-%RANDOM%.txt"

REM Install spec: @latest by default, or the exact pinned version when PI_WEB_PIN is set.
set "SPEC=@pricening/pi-web@latest"
if defined PI_WEB_PIN set "SPEC=@pricening/pi-web@%PI_WEB_PIN%"

if /I "%~1"=="--check" (
  echo NODE=%NODE%
  echo NPM=%NPM%
  echo NPM_PREFIX=%NPM_PREFIX%
  echo REGISTRY=%REGISTRY%
  echo PIWEB=%PIWEB%
  if exist "%PIWEB%" (
    "%NODE%" -p "require(process.argv[1]).version" "%PIWEB_DIR%\package.json"
  ) else (
    echo pi-web is not installed.
  )
  exit /b 0
)

echo ===== %DATE% %TIME% =====>> "%LOG%"

if not exist "%PIWEB%" (
  echo Installing %SPEC% ...>> "%LOG%"
  call "%NPM%" install -g %SPEC% --registry "%REGISTRY%" --prefix "%NPM_PREFIX%" --prefer-offline --no-audit --no-fund >> "%LOG%" 2>&1
  if errorlevel 1 (
    echo npm install failed.>> "%LOG%"
    exit /b 1
  )
  if not exist "%PIWEB%" (
    echo pi-web.js missing after install: %PIWEB%>> "%LOG%"
    exit /b 1
  )
  goto start
)

REM PI_WEB_PIN locks this machine to one version, so skip the update check entirely.
if defined PI_WEB_PIN (
  echo Pinned to %PI_WEB_PIN%, skipping version check.>> "%LOG%"
  goto start
)

set "INSTALLED_VERSION="
"%NODE%" -p "require(process.argv[1]).version" "%PIWEB_DIR%\package.json" > "%VERSION_FILE%" 2>nul
if exist "%VERSION_FILE%" set /p INSTALLED_VERSION=<"%VERSION_FILE%"
del "%VERSION_FILE%" >nul 2>&1

set "LATEST_VERSION="
call "%NPM%" view @pricening/pi-web version --registry "%REGISTRY%" --fetch-timeout=5000 --fetch-retries=0 > "%LATEST_FILE%" 2>nul
if exist "%LATEST_FILE%" set /p LATEST_VERSION=<"%LATEST_FILE%"
del "%LATEST_FILE%" >nul 2>&1

if not defined LATEST_VERSION (
  echo Version check failed, starting installed version %INSTALLED_VERSION%.>> "%LOG%"
  goto start
)

if /I "%INSTALLED_VERSION%"=="%LATEST_VERSION%" (
  echo Already up to date: %INSTALLED_VERSION%.>> "%LOG%"
  goto start
)

echo Updating @pricening/pi-web %INSTALLED_VERSION% -^> %LATEST_VERSION% ...>> "%LOG%"
call "%NPM%" install -g @pricening/pi-web@latest --registry "%REGISTRY%" --prefix "%NPM_PREFIX%" --prefer-offline --no-audit --no-fund >> "%LOG%" 2>&1
if errorlevel 1 (
  echo npm update failed, starting existing version.>> "%LOG%"
) else (
  echo npm update ok.>> "%LOG%"
)

:start
echo Starting pi-web on %PI_WEB_HOSTNAME%:%PI_WEB_PORT% ...>> "%LOG%"
"%NODE%" "%PIWEB%" --hostname "%PI_WEB_HOSTNAME%" --port "%PI_WEB_PORT%" --no-open
set "EXIT_CODE=%ERRORLEVEL%"
echo pi-web exited %EXIT_CODE% at %DATE% %TIME%>> "%LOG%"
exit /b %EXIT_CODE%
