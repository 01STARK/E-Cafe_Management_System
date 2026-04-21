@echo off
title GrindZone Setup
echo.
echo ============================================
echo   GrindZone Cafe Manager - Setup
echo ============================================
echo.

:: Detect Node.js
set "NODE_CMD="

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set "NODE_CMD=node"
    goto :npm_check
)

set "RSTUDIO_NODE=D:\08-Softwares\R studio\RStudio\resources\app\bin\node\node.exe"
if exist "%RSTUDIO_NODE%" (
    set "NODE_CMD=%RSTUDIO_NODE%"
    set "PATH=D:\08-Softwares\R studio\RStudio\resources\app\bin\node;%PATH%"
    goto :npm_check
)

echo [ERROR] Node.js is not installed.
echo.
echo Please install Node.js from: https://nodejs.org
echo After installing, re-run this setup.
pause
exit /b 1

:npm_check
echo [OK] Node.js: %NODE_CMD%
"%NODE_CMD%" --version

:: Find npm
set "NPM_CMD="
where npm >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set "NPM_CMD=npm"
    goto :install
)

:: Try npm next to node
for %%i in ("%NODE_CMD%") do set "NODE_DIR=%%~dpi"
if exist "%NODE_DIR%npm.cmd" (
    set "NPM_CMD=%NODE_DIR%npm.cmd"
    goto :install
)

:: Use the bootstrapped npm from temp if available
set "BOOTSTRAP_NPM=C:\Users\smitt\AppData\Local\Temp\npm-pkg\package\bin\npm-cli.js"
if exist "%BOOTSTRAP_NPM%" (
    set "NPM_CMD=%NODE_CMD% %BOOTSTRAP_NPM%"
    goto :install
)

echo [ERROR] npm not found. Please install Node.js from https://nodejs.org
pause
exit /b 1

:install
echo [OK] npm found
echo.
echo Installing dependencies...
cd /d "%~dp0"

if "%NPM_CMD%"=="npm" (
    npm install
) else (
    "%NODE_CMD%" "%BOOTSTRAP_NPM%" install
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Installation failed.
    echo Try installing Node.js from https://nodejs.org and run setup again.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Setup complete!
echo ============================================
echo.
echo Before starting, edit .env and configure:
echo   EMAIL_USER  = your Gmail address
echo   EMAIL_PASS  = Gmail App Password (16 chars)
echo.
echo Get Gmail App Password at:
echo   https://myaccount.google.com/apppasswords
echo   (Requires 2FA enabled on Gmail)
echo.
echo To start: double-click start.bat
echo.
pause
