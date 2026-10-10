@echo off
rem ============================================================
rem  dsh-to-go - one-time build (portable Node + dsh into 2 slots)
rem  Keep this file pure ASCII: cmd.exe parses .bat with the
rem  system ANSI code page, so UTF-8 text here breaks the file.
rem ============================================================
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

where powershell >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] powershell not found. Windows 10/11 ships it by default.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%\tools\build.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo   build failed with code %RC%.
) else (
  echo   build finished.
)
pause
endlocal & exit /b %RC%
