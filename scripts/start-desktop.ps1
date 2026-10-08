[CmdletBinding()]
param(
    [string]$Url,
    [string]$DshHome,
    [switch]$Wait
)

$ErrorActionPreference = 'Stop'
$pluginRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$portableExe = Join-Path $pluginRoot 'dist\FatWhaleCompanion-win32-x64\WhaleCompanion.exe'
$electronExe = Join-Path $pluginRoot 'desktop\node_modules\electron\dist\electron.exe'
$desktopPath = Join-Path $pluginRoot 'desktop'

if (Test-Path -LiteralPath $portableExe -PathType Leaf) {
    $program = $portableExe
    $launchArguments = @()
} elseif (Test-Path -LiteralPath $electronExe -PathType Leaf) {
    $program = $electronExe
    $launchArguments = @('"' + $desktopPath + '"')
} else {
    throw "Desktop runtime is missing. Run npm --prefix `"$desktopPath`" install, or use the portable build."
}

if ($Url) {
    $parsedUrl = [Uri]$Url
    if ($parsedUrl.Scheme -notin @('http', 'https') -or -not $parsedUrl.IsLoopback -or $parsedUrl.UserInfo) {
        throw 'Url must be an HTTP(S) address on this computer, without credentials.'
    }
    $launchArguments += @('--url', $parsedUrl.GetLeftPart([UriPartial]::Authority))
}
if ($DshHome) {
    $resolvedHome = [System.IO.Path]::GetFullPath($DshHome)
    if ($resolvedHome.Contains('"')) { throw 'DSH home contains an invalid quote character.' }
    $launchArguments += @('--home', '"' + $resolvedHome + '"')
}

# A DSH launcher may set this variable for its bundled Node runtime. Keep that
# inherited setting out of this child process, then restore it immediately.
$oldRunAsNode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
try {
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'Process')
    $startOptions = @{
        FilePath = $program
        WorkingDirectory = $pluginRoot
        WindowStyle = 'Hidden'
        PassThru = $true
    }
    if ($launchArguments.Count -gt 0) { $startOptions.ArgumentList = $launchArguments }
    if ($Wait) { $startOptions.Wait = $true }
    $petProcess = Start-Process @startOptions
} finally {
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $oldRunAsNode, 'Process')
}
Write-Host "Desktop pet started (PID $($petProcess.Id)). Right-click the whale or tray icon to exit."
