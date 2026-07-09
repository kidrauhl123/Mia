@echo off
setlocal

cd /d "%~dp0"
title Mia Dev

set "PATH=%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH%"
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
if exist "C:\msys64\mingw64\bin\dlltool.exe" set "PATH=C:\msys64\mingw64\bin;%PATH%"

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

set "CORE_PLATFORM=win32"
for /f "usebackq delims=" %%P in (`node -p "process.platform" 2^>nul`) do set "CORE_PLATFORM=%%P"
set "CORE_ARCH=x64"
for /f "usebackq delims=" %%A in (`node -p "process.arch" 2^>nul`) do set "CORE_ARCH=%%A"
set "CORE_EXE=mia-core"
if /i "%CORE_PLATFORM%"=="win32" set "CORE_EXE=mia-core.exe"

set "CORE_READY=0"
if exist "resources\bundled-mia-core\%CORE_PLATFORM%-%CORE_ARCH%\%CORE_EXE%" set "CORE_READY=1"
if exist "target\debug\%CORE_EXE%" set "CORE_READY=1"
if exist "target\release\%CORE_EXE%" set "CORE_READY=1"

if not "%CORE_READY%"=="1" (
  echo Preparing Mia Core prebuilt binary...
  call npm run core:prepare
  if errorlevel 1 (
    echo.
    echo Mia Core binary is not ready.
    echo If the prebuilt Core release has not been published yet, build one locally first.
    echo Run one of these, then open Mia again:
    echo   npm run core:prepare
    echo   set MIA_CORE_RS_BIN=C:\path\to\mia-core.exe ^&^& npm run core:prepare
    echo   cargo build -p mia-core-app --bin mia-core
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
