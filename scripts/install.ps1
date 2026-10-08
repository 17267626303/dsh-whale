[CmdletBinding()]
param(
    [ValidateSet('desktop', 'web')]
    [string]$Profile = 'desktop',
    [string]$DshHome,
    [string]$PackagePath,
    [switch]$ShowFolder
)

$ErrorActionPreference = 'Stop'
$pluginRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $PackagePath) { $PackagePath = $pluginRoot }
$packageTarget = (Resolve-Path -LiteralPath $PackagePath).Path

if ($Profile -eq 'desktop') {
    # DSH intentionally reserves the desktop profile for its native plugin manager.
    # Never edit its package.json, patch layers, lockfile, or application source here.
    Write-Host ''
    Write-Host 'Install in DeepSeek DSH Desktop:'
    Write-Host '  Settings -> Plugins -> Add plugin -> Package name or address'
    Write-Host '  Paste this absolute local directory (or the generated .tgz):'
    Write-Host ''
    Write-Host "  $packageTarget" -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'Choose Enable now. Restart DSH if its plugin manager asks.'
    Write-Host 'Then run scripts/start-desktop.ps1 to show the desktop pet.'
    Write-Host 'Desktop profiles are managed by the app; dsh plugin --profile desktop is not supported.'
    if ($DshHome) {
        Write-Host "For a custom DSH home, pass -DshHome `"$DshHome`" to start-desktop.ps1 too."
    }
    if ($ShowFolder) {
        $folder = if (Test-Path -LiteralPath $packageTarget -PathType Container) { $packageTarget } else { Split-Path -Parent $packageTarget }
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $folder + '"') | Out-Null
    }
    exit 0
}

$dshCommand = Get-Command dsh -ErrorAction Stop
$oldDshHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')
try {
    if ($DshHome) {
        [Environment]::SetEnvironmentVariable('DSH_HOME', [System.IO.Path]::GetFullPath($DshHome), 'Process')
    }
    & $dshCommand.Source plugin --profile web add $packageTarget
    if ($LASTEXITCODE -ne 0) { throw "DSH plugin installation failed (exit $LASTEXITCODE)." }
} finally {
    [Environment]::SetEnvironmentVariable('DSH_HOME', $oldDshHome, 'Process')
}
Write-Host 'Web profile plugin installed. Restart the DSH web profile, then start the desktop pet.'
