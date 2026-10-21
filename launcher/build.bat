@echo off
chcp 65001 >nul
REM ─────────────────────────────────────────────────────────
REM  编译启动器为 .exe（单文件、零依赖）
REM
REM  用 Windows 自带的 .NET Framework 4 编译器，不需要装 SDK。
REM  产物：
REM    鲸奈启动器.exe  —— 图形界面版（双击启动）
REM    鲸奈状态.exe    —— 命令行版（查状态/启动/停止）
REM ─────────────────────────────────────────────────────────
setlocal

set "HERE=%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [错误] 找不到 C# 编译器 csc.exe
  echo        需要 .NET Framework 4（Windows 自带，若缺失请安装）
  exit /b 1
)

echo [1/2] 编译图形界面版…
"%CSC%" /nologo /target:winexe /out:"%HERE%鲸奈启动器.exe" ^
  /reference:System.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll ^
  "%HERE%Launcher.cs"
if errorlevel 1 (
  echo [失败] 图形界面版编译失败
  exit /b 1
)

echo [2/2] 编译命令行版…
"%CSC%" /nologo /target:exe /out:"%HERE%鲸奈状态.exe" ^
  /reference:System.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll ^
  "%HERE%Launcher.cs"
if errorlevel 1 (
  echo [失败] 命令行版编译失败
  exit /b 1
)

echo.
echo [完成] 已生成：
echo    %HERE%鲸奈启动器.exe
echo    %HERE%鲸奈状态.exe
echo.
endlocal
