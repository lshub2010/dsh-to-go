@echo off
rem ============================================================
rem  Portable DeepSeek Harness - graphical configuration page
rem  Serves ui\app.html on 127.0.0.1 and opens it in the browser.
rem  Keep this file pure ASCII (see dsh.cmd for the reason).
rem ============================================================
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

set "NODE=%HERE%\runtime\node\node.exe"
if not exist "%NODE%" (
  echo   [ERROR] portable Node runtime not found: %NODE%
  pause
  exit /b 1
)

"%NODE%" "%HERE%\tools\ui-server.js" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo   configuration page exited with code %RC%.
  pause
)
endlocal & exit /b %RC%
