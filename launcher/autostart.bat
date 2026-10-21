@echo off
setlocal
REM =========================================================
REM  Enable / disable auto-start at Windows login
REM
REM  Usage:
REM    autostart.bat on    - enable (start all components at login)
REM    autostart.bat off   - disable
REM    autostart.bat check - show current state
REM =========================================================

set "HERE=%~dp0"
set "REGKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
set "APPNAME=QinaiChatmateLauncher"
set "TARGET=%HERE%qinai-launcher.exe"

if /i "%~1"=="off" goto :off
if /i "%~1"=="check" goto :check
if /i "%~1"=="on" goto :on

echo Usage: autostart.bat [on^|off^|check]
exit /b 2

:on
if not exist "%TARGET%" (
  echo [ERROR] %TARGET% not found.
  echo         Run build.bat first.
  exit /b 1
)
REM Start minimized with -silent so components come up automatically
reg add "%REGKEY%" /v "%APPNAME%" /t REG_SZ /d "\"%TARGET%\" -silent" /f >nul
if errorlevel 1 (
  echo [FAILED] could not write registry
  exit /b 1
)
echo [OK] auto-start enabled
echo      %TARGET% -silent
exit /b 0

:off
reg delete "%REGKEY%" /v "%APPNAME%" /f >nul 2>&1
echo [OK] auto-start disabled
exit /b 0

:check
reg query "%REGKEY%" /v "%APPNAME%" 2>nul
if errorlevel 1 (
  echo [STATE] auto-start is OFF
) else (
  echo [STATE] auto-start is ON
)
exit /b 0
