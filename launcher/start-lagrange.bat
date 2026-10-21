@echo off
chcp 65001 >nul
REM ─────────────────────────────────────────────────────────
REM  启动 Lagrange.OneBot（协议端）
REM  必须用 .bat 包一层：exe 在无控制台环境会崩
REM  （Console.get_BufferWidth 句柄无效）
REM ─────────────────────────────────────────────────────────
set "HERE=%~dp0"
set "BASE=%HERE%.."
set "PUBLISH=%BASE%\lagrange\Lagrange.OneBot\bin\Release\net9.0\win-x64\publish"
set "BUNDLE=%BASE%\lagrange\dotnet-tmp"

cd /d "%PUBLISH%"
if not exist "%BUNDLE%" mkdir "%BUNDLE%"
set DOTNET_BUNDLE_EXTRACT_BASE_DIR=%BUNDLE%

echo [lagrange] 启动中…二维码会显示在下方，用手机 QQ 扫
Lagrange.OneBot.exe
pause