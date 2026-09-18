# Run from the repository root in PowerShell on a disposable Windows desktop.
param([switch]$Interactive)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Use native Windows PowerShell 7, not WSL.' }
$Root = Resolve-Path (Join-Path $PSScriptRoot '../../..')
$Contract = Get-Content (Join-Path $Root 'scripts/opencode-compatibility.json') -Raw | ConvertFrom-Json
$Work = Join-Path ([IO.Path]::GetTempPath()) ('vim-native-' + [guid]::NewGuid())
$Saved = @{}
$Names = @('HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_CONFIG_PROJECT_DISABLE', 'OPENCODE_DISABLE_PROJECT_CONFIG')
foreach ($Name in $Names) { $Saved[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process') }
New-Item -ItemType Directory $Work | Out-Null
Push-Location (Join-Path $Root 'packages/opencode-vim')
try {
  $PackOutput = & npm.cmd pack --json --pack-destination $Work
  if ($LASTEXITCODE -ne 0) { throw "Packing Vim failed: $PackOutput" }
  $Archive = ($PackOutput | ConvertFrom-Json)[0].filename
  Set-Location $Work
  $Dependencies = @{}
  $Dependencies[$Contract.host.package] = $Contract.host.version
  $Dependencies['@naxodev/opencode-vim'] = 'file:' + (Join-Path $Work $Archive)
  @{ private = $true; dependencies = $Dependencies } | ConvertTo-Json -Depth 5 | Set-Content package.json -Encoding utf8
  & npm.cmd install --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Isolated consumer install failed' }
  & node (Join-Path $Work ('node_modules/' + $Contract.host.package + '/postinstall.mjs'))
  if ($LASTEXITCODE -ne 0) { throw 'Host installation hook failed' }
  $HostCommand = Join-Path $Work 'node_modules/.bin/opencode.cmd'
  $Version = & $HostCommand --version
  if ($LASTEXITCODE -ne 0 -or $Version.Trim() -ne ('opencode v' + $Contract.host.version)) { throw "Unexpected host: $Version" }
  Write-Output "Native host executable verified: $Version"
  if ($Interactive) {
    $env:HOME = $Work
    $env:XDG_CONFIG_HOME = Join-Path $Work 'config'
    $env:XDG_CACHE_HOME = Join-Path $Work 'cache'
    $env:XDG_DATA_HOME = Join-Path $Work 'data'
    $env:XDG_STATE_HOME = Join-Path $Work 'state'
    $env:OPENCODE_DISABLE_AUTOUPDATE = '1'
    $env:OPENCODE_CONFIG_PROJECT_DISABLE = '1'
    $env:OPENCODE_DISABLE_PROJECT_CONFIG = '1'
    $Config = Join-Path $env:XDG_CONFIG_HOME 'opencode'
    New-Item -ItemType Directory -Force $Config | Out-Null
    @{ plugins = @(@{ package = (Join-Path $Work 'node_modules/@naxodev/opencode-vim/dist'); options = @{ clipboard = 'none' } }) } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Config 'cli.json') -Encoding utf8
    Write-Output 'Follow docs/windows-vim-verification.md. Clipboard is disabled in this host. Exit the host to clean up.'
    Write-Output "Temporary consumer: $Work"
    & $HostCommand --standalone $Work
    if ($LASTEXITCODE -ne 0) { throw "Native host exited $LASTEXITCODE" }
  }
} finally {
  foreach ($Name in $Names) { [Environment]::SetEnvironmentVariable($Name, $Saved[$Name], 'Process') }
  Pop-Location
  # PowerShell's provider location and the native process working directory can differ.
  [Environment]::CurrentDirectory = (Get-Location).Path
  for ($Attempt = 0; $Attempt -lt 10; $Attempt++) {
    try { Remove-Item -Recurse -Force $Work; break }
    catch { if ($Attempt -eq 9) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
