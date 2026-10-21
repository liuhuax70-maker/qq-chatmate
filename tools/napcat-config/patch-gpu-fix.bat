@echo off
setlocal
REM =========================================================
REM  Patch NapCatWinBootMain.exe:
REM     --enable-logging  ->  --no-sandbox
REM
REM  ?? QQ Electron ? GPU ???
REM    GPU process launch failed: error_code=18
REM    FATAL: GPU process isn't usable. Goodbye.
REM
REM  error_code=18 ? Electron ?????????? GPU?
REM  ?? NapCatWinBootMain ???? QQ ? --enable-logging?
REM  ?? --no-sandbox??????/?????? QQ ????
REM
REM  patch ???? UTF-16 ??? --enable-logging (16??/32??)
REM  ????? --no-sandbox (11??/22??)???? null?
REM  --no-sandbox ??????????
REM =========================================================

set "HERE=%~dp0"
set "TARGET=%HERE%NapCatWinBootMain.exe"

if not exist "%TARGET%" (
  echo [ERROR] not found: %TARGET%
  pause
  exit /b 1
)

echo [1/3] Backing up...
if not exist "%TARGET%.bak" copy /y "%TARGET%" "%TARGET%.bak" >nul

echo [2/3] Patching...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%TARGET%'; $b=[IO.File]::ReadAllBytes($p); $pos=20848; $s=[Text.Encoding]::Unicode.GetBytes('--no-sandbox'); for($i=0;$i -lt $s.Length;$i++){$b[$pos+$i]=$s[$i]}; for($i=$s.Length;$i -lt 32;$i++){$b[$pos+$i]=0}; [IO.File]::WriteAllBytes($p,$b); Write-Host '  patched'"

echo [3/3] Verifying...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$b=[IO.File]::ReadAllBytes('%TARGET%'); $t=[Text.Encoding]::Unicode.GetString($b[20848..20878]); if($t -match 'no-sandbox'){Write-Host '  OK: --no-sandbox active'}else{Write-Host '  FAILED'}"

echo.
echo [DONE]
endlocal
