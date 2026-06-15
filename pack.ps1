# pack.ps1
# Builds two distributable artefacts from the extension/ folder:
#
#   dist/innergy-mailer.zip   -- upload this to the Chrome Web Store
#   dist/innergy-mailer.crx   -- use this for enterprise / self-hosted installs
#
# The .crx is signed with native-host/extension_key.pem (created on first run;
# keep this file safe -- losing it means you can no longer update the .crx).
#
# Usage:
#   .\pack.ps1              # builds both artefacts
#   .\pack.ps1 -StoreOnly   # zip only (no Chrome needed)

param([switch]$StoreOnly)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Innergy Mailer: Pack Extension ===" -ForegroundColor Cyan
Write-Host ""

$scriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$extDir       = Join-Path $scriptDir "extension"
$distDir      = Join-Path $scriptDir "dist"
$keyPath      = Join-Path $scriptDir "native-host\extension_key.pem"
$zipOut       = Join-Path $distDir "innergy-mailer.zip"
$crxOut       = Join-Path $distDir "innergy-mailer.crx"
$manifestPath = Join-Path $extDir "manifest.json"

if (-not (Test-Path $extDir)) {
    Write-Error "extension/ folder not found at $extDir"
    exit 1
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# ---------------------------------------------------------------------------
# 1. ZIP for Chrome Web Store
#    The store requires the extension files zipped directly (no parent folder).
#    The "key" field in manifest.json must be REMOVED for store submissions
#    (the store assigns its own stable ID). We patch it in a temp copy.
# ---------------------------------------------------------------------------
Write-Host "Building store ZIP..." -ForegroundColor Yellow

$tempExt = Join-Path $env:TEMP "innergy_ext_pack"
if (Test-Path $tempExt) { Remove-Item $tempExt -Recurse -Force }
Copy-Item $extDir $tempExt -Recurse

# Strip the "key" field from the temp manifest so the store accepts it.
$manifest = Get-Content (Join-Path $tempExt "manifest.json") -Raw | ConvertFrom-Json
$manifest.PSObject.Properties.Remove("key")
$manifest | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $tempExt "manifest.json") -Encoding utf8

if (Test-Path $zipOut) { Remove-Item $zipOut -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($tempExt, $zipOut)
Remove-Item $tempExt -Recurse -Force

Write-Host "  Store ZIP: $zipOut" -ForegroundColor Green

if ($StoreOnly) {
    Write-Host ""
    Write-Host "Done (store ZIP only)." -ForegroundColor Cyan
    exit 0
}

# ---------------------------------------------------------------------------
# 2. CRX for enterprise / self-hosted installs
#    Chrome's --pack-extension CLI does the signing. It needs a .pem key.
# ---------------------------------------------------------------------------

# Find Chrome.
$chromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)
$chromeExe = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chromeExe) {
    Write-Warning "Chrome not found -- skipping .crx build."
    Write-Warning "Install Chrome or copy chrome.exe path and run:"
    Write-Warning "  chrome.exe --pack-extension=`"$extDir`" --pack-extension-key=`"$keyPath`""
    Write-Host ""
    Write-Host "Done (store ZIP only -- Chrome not found for CRX)." -ForegroundColor Cyan
    exit 0
}

Write-Host "Building CRX with Chrome..." -ForegroundColor Yellow
Write-Host "  Chrome: $chromeExe"

# Chrome writes the .crx and .pem next to the extension folder.
$crxTemp = Join-Path $scriptDir "extension.crx"
$pemTemp = Join-Path $scriptDir "extension.pem"

$args = @("--pack-extension=`"$extDir`"")
if (Test-Path $keyPath) {
    Write-Host "  Using existing key: $keyPath"
    $args += "--pack-extension-key=`"$keyPath`""
} else {
    Write-Host "  No key found -- Chrome will generate a new one." -ForegroundColor Yellow
}

$proc = Start-Process -FilePath $chromeExe -ArgumentList $args -Wait -PassThru -WindowStyle Hidden
if ($proc.ExitCode -ne 0) {
    Write-Warning "Chrome exited with code $($proc.ExitCode). CRX may not have been created."
}

# Move outputs to dist/ and save key to native-host/ for future use.
if (Test-Path $crxTemp) {
    Move-Item $crxTemp $crxOut -Force
    Write-Host "  CRX: $crxOut" -ForegroundColor Green
} else {
    Write-Warning "CRX file not found after packing. Check Chrome output."
}

if (Test-Path $pemTemp) {
    Move-Item $pemTemp $keyPath -Force
    Write-Host "  Key saved: $keyPath  <-- keep this file safe!" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 3. Windows native host installer ZIP (for GitHub Releases)
#    Contains everything a Windows user needs to install the native host.
# ---------------------------------------------------------------------------
Write-Host "Building Windows installer ZIP..." -ForegroundColor Yellow

$winZipOut  = Join-Path $distDir "innergy-mailer-windows-installer.zip"
$tempWinDir = Join-Path $env:TEMP "innergy_win_installer"
if (Test-Path $tempWinDir) { Remove-Item $tempWinDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tempWinDir | Out-Null

# Copy everything the installer needs.
Copy-Item (Join-Path $scriptDir "install.bat")          $tempWinDir
Copy-Item (Join-Path $scriptDir "install_windows.ps1")  $tempWinDir
Copy-Item (Join-Path $scriptDir "native-host\innergy_mailer_host_win.py") $tempWinDir

if (Test-Path $winZipOut) { Remove-Item $winZipOut -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($tempWinDir, $winZipOut)
Remove-Item $tempWinDir -Recurse -Force

Write-Host "  Windows installer ZIP: $winZipOut" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Files created in dist/:"
Write-Host "  innergy-mailer.zip                  -> Chrome Web Store upload"
Write-Host "  innergy-mailer-windows-installer.zip -> attach to GitHub Release"
if (Test-Path $crxOut) {
Write-Host "  innergy-mailer.crx                  -> enterprise self-hosted install"
}
Write-Host ""
Write-Host "Deployment steps:"
Write-Host "  1. Upload innergy-mailer.zip to https://chrome.google.com/webstore/devconsole"
Write-Host "     Set visibility to Unlisted. Copy the install URL."
Write-Host ""
Write-Host "  2. Create a GitHub Release (git tag v1.0.0, push, then create release)"
Write-Host "     Attach innergy-mailer-windows-installer.zip as a release asset."
Write-Host ""
Write-Host "  3. Send customers two links:"
Write-Host "     - Chrome Web Store install URL"
Write-Host "     - GitHub Release download URL for the Windows installer ZIP"
Write-Host "     They unzip the installer, double-click install.bat, done."
Write-Host ""
