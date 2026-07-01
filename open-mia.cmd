@echo off
setlocal

cd /d "%~dp0"
title Mia Dev

set "PATH=%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js, then run this file again.
  pause
  exit /b 127
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js/npm, then run this file again.
  pause
  exit /b 127
)

if not exist "node_modules\electron" (
  echo Installing Mia dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting Mia in development mode...
echo Project: %CD%
echo.
if /i "%MIA_FOREGROUND%"=="1" goto run_foreground

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath 'node.exe' -ArgumentList @('node_modules\electron\cli.js','.') -WorkingDirectory '%CD%' -WindowStyle Hidden"
set "MIA_EXIT_CODE=%ERRORLEVEL%"

if not "%MIA_EXIT_CODE%"=="0" (
  echo.
  echo Failed to start Mia. PowerShell exited with code %MIA_EXIT_CODE%.
  pause
)

exit /b %MIA_EXIT_CODE%

:run_foreground
call npm run open
set "MIA_EXIT_CODE=%ERRORLEVEL%"

if not "%MIA_EXIT_CODE%"=="0" (
  echo.
  echo Mia exited with code %MIA_EXIT_CODE%.
  pause
)

exit /b %MIA_EXIT_CODE%
