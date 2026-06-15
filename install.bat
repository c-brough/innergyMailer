@echo off
:: Innergy Mailer -- Windows native host installer
:: Double-click this file to install. No PowerShell knowledge needed.

echo.
echo  Innergy Mailer Installer
echo  ==============================
echo.

:: Check for Administrator rights and re-launch elevated if needed.
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  Requesting Administrator privileges...
    powershell -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c \"%~f0\"' -Verb RunAs"
    exit /b
)

PowerShell -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1"
echo.
pause
