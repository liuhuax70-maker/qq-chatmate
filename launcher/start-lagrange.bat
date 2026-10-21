@echo off
chcp 65001 >nul
REM ─────────────────────────────────────────────────────────
REM  启动 Lagrange.OneBot（协议端）
REM
REM  为什么用 .bat 包一层：
REM    Lagrange.OneBot.exe 在无控制台环境下启动会崩
REM    （Console.get_BufferWidth 句柄无效）。.bat 会分配真实控制台。
REM ─────────────────────────────────────────────────────────
cd /d "%~dp0..\lagrange\Lagrange.OneBot\bin\Release\net9.0\win-x64\publish"

if not defined DOTNET_BUNDLE_EXTRACT_BASE_DIR (
  set "DOTNET_BUNDLE_EXTRACT_BASE_DIR=%~dp0..\lagrange\dotnet-tmp"
  if not exist "%DOTNET_BUNDLE_EXTRACT_BASE_DIR%" mkdir "%DOTNET_BUNDLE_EXTRACT_BASE_DIR%"
)

echo [lagrange] 正在启动协议端...
echo [lagrange] 首次登录需要在弹出的窗口里扫码
Lagrange.OneBot.exe
