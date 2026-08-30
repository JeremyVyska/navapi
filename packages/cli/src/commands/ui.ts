import { startUiServer } from '@navapi/ui';
import type { Command } from 'commander';
import pc from 'picocolors';

function positiveSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Idle timeout must be a positive number of seconds.');
  }
  return seconds;
}

export function registerUi(program: Command): void {
  program
    .command('ui')
    .description('Open the secure local navapi web interface')
    .option('--no-open', 'Start the server without opening the default browser')
    .option('--port <port>', 'Use a specific loopback port', (value) => {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('Port must be an integer from 0 to 65535.');
      }
      return port;
    })
    .option(
      '--idle-timeout <seconds>',
      'Stop after this many seconds without a browser heartbeat (default: 120)',
      positiveSeconds,
    )
    .option('--json', 'Print machine-readable startup information')
    .action(async (opts, command) => {
      const globals = command.optsWithGlobals();
      const server = await startUiServer({
        profile: globals.profile,
        port: opts.port,
        open: opts.open,
        idleTimeoutMs: opts.idleTimeout ? opts.idleTimeout * 1000 : undefined,
      });
      const publicUrl = server.url.replace(/#.*$/, '');
      const displayedUrl = opts.open ? publicUrl : server.url;
      if (opts.json) {
        console.log(
          JSON.stringify({
            url: displayedUrl,
            port: server.port,
            alreadyRunning: server.alreadyRunning,
          }),
        );
      } else {
        const verb = server.alreadyRunning ? 'Opened existing' : 'Started';
        console.log(`${pc.green('✔')} ${verb} navapi UI at ${pc.cyan(displayedUrl)}`);
        if (!opts.open) {
          console.log(
            pc.dim(
              'Browser opening disabled. Treat this authenticated, process-scoped URL as a secret.',
            ),
          );
        }
      }
      if (server.alreadyRunning) return;

      const stop = () => void server.close();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        await server.closed;
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    });
}
