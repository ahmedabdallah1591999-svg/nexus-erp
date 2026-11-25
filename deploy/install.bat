@echo off
REM Nexus ERP - install on Windows (free: needs only Node.js 18+ LTS)
setlocal
set TARGET=%1
if "%TARGET%"=="" set TARGET=%USERPROFILE%\nexus-erp
where node >nul 2>nul || (echo Node.js 18+ is required first: https://nodejs.org (free LTS) & exit /b 1)
mkdir "%TARGET%" 2>nul
mkdir "%TARGET%\data" 2>nul
mkdir "%TARGET%\backups" 2>nul
mkdir "%TARGET%\vendor" 2>nul
copy /y "%~dp0..\*.js" "%TARGET%\" >nul
copy /y "%~dp0..\index.html" "%TARGET%\" >nul
copy /y "%~dp0..\styles.css" "%TARGET%\" >nul
copy /y "%~dp0..\vendor\jszip.min.js" "%TARGET%\vendor\" >nul 2>nul
copy /y "%~dp0*.bat" "%TARGET%\" >nul 2>nul
echo Installed to %TARGET%
echo Start:   cd /d "%TARGET%" ^&^& node server.js     then open http://localhost:8080
echo First run: create the admin user in the browser, then log in.
