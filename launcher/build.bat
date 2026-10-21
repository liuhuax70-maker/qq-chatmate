@echo off
setlocal
REM =========================================================
REM  Build launcher exe (single file, zero dependency)
REM  Uses Windows built-in .NET Framework 4 compiler (csc.exe)
REM
REM  Output:
REM    qinai-launcher.exe  - GUI version (double-click)
REM    qinai-status.exe    - console version (status/start/stop)
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

set "COMMON=/nologo /reference:System.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll"

echo [1/2] Building GUI version...
"%CSC%" /target:winexe /out:"%HERE%qinai-launcher.exe" %COMMON% "%SRC%"
if errorlevel 1 (
  echo [FAILED] GUI build failed
  pause
  exit /b 1
)

echo [2/2] Building console version...
"%CSC%" /target:exe /out:"%HERE%qinai-status.exe" %COMMON% "%SRC%"
if errorlevel 1 (
  echo [FAILED] console build failed
  pause
  exit /b 1
)

echo.
echo [DONE]
echo    %HERE%qinai-launcher.exe
echo    %HERE%qinai-status.exe
echo.
pause
endlocal
