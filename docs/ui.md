# Install and run the navapi web UI

The navapi UI is a local web application included with `@navapi/cli`. It uses the
same profiles, companies, metadata cache, and secrets as the CLI, VS Code
extension, and MCP server.

## Install with npm

Install Node.js 20 or later, then install the navapi CLI:

```bash
npm install --global @navapi/cli
```

Create a Business Central profile if you do not already have one:

```bash
navapi profile add contoso-prod \
  --tenant <tenant-id> \
  --client-id <client-id> \
  --environment Production \
  --company "CRONUS International Ltd."
```

The command prompts for the client secret. Existing profiles created by the CLI
or VS Code extension appear automatically in the UI.

Start the UI:

```bash
navapi ui
```

The command starts an authenticated server on `127.0.0.1`, opens the default
browser, and stops after browser heartbeats have been absent for two minutes.
Closing the browser tab therefore stops the server shortly afterward.

Useful options:

```bash
navapi --profile contoso-prod ui
navapi ui --port 8080
navapi ui --idle-timeout 600
navapi ui --no-open
```

`--no-open` prints the authenticated URL instead. Treat that URL as a secret:
anyone who has it while the process is running can access the local UI.

## Windows Start Menu installation

The user-scoped Windows installer adds a **navapi** Start Menu shortcut and does
not require administrator rights. Download both scripts into the same temporary
folder, inspect them if required by your organization, and run the installer:

```powershell
$source = 'https://raw.githubusercontent.com/JeremyVyska/navapi/main/scripts/windows'
$installer = Join-Path $env:TEMP 'navapi-installer'
New-Item -ItemType Directory -Path $installer -Force | Out-Null
Invoke-WebRequest "$source/Install-NavApi.ps1" -OutFile (Join-Path $installer 'Install-NavApi.ps1')
Invoke-WebRequest "$source/Launch-NavApi.ps1" -OutFile (Join-Path $installer 'Launch-NavApi.ps1')
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installer 'Install-NavApi.ps1')
```

The installer places navapi under `%LOCALAPPDATA%\navapi`. If Node.js is
missing, it uses `winget` to install the current-user Node.js LTS package.
Organizations that block `winget`, npm, or downloaded PowerShell scripts should
use their approved software-distribution process instead.

The shortcut checks npm for an updated CLI before each launch. If that update
fails, it warns and starts the installed version.

## Headless Linux and SSH

Use `--no-open` and open the printed URL from a browser that can reach the
loopback server through your SSH tunnel:

```bash
NAVAPI_SECRET_BACKEND=file navapi ui --no-open
```

Without a desktop D-Bus session, Linux automatically uses
`~/.navapi/secrets.json`. Setting `NAVAPI_SECRET_BACKEND=file` makes that choice
explicit. Protect the configuration directory with the permissions of your user
account.

## Update or uninstall

Update an npm installation:

```bash
npm install --global @navapi/cli@latest
```

Uninstall it:

```bash
npm uninstall --global @navapi/cli
```

For the Windows Start Menu installation, remove `%LOCALAPPDATA%\navapi` and the
**navapi** shortcut from the current user's Start Menu. Profile data remains in
`~/.navapi` unless you remove it separately.
