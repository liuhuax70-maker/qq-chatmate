@echo off
REM Wrapper for autostart.ps1 (ASCII only, avoids codepage issues)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" %*
exit /b %ERRORLEVEL%
