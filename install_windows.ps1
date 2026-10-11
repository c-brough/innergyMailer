# install_windows.ps1
# Installs InnerCider on Windows: registers the native messaging host for
# Chrome/Edge, copies the extension to a fixed folder, and opens the browser's
# Extensions page for the one click Chrome won't let a script make.
# Run from PowerShell: .\install_windows.ps1
# (Right-click > "Run with PowerShell" also works; install.bat is the easy way)
#
# install.bat runs this twice, because registering the host needs Administrator
# but the browser should open as the signed-in user:
#   -SkipBrowser   the elevated pass: install everything, open nothing
#   -BrowserOnly   the normal pass afterwards: just open the Extensions page

param(
    [switch]$SkipBrowser,
    [switch]$BrowserOnly
)

$ErrorActionPreference = "Stop"

$ExtensionId = "akplcachdkpchhcacbbbnkgbfnfgifbn"

# Where the extension copy lives. Chrome won't let a script add an extension
# that isn't from the Web Store, so "Load unpacked" stays a manual click -- but it
# should point at a folder that outlives this download (a copy loaded straight
# from Downloads breaks the day that folder is cleaned out). Program Files when
# elevated so every user on the PC can load it; the per-user folder otherwise.
# The manifest "key" pins the extension ID, so the folder doesn't affect it.
function Get-ExtensionDir([bool]$elevated) {
    $machine = Join-Path $env:ProgramFiles "InnerCider\extension"
    $user    = Join-Path $env:LOCALAPPDATA "InnerCider\extension"
    if ($elevated) { return $machine }
    # The non-elevated -BrowserOnly pass must find the copy the elevated pass made.
    if ($BrowserOnly -and (Test-Path $machine)) { return $machine }
    return $user
}

function Find-Browser {
    $browsers = @(
        @{ Exe = "chrome.exe"; Name = "Chrome"; Url = "chrome://extensions" },
        @{ Exe = "msedge.exe"; Name = "Edge";   Url = "edge://extensions" }
    )
    foreach ($b in $browsers) {
        foreach ($root in @("HKCU:", "HKLM:")) {
            $key  = "$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$($b.Exe)"
            $path = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'(default)'
            if ($path) { $path = $path.Trim('"') }
            if ($path -and (Test-Path $path)) { return $b + @{ Path = $path } }
        }
    }
    return $null
}

function Show-ExtensionStep([string]$extDir) {
    try { Set-Clipboard -Value $extDir } catch {}
    $browser = Find-Browser
    if ($browser) {
        try { Start-Process -FilePath $browser.Path -ArgumentList $browser.Url } catch {}
        $name = $browser.Name
    } else {
        $name = "your browser"
    }

    Write-Host ""
    Write-Host "==============================================================" -ForegroundColor Cyan
    Write-Host " One last step: add the extension to $name" -ForegroundColor Cyan
    Write-Host "==============================================================" -ForegroundColor Cyan
    if ($browser) {
        Write-Host "$name is opening its Extensions page. On that page:"
    } else {
        Write-Host "Open chrome://extensions in your browser. On that page:"
    }
    Write-Host "  1. Turn on 'Developer mode'."
    Write-Host "  2. Click 'Load unpacked'."
    Write-Host "  3. Paste (Ctrl+V) into the Folder box and click 'Select Folder'."
    Write-Host "     The path is on your clipboard:"
    Write-Host "       $extDir" -ForegroundColor Yellow
    Write-Host "  4. Check the InnerCider card shows ID $ExtensionId"
    Write-Host ""
    Write-Host "Updating an existing install? Skip those steps and click the reload"
    Write-Host "arrow on the InnerCider card instead (or close and reopen the browser)."
    Write-Host ""
    Write-Host "Then pick your mail app: right-click the InnerCider icon > Options."
    Write-Host "  - Outlook Classic: ready to use."
    Write-Host "  - New Outlook: paste your Azure App Client ID in Options, then click"
    Write-Host "    'Sign in' for a one-time Microsoft account sign-in."
    Write-Host "    See README.md for Azure app registration steps."
    Write-Host ""
    Write-Host "Open a PO on app.innergy.com and click 'Draft Email w/ PDF'."
    Write-Host ""
}

if ($BrowserOnly) {
    Show-ExtensionStep (Get-ExtensionDir $false)
    exit 0
}

# --- Require Administrator ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")
if (-not $isAdmin) {
    Write-Warning "Not running as Administrator. HKLM registration will be skipped."
    Write-Warning "For system-wide Chrome (installed in Program Files), re-run as Administrator."
    Write-Host ""
}

Write-Host ""
Write-Host "=== InnerCider: Windows Installer ===" -ForegroundColor Cyan
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
    Write-Host "Python 3 not found. Downloading and installing Python 3.13..." -ForegroundColor Yellow

    $pyInstaller = "$env:TEMP\python_installer.exe"
    $pyUrl = "https://www.python.org/ftp/python/3.13.0/python-3.13.0-amd64.exe"

    Write-Host "Downloading from $pyUrl ..."
    try {
        Invoke-WebRequest -Uri $pyUrl -OutFile $pyInstaller -UseBasicParsing
    } catch {
        Write-Error "Download failed: $_`nInstall Python 3 manually from https://www.python.org/downloads/"
        exit 1
    }

    Write-Host "Running Python installer (this may take a minute)..."
    # /quiet = silent, InstallAllUsers=0 = per-user, PrependPath=1 = add to PATH
    $proc = Start-Process -FilePath $pyInstaller -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_test=0" -Wait -PassThru
    Remove-Item $pyInstaller -ErrorAction SilentlyContinue

    if ($proc.ExitCode -ne 0) {
        Write-Error "Python installer exited with code $($proc.ExitCode). Install manually from https://www.python.org/downloads/"
        exit 1
    }

    # Refresh PATH so the new python is visible in this session.
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")

    foreach ($candidate in @("python", "python3", "py")) {
        try {
            $path = (Get-Command $candidate -ErrorAction SilentlyContinue).Source
            if (-not $path) { continue }
            $ver = & $path --version 2>&1
            if ($ver -match "Python 3") { $pythonExe = $path; break }
        } catch {}
    }

    if (-not $pythonExe) {
        Write-Error "Python installed but still not found on PATH. Close and reopen PowerShell, then re-run this script."
        exit 1
    }

    Write-Host "Python installed: $pythonExe" -ForegroundColor Green
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
    'description': 'InnerCider native messaging host',
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

# --- Copy the extension to its fixed folder ---
$extSource = Join-Path $scriptDir "extension"
$extDir    = Get-ExtensionDir $isAdmin
if (-not (Test-Path (Join-Path $extSource "manifest.json"))) {
    Write-Error "Extension folder not found: $extSource"
    exit 1
}
if (Test-Path $extDir) { Remove-Item $extDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Split-Path $extDir) | Out-Null
Copy-Item $extSource $extDir -Recurse
Write-Host ""
Write-Host "Extension: $extDir" -ForegroundColor Green

# --- Done ---
Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Cyan

if (-not $SkipBrowser) {
    Show-ExtensionStep $extDir
}
