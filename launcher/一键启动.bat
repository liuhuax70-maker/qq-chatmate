@echo off
chcp 65001 >nul
REM ─────────────────────────────────────────────────────────
REM  鲸奈 QQ 网友 · 一键启动器
REM  双击本文件即可打开图形界面
REM ─────────────────────────────────────────────────────────
cd /d "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher.ps1"
