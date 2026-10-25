@echo off
setlocal
REM =========================================================
REM  Build launcher exe (single file, zero dependency)
REM  Uses Windows built-in .NET Framework 4 compiler (csc.exe)
REM
REM  Output:
REM    <chinese>launcher.exe  - GUI version (double-click this)
REM    <chinese>status.exe    - console version (status/start/stop)
REM
REM  The manifest requests administrator rights. This is required
REM  because NapCat injects into the QQ process. Embedding it in the
REM  exe means Windows elevates once at launch instead of prompting
REM  for every child component.
REM =========================================================

set "HERE=%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [ERROR] csc.exe not found. Need .NET Framework 4.
  pause
  exit /b 1
)

set "SRC=%HERE%Launcher.cs"
if not exist "%SRC%" (
  echo [ERROR] Launcher.cs not found in %HERE%
  pause
  exit /b 1
)

set "MANIFEST=%HERE%launcher.manifest"
if not exist "%MANIFEST%" (
  echo [ERROR] launcher.manifest not found in %HERE%
  echo         It declares requireAdministrator.
  pause
  exit /b 1
)

set "COMMON=/nologo /reference:System.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /win32manifest:"%MANIFEST%" /win32icon:"%HERE%´ó·ÊÓã.ico""

echo [1/2] Building GUI version...
"%CSC%" /target:winexe /out:"%HERE%´ó·ÊÓã.exe" %COMMON% "%SRC%"
if errorlevel 1 (
  echo [FAILED] GUI build failed
  pause
  exit /b 1
)

echo [2/2] Building console version...
"%CSC%" /target:exe /out:"%HERE%´ó·ÊÓã.exe" %COMMON% "%SRC%"
if errorlevel 1 (
  echo [FAILED] console build failed
  pause
  exit /b 1
)

echo.
echo [DONE]
echo    %HERE%´ó·ÊÓã.exe
echo    %HERE%´ó·ÊÓã.exe
echo.
pause
endlocal
