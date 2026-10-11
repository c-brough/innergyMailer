@echo off
:: InnerCider -- Windows installer
:: Double-click this file to install. No PowerShell knowledge needed.
::
:: Runs in two passes: registering the native host needs Administrator, but the
:: browser should open as you, not as Administrator. So an elevated window does
:: the install, then this window opens the Extensions page for the last step.

if /i "%~1"=="elevated" goto :elevated

echo.
echo  InnerCider Installer
echo  ==============================
echo.

:: Already Administrator (e.g. UAC off): do both passes in this one window.
net session >nul 2>&1
if %errorLevel% equ 0 (
    PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1"
    echo.
    pause
    exit /b
)

echo  Requesting Administrator privileges...
powershell -NoProfile -Command "try { $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c \"\"%~f0\" elevated\"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 1 }"
if %errorLevel% neq 0 (
    echo.
    echo  Setup did not finish ^(cancelled, or it failed in the Administrator window^).
    echo.
    pause
    exit /b 1
)

PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1" -BrowserOnly
echo.
pause
exit /b

:elevated
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1" -SkipBrowser
if %errorLevel% neq 0 (
    echo.
    echo  Install failed -- see the messages above.
    echo.
    pause
    exit /b 1
)
exit /b 0
