@echo off
title GrindZone Cafe Manager
echo.
echo ============================================
echo   GrindZone Cafe Manager
echo ============================================
echo.

:: Try standard Node.js first, then fall back to RStudio's bundled node
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set "NODE_CMD=node"
    goto :found
)

set "RSTUDIO_NODE=D:\08-Softwares\R studio\RStudio\resources\app\bin\node\node.exe"
if exist "%RSTUDIO_NODE%" (
    set "NODE_CMD=%RSTUDIO_NODE%"
    set "PATH=D:\08-Softwares\R studio\RStudio\resources\app\bin\node;%PATH%"
    goto :found
)

echo [ERROR] Node.js not found.
echo         Install from: https://nodejs.org
echo         Or run setup.bat first.
pause
exit /b 1

:found
echo [OK] Using Node.js: %NODE_CMD%
echo.
echo Starting server...
echo Open in browser: http://localhost:3000
echo.
echo Default login:  admin / Admin@123
echo.
echo Press Ctrl+C to stop.
echo.
cd /d "%~dp0"
"%NODE_CMD%" server.js
pause
