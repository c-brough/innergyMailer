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
Write-Host "=== Innergy PO -> Mail: Pack Extension ===" -ForegroundColor Cyan
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
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Chrome Web Store (Option A):"
Write-Host "  1. Go to https://chrome.google.com/webstore/devconsole"
Write-Host "  2. New item -> upload $zipOut"
Write-Host "  3. Set visibility to 'Unlisted' for private distribution"
Write-Host "  4. Share the install link with your users"
Write-Host ""
Write-Host "Enterprise / self-hosted (Option B):"
Write-Host "  1. Host $crxOut on a web server or file share"
Write-Host "  2. Add these registry keys on each machine (or via GPO):"
Write-Host "     HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist\1"
Write-Host "       = akplcachdkpchhcacbbbnkgbfnfgifbn"
Write-Host "     HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallSources\1"
Write-Host "       = <URL to folder containing the .crx>"
Write-Host "  3. Users visit the .crx URL and Chrome installs it without Developer Mode"
Write-Host ""
