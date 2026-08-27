[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$LocalAppDataPath = $env:LOCALAPPDATA,
    [string]$StartMenuProgramsPath,
    [string]$NodeCommand = 'node.exe',
    [string]$NpmCommand = 'npm.cmd',
    [string]$WingetCommand = 'winget.exe',
    [string]$PowerShellCommand = 'powershell.exe',
    [switch]$SkipShortcut,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Step {
    param([string]$Message)

    Write-Host "navapi: $Message"
}

function Resolve-ExternalCommand {
    param([string]$Command)

    if ([System.IO.Path]::IsPathRooted($Command) -and (Test-Path -LiteralPath $Command -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $Command).Path
    }

    $resolved = Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $resolved) {
        return $resolved.Source
    }

    return $null
}

function Invoke-CheckedCommand {
    param(
        [string]$Command,
        [string[]]$Arguments,
        [string]$FailureMessage
    )

    Write-Step "$Command $($Arguments -join ' ')"
    if ($DryRun) {
        return
    }

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code $LASTEXITCODE)."
    }
}

if ([string]::IsNullOrWhiteSpace($LocalAppDataPath)) {
    throw 'LOCALAPPDATA is not set. Pass -LocalAppDataPath to select the current user installation area.'
}

$localRoot = [System.IO.Path]::GetFullPath($LocalAppDataPath)
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $localRoot 'navapi'
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

$relativeInstallPath = $InstallRoot.Substring(0, [Math]::Min($InstallRoot.Length, $localRoot.Length))
if (-not $relativeInstallPath.Equals($localRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    ($InstallRoot.Length -gt $localRoot.Length -and $InstallRoot[$localRoot.Length] -ne [System.IO.Path]::DirectorySeparatorChar)) {
    throw "InstallRoot must be under the current user's LOCALAPPDATA directory: $localRoot"
}

$npmPrefix = Join-Path $InstallRoot 'npm'
$installedLauncher = Join-Path $InstallRoot 'Launch-NavApi.ps1'
$launcherSource = Join-Path $PSScriptRoot 'Launch-NavApi.ps1'

if (-not (Test-Path -LiteralPath $launcherSource -PathType Leaf)) {
    throw "Launcher template was not found: $launcherSource"
}

$nodePath = Resolve-ExternalCommand $NodeCommand
$npmPath = Resolve-ExternalCommand $NpmCommand
if ($null -eq $nodePath -or $null -eq $npmPath) {
    $wingetPath = Resolve-ExternalCommand $WingetCommand
    if ($null -eq $wingetPath) {
        throw 'Node.js and npm are required, and winget was not found. Install Node.js LTS for the current user and rerun this script.'
    }

    Invoke-CheckedCommand $wingetPath @(
        'install',
        '--id', 'OpenJS.NodeJS.LTS',
        '--exact',
        '--scope', 'user',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity'
    ) 'winget could not install Node.js LTS for the current user'

    if (-not $DryRun) {
        $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $env:Path = "$machinePath;$userPath"
        $nodePath = Resolve-ExternalCommand $NodeCommand
        $npmPath = Resolve-ExternalCommand $NpmCommand
        if ($null -eq $nodePath -or $null -eq $npmPath) {
            throw 'Node.js LTS installation completed, but node/npm are not available yet. Open a new terminal and rerun this script.'
        }
    }
    else {
        $npmPath = $NpmCommand
    }
}

Write-Step "Installing @navapi/cli for the current user in $npmPrefix"
if (-not $DryRun) {
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $npmPrefix -Force | Out-Null
}
Invoke-CheckedCommand $npmPath @(
    'install',
    '--global',
    '--prefix', $npmPrefix,
    '@navapi/cli@latest'
) 'npm could not install @navapi/cli'

if (-not $DryRun) {
    Copy-Item -LiteralPath $launcherSource -Destination $installedLauncher -Force
}

if (-not $SkipShortcut) {
    if ([string]::IsNullOrWhiteSpace($StartMenuProgramsPath)) {
        $StartMenuProgramsPath = [Environment]::GetFolderPath('Programs')
    }
    if ([string]::IsNullOrWhiteSpace($StartMenuProgramsPath)) {
        throw 'The current user Start Menu folder could not be located. Pass -StartMenuProgramsPath or use -SkipShortcut.'
    }

    $shortcutPath = Join-Path $StartMenuProgramsPath 'navapi.lnk'
    Write-Step "Creating Start Menu shortcut $shortcutPath"
    if (-not $DryRun) {
        New-Item -ItemType Directory -Path $StartMenuProgramsPath -Force | Out-Null
        $powerShellPath = Resolve-ExternalCommand $PowerShellCommand
        if ($null -eq $powerShellPath) {
            throw "PowerShell could not be found: $PowerShellCommand"
        }

        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $powerShellPath
        $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$installedLauncher`""
        $shortcut.WorkingDirectory = $InstallRoot
        $shortcut.Description = 'Update and launch navapi'
        $shortcut.Save()
    }
}

Write-Step 'Installation complete. Existing profiles, secrets, and caches in ~/.navapi were not changed.'
