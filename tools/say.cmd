@echo off
rem ============================================================
rem  Reusable Chinese message printer for the ASCII-only .cmd launchers.
rem
rem  The .cmd files must stay pure ASCII (cmd.exe parses .bat with the
rem  system ANSI codepage, so a UTF-8 byte sequence can break the parser).
rem  The visible Chinese text therefore lives in tools\msg\<id>.txt (UTF-8)
rem  and PowerShell prints it; a literal {value} in the body is replaced by
rem  the second argument.
rem
rem  usage:  call tools\say.cmd <message-id> ["value"]
rem ============================================================
setlocal
set "ROOT=%~dp0.."
set "VALUE=%~2"
powershell -NoProfile -Command "$p = Join-Path (Join-Path '%ROOT%' 'tools\msg') ('%1' + '.txt'); $t = (Get-Content -Encoding UTF8 -LiteralPath $p -Raw); if ($env:VALUE) { $t = $t.Replace('{value}', $env:VALUE) }; Write-Host $t.TrimEnd()"
endlocal
