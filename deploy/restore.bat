@echo off
REM Nexus ERP - restore a backup (pass the backup folder name, or latest)
setlocal
set DIR=%~dp0
set DATA=%DIR%data
set PICK=%1
if "%PICK%"=="" (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%DIR%backups" 2^>nul') do (set PICK=%%D & goto :have)
)
:have
if "%PICK%"=="" (echo No backups found & exit /b 1)
tasklist /fi "imagename eq node.exe" | find /i "node.exe" >nul && (echo Stop the server first: close its window or Ctrl+C, then re-run. & exit /b 1)
copy /y "%DIR%backups\%PICK%\*.json" "%DATA%\" >nul
echo Restored %PICK% into %DATA% - start the server again: node server.js
