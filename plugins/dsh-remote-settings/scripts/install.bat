@echo off
rem dsh-remote-settings installer (Windows).
rem Auto-detects every copy of the bundle and patches them all.
rem Run once after: dsh plugin --profile web add <this-dir>
setlocal
set "DIR=%~dp0.."
node "%DIR%\lib\install.js" patch
endlocal
