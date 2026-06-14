# install_windows.ps1
# Registers the Innergy PO -> Mail native messaging host for Chrome/Edge on Windows.
# Run from PowerShell: .\install_windows.ps1
# (Right-click > "Run with PowerShell" also works)

$ErrorActionPreference = "Stop"

# --- Require Administrator ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")
if (-not $isAdmin) {
    Write-Warning "Not running as Administrator. HKLM registration will be skipped."
    Write-Warning "For system-wide Chrome (installed in Program Files), re-run as Administrator."
    Write-Host ""
}

Write-Host ""
Write-Host "=== Innergy PO -> Mail: Windows Installer ===" -ForegroundColor Cyan
Write-Host ""

# --- Locate Python 3 ---
$pythonExe = $null
foreach ($candidate in @("python", "python3", "py")) {
    try {
        $path = (Get-Command $candidate -ErrorAction SilentlyContinue).Source
        if (-not $path) { continue }
        $ver = & $path --version 2>&1
        if ($ver -match "Python 3") {
            $pythonExe = $path
            break
        }
    } catch {}
}

if (-not $pythonExe) {
    Write-Error @"
Python 3 not found on PATH.
Install Python 3 from https://www.python.org/downloads/ (check 'Add to PATH')
then re-run this script.
"@
    exit 1
}
Write-Host "Found Python: $pythonExe" -ForegroundColor Green

# --- Install dependencies ---
Write-Host "Installing Python dependencies..."
& $pythonExe -m pip install pywin32 msal requests --quiet
Write-Host "Dependencies ready." -ForegroundColor Green

# --- Paths ---
$scriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostScript   = Join-Path $scriptDir "native-host\innergy_mailer_host_win.py"
$manifestDir  = Join-Path $scriptDir "native-host"
$exePath      = Join-Path $manifestDir "innergy_mailer_host_win.exe"
$manifestPath = Join-Path $scriptDir "native-host\com.innergy.mailer.json"

if (-not (Test-Path $hostScript)) {
    Write-Error "Host script not found: $hostScript"
    exit 1
}

# --- Kill any running instance of the host (it locks the .exe on Windows) ---
if (Test-Path $exePath) {
    $locked = Get-Process | Where-Object { try { $_.MainModule.FileName -eq $exePath } catch { $false } }
    if ($locked) {
        Write-Host "Stopping running host process..."
        $locked | Stop-Process -Force
        Start-Sleep -Milliseconds 500
    }
    # If still locked, rename the old file out of the way.
    try {
        $old = $exePath + ".old"
        Remove-Item $old -ErrorAction SilentlyContinue
        Rename-Item $exePath $old -ErrorAction Stop
        Write-Host "Renamed old exe to .old (will be deleted after compile)."
    } catch {
        Write-Warning "Could not move old exe: $_"
    }
}

# --- Compile to .exe (Chrome's CreateProcess cannot launch .bat files) ---
Write-Host "Installing PyInstaller..."
& $pythonExe -m pip install pyinstaller --quiet
Write-Host "Compiling native host to .exe..."
Push-Location $manifestDir
& $pythonExe -m PyInstaller --onefile --console --clean --name innergy_mailer_host_win --distpath $manifestDir innergy_mailer_host_win.py --log-level WARN
Pop-Location
if (-not (Test-Path $exePath)) {
    Write-Error "Compile failed - $exePath not found."
    exit 1
}
# Remove the renamed backup now that we have a fresh exe.
Remove-Item ($exePath + ".old") -ErrorAction SilentlyContinue
Write-Host "Compiled: $exePath" -ForegroundColor Green

# --- Write native messaging manifest JSON (no BOM, LF line endings - Chrome requires both) ---
# Use Python to write the JSON so we get LF endings; PowerShell ConvertTo-Json uses CRLF
# and Set-Content -Encoding utf8 adds a BOM, both of which Chrome rejects.
& $pythonExe -c @"
import json, sys
manifest = {
    'name': 'com.innergy.mailer',
    'description': 'Innergy PO -> Mail native messaging host',
    'path': sys.argv[1],
    'type': 'stdio',
    'allowed_origins': ['chrome-extension://akplcachdkpchhcacbbbnkgbfnfgifbn/']
}
with open(sys.argv[2], 'w', encoding='utf-8', newline='\n') as f:
    f.write(json.dumps(manifest, indent=2))
"@ $exePath $manifestPath
Write-Host "Manifest: $manifestPath" -ForegroundColor Green

# --- Register in HKLM (system-wide Chrome installs only read HKLM, not HKCU) ---
# This requires the script to run as Administrator.
Write-Host ""
Write-Host "Registering native messaging host (requires Administrator)..."
$registered = 0

$hklmBrowsers = [ordered]@{
    "Google Chrome"  = "HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts"
    "Microsoft Edge" = "HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts"
    "Chrome Beta"    = "HKLM:\SOFTWARE\Google\Chrome Beta\NativeMessagingHosts"
    "Chrome Canary"  = "HKLM:\SOFTWARE\Google\Chrome SxS\NativeMessagingHosts"
}
foreach ($name in $hklmBrowsers.Keys) {
    $parentPath = $hklmBrowsers[$name]
    $keyPath    = "$parentPath\com.innergy.mailer"
    try {
        New-Item -Path $keyPath -Force -ErrorAction Stop | Out-Null
        reg add ($keyPath -replace 'HKLM:\\', 'HKLM\') /ve /t REG_SZ /d $manifestPath /f 2>&1 | Out-Null
        Write-Host "  Registered (HKLM): $name" -ForegroundColor Green
        $registered++
    } catch {
        Write-Host "  Skipped HKLM $name (not admin or browser absent)" -ForegroundColor DarkGray
    }
}

# Also register in HKCU as fallback for per-user Chrome installs
$hkcuBrowsers = [ordered]@{
    "Google Chrome"  = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
    "Microsoft Edge" = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
}
foreach ($name in $hkcuBrowsers.Keys) {
    $parentPath = $hkcuBrowsers[$name]
    $keyPath    = "$parentPath\com.innergy.mailer"
    if (-not (Test-Path $parentPath)) { continue }
    New-Item -Path $keyPath -Force | Out-Null
    reg add ($keyPath -replace 'HKCU:\\', 'HKCU\') /ve /t REG_SZ /d $manifestPath /f 2>&1 | Out-Null
    Write-Host "  Registered (HKCU): $name" -ForegroundColor DarkGray
}

if ($registered -eq 0) {
    Write-Warning "No supported browsers detected. Chrome or Edge must be installed."
}

# --- Done ---
Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. In Chrome, go to chrome://extensions and load the 'extension' folder"
Write-Host "     (or reload if already loaded)"
Write-Host "  2. Click the extension icon > Options, and select 'Microsoft Outlook'"
Write-Host "  3. Open a PO on app.innergy.com and click 'Draft Email w/ PDF'"
Write-Host ""
Write-Host "  - Outlook Classic: ready to use."
Write-Host "  - New Outlook: open extension Options, paste your Azure App Client ID,"
Write-Host "    then click 'Sign in' for a one-time Microsoft account sign-in."
Write-Host "    See README.md for Azure app registration steps."
Write-Host ""
