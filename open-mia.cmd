@echo off
setlocal

cd /d "%~dp0"
title Mia Dev

set "PATH=%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH%"

rem Optional light mode for Windows dev launches:
rem set MIA_LIGHT=1 && open-mia.cmd
if /i "%MIA_LIGHT%"=="1" (
  if not defined MIA_DISABLE_BACKGROUND_STARTUP set "MIA_DISABLE_BACKGROUND_STARTUP=1"
)

set "MIA_ELECTRON_GPU_SWITCH="
if /i "%MIA_DISABLE_GPU%"=="1" set "MIA_ELECTRON_GPU_SWITCH=--disable-gpu"

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
if "%MIA_DISABLE_BACKGROUND_STARTUP%"=="1" (
  echo Background startup: disabled ^(MIA_LIGHT=1^)
) else (
  echo Background startup: enabled
)
if "%MIA_ELECTRON_GPU_SWITCH%"=="--disable-gpu" (
  echo GPU acceleration: disabled ^(MIA_DISABLE_GPU=1^)
) else (
  echo GPU acceleration: enabled
)
echo.
if /i "%MIA_FOREGROUND%"=="1" goto run_foreground

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$argsList = @('node_modules\electron\cli.js'); if ($env:MIA_ELECTRON_GPU_SWITCH) { $argsList += $env:MIA_ELECTRON_GPU_SWITCH }; $argsList += '.'; Start-Process -FilePath 'node.exe' -ArgumentList $argsList -WorkingDirectory '%CD%' -WindowStyle Hidden"
set "MIA_EXIT_CODE=%ERRORLEVEL%"

if not "%MIA_EXIT_CODE%"=="0" (
  echo.
  echo Failed to start Mia. PowerShell exited with code %MIA_EXIT_CODE%.
  pause
)

exit /b %MIA_EXIT_CODE%

:run_foreground
if "%MIA_ELECTRON_GPU_SWITCH%"=="--disable-gpu" (
  call node node_modules\electron\cli.js --disable-gpu .
) else (
  call npm run open
)
set "MIA_EXIT_CODE=%ERRORLEVEL%"

if not "%MIA_EXIT_CODE%"=="0" (
  echo.
  echo Mia exited with code %MIA_EXIT_CODE%.
  pause
)

exit /b %MIA_EXIT_CODE%
