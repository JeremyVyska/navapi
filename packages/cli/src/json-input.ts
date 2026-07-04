import { readFile } from 'node:fs/promises';
import { NavApiError } from '@navapi/core';

/** Reads JSON from inline text, a file path, or stdin (`-`). */
export async function readJsonSource(source: string): Promise<unknown> {
  let text: string;
  if (source === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    text = Buffer.concat(chunks).toString('utf8');
  } else if (source.trimStart().startsWith('{') || source.trimStart().startsWith('[')) {
    text = source;
  } else {
    text = await readFile(source, 'utf8');
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new NavApiError(`Not valid JSON (${source === '-' ? 'stdin' : source})`, { cause });
  }
}
