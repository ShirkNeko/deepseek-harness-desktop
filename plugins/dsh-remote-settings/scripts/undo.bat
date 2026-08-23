@echo off
rem dsh-remote-settings installer undo (Windows).
rem Restores every patched copy to its original. Run to revert (e.g. before
rem uninstalling the plugin).
setlocal
set "DIR=%~dp0.."
node "%DIR%\lib\install.js" undo
endlocal
