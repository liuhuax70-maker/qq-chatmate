@echo off
setlocal
REM =========================================================
REM  Patch Lagrange.OneBot appsettings.json
REM
REM  Fixes two problems found in production:
REM
REM   1) GetOptimumServer: true -> false
REM      Lagrange pings every candidate server to pick the fastest.
REM      ICMP raw-socket requires elevation; without it login dies with:
REM        Win32Exception (5): Access is denied
REM        at System.Net.NetworkInformation.Ping.DoSendPingCore
REM      Turning it off makes Lagrange use the default server directly.
REM
REM   2) ConsoleCompatibilityMode: false
REM      (true causes the QR/codepage path to misbehave in some terminals)
REM
REM  Usage: patch-lagrange-config.bat [path-to-publish-dir]
REM =========================================================

set "HERE=%~dp0"
set "BASE=%HERE%.."

if not "%~1"=="" (
  set "PUBLISH=%~1"
) else (
  set "PUBLISH=%BASE%\lagrange\Lagrange.OneBot\bin\Release\net9.0\win-x64\publish"
)

set "CFG=%PUBLISH%\appsettings.json"
if not exist "%CFG%" (
  echo [ERROR] not found: %CFG%
  exit /b 1
)

echo [1/2] Backing up...
copy /y "%CFG%" "%CFG%.bak" >nul 2>&1

echo [2/2] Patching...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%CFG%'; $c=Get-Content -Raw -Encoding UTF8 $p;" ^
  "$c=$c -replace '\"GetOptimumServer\"\s*:\s*true','\"GetOptimumServer\": false';" ^
  "$c=$c -replace '\"ConsoleCompatibilityMode\"\s*:\s*true','\"ConsoleCompatibilityMode\": false';" ^
  "[System.IO.File]::WriteAllText($p,$c,(New-Object System.Text.UTF8Encoding($false)));" ^
  "Write-Host '  patched'"

echo.
echo [DONE] GetOptimumServer=false, ConsoleCompatibilityMode=false
echo        (backup: %CFG%.bak)
echo.
endlocal
