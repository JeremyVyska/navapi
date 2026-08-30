[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$scriptsRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $scriptsRoot 'Install-NavApi.ps1'
$launcher = Join-Path $scriptsRoot 'Launch-NavApi.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("navapi-windows-bootstrap-{0}" -f [Guid]::NewGuid())
$localAppData = Join-Path $testRoot 'LocalAppData'
$startMenu = Join-Path $testRoot 'StartMenu'
$stubs = Join-Path $testRoot 'stubs'
$npmLog = Join-Path $testRoot 'npm.log'
$launchLog = Join-Path $testRoot 'launch.log'
$wingetLog = Join-Path $testRoot 'winget.log'

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

function Invoke-PowerShellScript {
    param(
        [string]$Path,
        [string[]]$Arguments
    )

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Path @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Path failed with exit code $LASTEXITCODE"
    }
}

try {
    New-Item -ItemType Directory -Path $localAppData, $startMenu, $stubs -Force | Out-Null
    $profileDir = Join-Path $testRoot '.navapi'
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $profileDir 'profiles.json') -Value 'keep-me'

    $nodeStub = Join-Path $stubs 'node.cmd'
    Set-Content -LiteralPath $nodeStub -Value '@exit /b 0' -Encoding Ascii

    $npmStub = Join-Path $stubs 'npm.cmd'
    @'
@echo %*>>"%NAVAPI_TEST_NPM_LOG%"
@set "prefix="
:parse
@if "%~1"=="" goto install
@if "%~1"=="--prefix" (
  @set "prefix=%~2"
  @shift
)
@shift
@goto parse
:install
@if "%NAVAPI_TEST_NPM_FAIL%"=="1" (
  @if not exist "%prefix%" mkdir "%prefix%"
  @echo @exit /b 99>"%prefix%\navapi.cmd"
  @exit /b 23
)
@if not exist "%prefix%" mkdir "%prefix%"
@(
  @echo @echo %%*^>^>"%%NAVAPI_TEST_LAUNCH_LOG%%"
  @echo @exit /b 0
)>"%prefix%\navapi.cmd"
@exit /b 0
'@ | Set-Content -LiteralPath $npmStub -Encoding Ascii

    $env:NAVAPI_TEST_NPM_LOG = $npmLog
    $env:NAVAPI_TEST_LAUNCH_LOG = $launchLog
    $env:NAVAPI_TEST_NPM_FAIL = '0'

    $installArguments = @(
        '-LocalAppDataPath', $localAppData,
        '-StartMenuProgramsPath', $startMenu,
        '-NodeCommand', $nodeStub,
        '-NpmCommand', $npmStub
    )
    Invoke-PowerShellScript $installer $installArguments
    Invoke-PowerShellScript $installer $installArguments

    $installRoot = Join-Path $localAppData 'navapi'
    Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'Launch-NavApi.ps1')) 'the launcher is installed under LOCALAPPDATA'
    Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'npm\navapi.cmd')) 'the CLI is installed under LOCALAPPDATA'
    Assert-True (Test-Path -LiteralPath (Join-Path $startMenu 'navapi.lnk')) 'the Start Menu shortcut is created'
    Assert-True ((Get-Content -LiteralPath (Join-Path $profileDir 'profiles.json') -Raw).Trim() -eq 'keep-me') 'existing navapi configuration is preserved'
    Assert-True ((Get-Content -LiteralPath $npmLog).Count -eq 2) 'rerunning performs a repair/update'

    $env:NAVAPI_TEST_NPM_FAIL = '1'
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher `
        -InstallRoot $installRoot `
        -LocalAppDataPath $localAppData `
        -NpmCommand $npmStub 3>&1
    Assert-True ($LASTEXITCODE -eq 0) 'an update failure does not prevent launch'
    Assert-True (($output | Out-String) -match 'Could not update navapi') 'an update failure surfaces a warning'
    Assert-True ((Get-Content -LiteralPath $launchLog -Raw) -match 'ui') 'the installed CLI receives the ui command'

    $wingetStub = Join-Path $stubs 'winget.cmd'
    @'
@echo %*>>"%NAVAPI_TEST_WINGET_LOG%"
@copy /y "%NAVAPI_TEST_NODE_SOURCE%" "%NAVAPI_TEST_NODE_TARGET%" >nul
@copy /y "%NAVAPI_TEST_NPM_SOURCE%" "%NAVAPI_TEST_NPM_TARGET%" >nul
@exit /b 0
'@ | Set-Content -LiteralPath $wingetStub -Encoding Ascii
    $installedNodeStub = Join-Path $testRoot 'winget-node.cmd'
    $installedNpmStub = Join-Path $testRoot 'winget-npm.cmd'
    $env:NAVAPI_TEST_WINGET_LOG = $wingetLog
    $env:NAVAPI_TEST_NODE_SOURCE = $nodeStub
    $env:NAVAPI_TEST_NODE_TARGET = $installedNodeStub
    $env:NAVAPI_TEST_NPM_SOURCE = $npmStub
    $env:NAVAPI_TEST_NPM_TARGET = $installedNpmStub
    $env:NAVAPI_TEST_NPM_FAIL = '0'

    Invoke-PowerShellScript $installer @(
        '-InstallRoot', (Join-Path $localAppData 'winget-install'),
        '-LocalAppDataPath', $localAppData,
        '-NodeCommand', $installedNodeStub,
        '-NpmCommand', $installedNpmStub,
        '-WingetCommand', $wingetStub,
        '-SkipShortcut'
    )
    $wingetInvocation = Get-Content -LiteralPath $wingetLog -Raw
    Assert-True ($wingetInvocation -match 'OpenJS.NodeJS.LTS') 'missing node/npm installs the Node.js LTS package'
    Assert-True ($wingetInvocation -match '--scope user') 'winget installation is user-scoped'

    Write-Host 'Windows bootstrap tests passed.'
}
finally {
    Remove-Item Env:NAVAPI_TEST_NPM_LOG -ErrorAction SilentlyContinue
    Remove-Item Env:NAVAPI_TEST_LAUNCH_LOG -ErrorAction SilentlyContinue
    Remove-Item Env:NAVAPI_TEST_NPM_FAIL -ErrorAction SilentlyContinue
    Remove-Item Env:NAVAPI_TEST_WINGET_LOG -ErrorAction SilentlyContinue
    Remove-Item Env:NAVAPI_TEST_NODE_SOURCE -ErrorAction SilentlyContinue
    Remove-Item Env:NAVAPI_TEST_NODE_TARGET -ErrorAction SilentlyContinue
    Remove-Item Env:NAVAPI_TEST_NPM_SOURCE -ErrorAction SilentlyContinue
    Remove-Item Env:NAVAPI_TEST_NPM_TARGET -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
