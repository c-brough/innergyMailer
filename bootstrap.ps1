# InnerCider one-line installer for Windows.
#
# Downloads the extension + native host straight from GitHub (no git needed) and
# runs the Windows installer. Public repo, so no sign-in.
#
#   irm https://raw.githubusercontent.com/c-brough/innergyMailer/main/bootstrap.ps1 | iex
#
# Pick a branch (default: main) by setting an env var first:
#   $env:INNERCIDER_BRANCH="one-click-installers"; irm https://raw.githubusercontent.com/c-brough/innergyMailer/main/bootstrap.ps1 | iex

$ErrorActionPreference = "Stop"
$Repo = "c-brough/innergyMailer"
$Branch = if ($env:INNERCIDER_BRANCH) { $env:INNERCIDER_BRANCH } else { "main" }

$tmp = Join-Path $env:TEMP ("innercider-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp "src.zip"
  $url = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
  Write-Host "Downloading InnerCider ($Branch) from GitHub..."
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like "innergyMailer-*" } | Select-Object -First 1
  if (-not $src) { throw "Download/extract failed (is the branch name '$Branch' correct?)." }
  Write-Host "Running the installer..."
  Set-Location $src.FullName
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\install_windows.ps1"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
