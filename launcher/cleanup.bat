@echo off
REM =========================================================
REM  Clean up leftover files that were locked during a rebuild.
REM
REM  Why this exists:
REM    Windows keeps an exclusive lock on a running exe. When the
REM    launcher is rebuilt while still running, the old binary can't
REM    be deleted and gets renamed to _trash*.exe instead. The lock is
REM    released after a reboot (or after the process truly exits),
REM    so this script finishes the cleanup on next run.
REM
REM  Safe to run anytime: it only deletes _trash* files it created.
REM =========================================================

setlocal
set "HERE=%~dp0"

for %%F in ("%HERE%_trash.exe" "%HERE%_trash2.exe" "%HERE%_trash3.exe") do (
  if exist "%%~F" (
    del /f /q "%%~F" 2>nul
    if exist "%%~F" (
      echo [SKIP] %%~nxF is still locked. Reboot and run again.
    ) else (
      echo [OK] removed %%~nxF
    )
  )
)

endlocal