@echo off
rem ============================================================
rem  Portable DeepSeek Harness - CLI / headless launcher
rem  Examples:
rem    dsh-cli.cmd --profile headless "summarize the repo"
rem    dsh-cli.cmd --version
rem    dsh-cli.cmd headless "run the tests"
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

"%NODE%" "%HERE%\tools\launch.js" cli %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  call "%HERE%\tools\say.cmd" exit-code "%RC%"
  pause
)
endlocal & exit /b %RC%
