# Windows bootstrap

`Install-NavApi.ps1` installs the navapi CLI beneath the current user's `%LOCALAPPDATA%\navapi` folder and creates a **navapi** Start Menu shortcut. It does not require elevation and does not modify profiles, secrets, or caches in `~/.navapi`.

For end-user download instructions, see
[Install and run the navapi web UI](../../docs/ui.md#windows-start-menu-installation).

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-NavApi.ps1
```

The shortcut runs `Launch-NavApi.ps1`. The launcher tries to update `@navapi/cli` before opening `navapi ui`; if npm is offline or the update fails, it warns and starts the installed version.

If Node.js and npm are unavailable, the installer uses `winget` to install the current-user Node.js LTS package. Organizations that block `winget`, npm, or downloaded PowerShell scripts must install Node.js and `@navapi/cli` through their approved software-distribution process.
