# CCDX release bootstrap. Uses current Windows proxy, certificate and script policy.
param([switch]$AllowRemote)
$ErrorActionPreference = 'Stop'
$version = '1.2.1'
$base = "https://github.com/DaleXiao/codex-copilot-dx/releases/download/v$version"
$work = Join-Path ([IO.Path]::GetTempPath()) ('ccdx-bootstrap-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
function Download($url, $file) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file -TimeoutSec 300 }
function FileHash($file) {
  $stream = [IO.File]::OpenRead($file)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
$privateRuntime = $false
try {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $compatible = $false
  if ($nodeCommand -and $npmCommand) {
    & $nodeCommand.Source -e 'const [a,b]=process.versions.node.split(String.fromCharCode(46)).map(Number);process.exit(a>22||a===22&&b>=15?0:1)'
    $compatible = $LASTEXITCODE -eq 0
  }
  if ($compatible) {
    $node = $nodeCommand.Source
    $npmCli = Join-Path (Split-Path $npmCommand.Source) 'node_modules/npm/bin/npm-cli.js'
    if (!(Test-Path -LiteralPath $npmCli)) { throw 'Cannot locate npm-cli.js beside npm.cmd. Keep this Node/npm setup and use npm.cmd install -g codex-copilot-dx.' }
    $prefix = (& $node $npmCli prefix --global).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the configured npm prefix.' }
  } else {
    $privateRuntime = $true
    $prefix = if ($env:npm_config_prefix) { $env:npm_config_prefix } else { Join-Path $env:LOCALAPPDATA 'CCDX' }
    $architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
    if (!$architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    switch ($architecture.ToUpperInvariant()) {
      'AMD64' { $arch = 'x64'; $hash = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3' }
      'ARM64' { $arch = 'arm64'; $hash = '3a5c209a5bc59e65b3bc0fa13ed5e166a26bd3d55332847f498b76b037408d61' }
      default { throw 'No tested private Node build for this Windows architecture. Use an approved 64-bit Node 22.15+ distribution.' }
    }
    $runtimeName = "node-v24.22.0-win-$arch"
    $runtime = Join-Path $prefix "runtime/$runtimeName"
    $node = Join-Path $runtime 'node.exe'
    $npmCli = Join-Path $runtime 'node_modules/npm/bin/npm-cli.js'
    if (!(Test-Path -LiteralPath $node)) {
      Write-Host 'Downloading official Node 24.22.0 for CCDX only...'
      $archive = Join-Path $work 'node.zip'
      Download "https://nodejs.org/dist/v24.22.0/$runtimeName.zip" $archive
      if ((FileHash $archive) -ne $hash) { throw 'Node checksum mismatch. Installation stopped.' }
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [IO.Compression.ZipFile]::ExtractToDirectory($archive, $work)
      & (Join-Path $work "$runtimeName/node.exe") --version | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'The downloaded Node cannot run on this device.' }
      New-Item -ItemType Directory -Path (Split-Path $runtime) -Force | Out-Null
      Move-Item -LiteralPath (Join-Path $work $runtimeName) -Destination $runtime
    }
  }
  $manifest = Join-Path $work 'SHA256SUMS'
  $helper = Join-Path $work 'ccdx-install.mjs'
  Download "$base/SHA256SUMS" $manifest
  Download "$base/ccdx-install.mjs" $helper
  $lines = @(Get-Content -LiteralPath $manifest | Where-Object { $_ -match '^[a-f0-9]{64}  ccdx-install\.mjs$' })
  if ($lines.Count -ne 1 -or (FileHash $helper) -ne $lines[0].Substring(0,64)) { throw 'Installer checksum mismatch. Installation stopped.' }
  $arguments = @($helper, "v$version", $prefix, $npmCli)
  if ($privateRuntime) { $arguments += '--private-runtime' }
  if ($AllowRemote) { $arguments += '--allow-remote' }
  & $node @arguments
  if ($LASTEXITCODE -ne 0) { throw 'CCDX installation failed. See the error above; no source or security policy was changed.' }
  Write-Host "Start CCDX: & '$prefix\ccdx.cmd'"
  if ($privateRuntime) { Write-Host "For the ccdx command, add $prefix to your PATH. Existing PATH was preserved." }
} finally { Remove-Item -LiteralPath $work -Recurse -Force }
