@echo off
REM =========================================================
REM  Clean up leftover files that were locked during a rebuild.
REM
REM  Why this exists:
REM    Windows keeps an exclusive lock on a running exe. When the
REM    launcher is rebuilt while still running, the old binary can't
REM    be deleted and gets renamed to _trash.exe instead. The lock is
REM    released after a reboot (or after the process truly exits),
REM    so this script finishes the cleanup on next run.
REM
REM  Safe to run anytime: it only deletes files it created itself.
REM =========================================================

setlocal
set "HERE=%~dp0"

if exist "%HERE%_trash.exe" (
  del /f /q "%HERE%_trash.exe" 2>nul
  if exist "%HERE%_trash.exe" (
    echo [SKIP] _trash.exe is still locked. Reboot and run again.
  ) else (
    echo [OK] removed _trash.exe
  )
)

if exist "%HERE%_trash.exe.bak" del /f /q "%HERE%_trash.exe.bak" 2>nul
endlocal
