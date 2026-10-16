# Builds dist\HandheldCam-<version>.zip: drag it into Content Manager and the
# whole mod is installed (in-game app + phone link + phone web app + a
# private Node runtime), so players need nothing else on the PC.
#
#   powershell -ExecutionPolicy Bypass -File tools\build-release.ps1
#
# Layout inside the zip (what CM expects for a Lua app):
#   apps\lua\HandheldCam\HandheldCam.lua, manifest.ini, icon.png
#   apps\lua\HandheldCam\bridge\      server.js + production node_modules
#   apps\lua\HandheldCam\phone-app\   the web app served to phones
#   apps\lua\HandheldCam\runtime\     node.exe (the game starts the bridge with it)

$ErrorActionPreference = 'Stop'
$NodeVersion = '22.19.0'   # LTS; bump deliberately, the SHA is checked below

$root  = Split-Path -Parent $PSScriptRoot
$dist  = Join-Path $root 'dist'
$cache = Join-Path $dist 'cache'
$stage = Join-Path $dist 'stage'
$app   = Join-Path $stage 'apps\lua\HandheldCam'

$version = (Select-String -Path (Join-Path $root 'lua-app\HandheldCam\manifest.ini') -Pattern '^VERSION\s*=\s*(.+)$').Matches[0].Groups[1].Value.Trim()
Write-Host "Building Handheld Cam $version"

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $app, $cache | Out-Null

# in-game app
Copy-Item (Join-Path $root 'lua-app\HandheldCam\*') $app -Recurse

# phone web app
Copy-Item (Join-Path $root 'phone-app') (Join-Path $app 'phone-app') -Recurse

# bridge with production dependencies only, installed fresh from the lockfile
$bridge = Join-Path $app 'bridge'
New-Item -ItemType Directory -Force $bridge | Out-Null
foreach ($f in 'server.js', 'package.json', 'package-lock.json') {
  Copy-Item (Join-Path $root "bridge\$f") $bridge
}
Push-Location $bridge
try {
  & npm.cmd ci --omit=dev --no-fund --no-audit --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
} finally { Pop-Location }

# private Node runtime (verified against the official checksums)
$nodeExe = Join-Path $cache "node-$NodeVersion.exe"
if (-not (Test-Path $nodeExe)) {
  $base = "https://nodejs.org/dist/v$NodeVersion"
  Write-Host "Downloading Node $NodeVersion..."
  Invoke-WebRequest "$base/win-x64/node.exe" -OutFile "$nodeExe.part" -UseBasicParsing
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $want = ($sums -split "`n" | Where-Object { $_ -match 'win-x64/node\.exe$' }) -replace '\s.*$', ''
  $got = (Get-FileHash "$nodeExe.part" -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $got -ne $want.Trim().ToLower()) { Remove-Item "$nodeExe.part"; throw "node.exe checksum mismatch" }
  Move-Item "$nodeExe.part" $nodeExe
}
New-Item -ItemType Directory -Force (Join-Path $app 'runtime') | Out-Null
Copy-Item $nodeExe (Join-Path $app 'runtime\node.exe')

# quick self-test: the bundled runtime can load the bridge's dependencies
Push-Location $bridge
try {
  & (Join-Path $app 'runtime\node.exe') -e "require('ws');require('qrcode');require('selfsigned');try{require('node-screenshots')}catch(e){console.error('feed module:',e.message)}"
  if ($LASTEXITCODE -ne 0) { throw 'bundled runtime could not load the bridge dependencies' }
} finally { Pop-Location }

$zip = Join-Path $dist "HandheldCam-$version.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
# Not Compress-Archive: on Windows PowerShell 5 it writes backslash entry
# names, which other zip readers (Content Manager included) can mangle.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$out = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  Get-ChildItem $stage -Recurse -File | ForEach-Object {
    $name = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($out, $_.FullName, $name, 'Optimal') | Out-Null
  }
} finally { $out.Dispose() }
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Done: $zip ($mb MB)"
