@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Hearth.exe" "%~dp0helper.mjs" %*
pause
