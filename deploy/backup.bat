@echo off
REM Nexus ERP - backup the data directory
setlocal
set DIR=%~dp0
set DATA=%DIR%data
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul ^| find "="') do set DT=%%I
if "%DT%"=="" (set STAMP=%DATE:/=-%_%TIME::=-%) else (set STAMP=%DT:~0,8%-%DT:~8,6%)
set STAMP=%STAMP: =0%
mkdir "%DIR%backups\%STAMP%" 2>nul
copy /y "%DATA%\store.json" "%DIR%backups\%STAMP%\" >nul 2>nul
copy /y "%DATA%\sessions.json" "%DIR%backups\%STAMP%\" >nul 2>nul
echo Backup: %DIR%backups\%STAMP%
