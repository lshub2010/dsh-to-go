@echo off
rem ============================================================
rem  Portable DeepSeek Harness - maintenance console
rem  (doctor / upgrade / switch slot / backup / key / versions)
rem  Keep this file pure ASCII (see dsh.cmd for the reason).
rem ============================================================
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

set "NODE=%HERE%\runtime\node\node.exe"
if not exist "%NODE%" (
  call "%HERE%\tools\say.cmd" missing-node "%NODE%"
  pause
  exit /b 1
)

"%NODE%" "%HERE%\tools\config.js" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  call "%HERE%\tools\say.cmd" exit-code "%RC%"
  pause
)
endlocal & exit /b %RC%
