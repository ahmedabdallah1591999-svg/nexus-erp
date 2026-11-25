@echo off
REM Nexus ERP - start the local server (Windows). Reviewed, not machine-tested on Windows.
cd /d %~dp0
node server.js
pause
