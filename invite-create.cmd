@echo off
setlocal
cd /d "%~dp0"
node "%~dp0scripts\create-invitation.mjs" %*
exit /b %ERRORLEVEL%
