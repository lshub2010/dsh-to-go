@echo off
rem ============================================================
rem  Portable DeepSeek Harness - Web UI launcher
rem
rem  IMPORTANT: keep this file pure ASCII. cmd.exe parses .bat
rem  files with the system ANSI codepage (GBK on Chinese
rem  Windows), not with whatever chcp sets, so a non-ASCII byte
rem  can be chopped mid-sequence and corrupt the parser.
rem ============================================================
chcp 65001 >nul
setlocal
rem  Two levels up from here is the repo root.
for %%I in ("%~dp0..\..") do set "HERE=%%~fI"

set "NODE=%HERE%\runtime\node\node.exe"
if not exist "%NODE%" (
  echo.
  call "%HERE%\tools\say.cmd" missing-node "%NODE%"
  echo.
  pause
  exit /b 1
)

"%NODE%" "%HERE%\tools\launch.js" web %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  call "%HERE%\tools\say.cmd" exit-code "%RC%"
  pause
)
endlocal & exit /b %RC%
