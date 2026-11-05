# Downloads the latest PocketBase release for Windows into this folder.
# Usage:  powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$release = Invoke-RestMethod "https://api.github.com/repos/pocketbase/pocketbase/releases/latest" -Headers @{ "User-Agent" = "tempotune-setup" }
$asset = $release.assets | Where-Object { $_.name -like "*_windows_amd64.zip" } | Select-Object -First 1
if (-not $asset) { throw "Could not find a Windows build in the latest PocketBase release." }

Write-Host "Downloading PocketBase $($release.tag_name) ..."
$zip = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $zip
Expand-Archive $zip -DestinationPath $PSScriptRoot -Force
Remove-Item $zip

Write-Host ""
Write-Host "Done. Start the server with:  .\start.ps1"
