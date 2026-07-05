/** Pure helper for the MCP server-definition provider (no vscode imports). */

/**
 * Environment for the bundled MCP server subprocess that VS Code launches for
 * Copilot agent mode. Points it at the shared config dir (so it reads the same
 * profiles/secrets as the CLI) and the currently-active profile.
 * `ELECTRON_RUN_AS_NODE` makes the editor's own binary run the script as plain
 * Node.js when the command is `process.execPath`.
 */
export function mcpServerEnv(
  profileName: string | undefined,
  configDir: string,
): Record<string, string | number | null> {
  const env: Record<string, string | number | null> = {
    ELECTRON_RUN_AS_NODE: '1',
    NAVAPI_CONFIG_DIR: configDir,
  };
  if (profileName) env.NAVAPI_PROFILE = profileName;
  return env;
}
