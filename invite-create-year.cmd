@echo off
setlocal
cd /d "%~dp0"
node "%~dp0scripts\create-invitation.mjs" --days 365 %*
exit /b %ERRORLEVEL%
