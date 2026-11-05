# Starts PocketBase. It serves the app from pb_public and applies pb_migrations automatically.
# Listens on all interfaces so your phone can reach it on the LAN / tailnet.
Set-Location $PSScriptRoot
if (-not (Test-Path .\pocketbase.exe)) { Write-Host "pocketbase.exe not found - run .\setup.ps1 first"; exit 1 }
.\pocketbase.exe serve --http=0.0.0.0:8090
