[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$LocalAppDataPath = $env:LOCALAPPDATA,
    [string]$NpmCommand = 'npm.cmd',
    [string]$NavApiCommand,
    [string[]]$LaunchArguments = @('ui'),
    [switch]$SkipUpdate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ([string]::IsNullOrWhiteSpace($LocalAppDataPath)) {
    Write-Error 'LOCALAPPDATA is not set. Pass -LocalAppDataPath to locate the navapi installation.'
    exit 1
}
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $LocalAppDataPath 'navapi'
}

$npmPrefix = Join-Path $InstallRoot 'npm'
$updatePrefix = Join-Path $InstallRoot 'npm-update'
$backupPrefix = Join-Path $InstallRoot 'npm-backup'
if ([string]::IsNullOrWhiteSpace($NavApiCommand)) {
    $NavApiCommand = Join-Path $npmPrefix 'navapi.cmd'
}

if (-not $SkipUpdate) {
    try {
        if (Test-Path -LiteralPath $updatePrefix) {
            Remove-Item -LiteralPath $updatePrefix -Recurse -Force
        }
        & $NpmCommand install --global --prefix $updatePrefix '@navapi/cli@latest'
        if ($LASTEXITCODE -ne 0) {
            throw "npm exited with code $LASTEXITCODE"
        }
        $updatedCommand = Join-Path $updatePrefix 'navapi.cmd'
        if (-not (Test-Path -LiteralPath $updatedCommand -PathType Leaf)) {
            throw "npm completed without creating '$updatedCommand'"
        }

        if (Test-Path -LiteralPath $backupPrefix) {
            Remove-Item -LiteralPath $backupPrefix -Recurse -Force
        }
        if (Test-Path -LiteralPath $npmPrefix) {
            Move-Item -LiteralPath $npmPrefix -Destination $backupPrefix
        }
        try {
            Move-Item -LiteralPath $updatePrefix -Destination $npmPrefix
        }
        catch {
            if ((-not (Test-Path -LiteralPath $npmPrefix)) -and (Test-Path -LiteralPath $backupPrefix)) {
                Move-Item -LiteralPath $backupPrefix -Destination $npmPrefix
            }
            throw
        }
        if (Test-Path -LiteralPath $backupPrefix) {
            Remove-Item -LiteralPath $backupPrefix -Recurse -Force
        }
    }
    catch {
        if ((-not (Test-Path -LiteralPath $npmPrefix)) -and (Test-Path -LiteralPath $backupPrefix)) {
            Move-Item -LiteralPath $backupPrefix -Destination $npmPrefix
        }
        if (Test-Path -LiteralPath $updatePrefix) {
            Remove-Item -LiteralPath $updatePrefix -Recurse -Force
        }
        Write-Warning "Could not update navapi to the latest version: $($_.Exception.Message). Continuing with the installed version."
    }
}

if (-not (Test-Path -LiteralPath $NavApiCommand -PathType Leaf)) {
    Write-Error "navapi is not installed at '$NavApiCommand'. Rerun Install-NavApi.ps1 to repair the installation."
    exit 1
}

& $NavApiCommand @LaunchArguments
exit $LASTEXITCODE
