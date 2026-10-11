@echo off
rem ============================================================
rem  Portable DeepSeek Harness - one-shot self check
rem  Keep this file pure ASCII (see dsh.cmd for the reason).
rem ============================================================
chcp 65001 >nul
setlocal
rem  Two levels up from here is the repo root.
for %%I in ("%~dp0..\..") do set "HERE=%%~fI"

set "NODE=%HERE%\runtime\node\node.exe"
if not exist "%NODE%" (
  call "%HERE%\tools\say.cmd" missing-node "%NODE%"
  pause
  exit /b 1
)

"%NODE%" "%HERE%\tools\config.js" doctor
set "RC=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %RC%
