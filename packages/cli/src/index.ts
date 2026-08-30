import { HttpError, NavApiError } from '@navapi/core';
import pc from 'picocolors';
import { buildProgram } from './program.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    if (err instanceof HttpError) {
      console.error(pc.red(`error: ${err.message}${err.code ? pc.dim(` [${err.code}]`) : ''}`));
    } else if (err instanceof NavApiError) {
      console.error(pc.red(`error: ${err.message}`));
    } else {
      console.error(pc.red(`unexpected error: ${err instanceof Error ? err.stack : String(err)}`));
    }
    process.exit(1);
  });
