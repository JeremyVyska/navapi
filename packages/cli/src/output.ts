import pc from 'picocolors';

/** JSON when asked for, or whenever stdout is not a TTY (pipes get JSON automatically). */
export function wantJson(jsonFlag?: boolean): boolean {
  return Boolean(jsonFlag) || !process.stdout.isTTY;
}

export function emitJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

const PREFERRED_COLUMNS = ['number', 'displayName', 'name', 'code', 'status', 'id'];
const MAX_AUTO_COLUMNS = 6;
const MAX_CELL = 40;

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}

/** Picks readable columns: preferred well-known fields first, then whatever else fits. */
function pickColumns(rows: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key.startsWith('@') || keys.includes(key)) continue;
      keys.push(key);
    }
  }
  const preferred = PREFERRED_COLUMNS.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !preferred.includes(k));
  return [...preferred, ...rest].slice(0, MAX_AUTO_COLUMNS);
}

export function printTable(rows: Record<string, unknown>[], columns?: string[]): void {
  if (!rows.length) {
    console.log(pc.dim('(no rows)'));
    return;
  }
  const cols = columns ?? pickColumns(rows);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (cells: string[], style?: (s: string) => string) => {
    const text = cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
    console.log(style ? style(text) : text);
  };
  line(cols, pc.bold);
  line(
    widths.map((w) => '─'.repeat(w)),
    pc.dim,
  );
  for (const row of rows) {
    line(cols.map((c) => cell(row[c])));
  }
}

/** Prints one record as aligned key/value lines, skipping @odata noise. */
export function printRecord(record: Record<string, unknown>): void {
  const keys = Object.keys(record).filter((k) => !k.startsWith('@'));
  const width = Math.max(...keys.map((k) => k.length), 0);
  for (const key of keys) {
    console.log(`${pc.bold(key.padEnd(width))}  ${cell(record[key])}`);
  }
}

/** Lays names out in terminal-width columns, like `ls`. */
export function columnize(names: string[], indent = '  '): void {
  if (!names.length) return;
  const termWidth = process.stdout.columns ?? 100;
  const colWidth = Math.max(...names.map((n) => n.length)) + 2;
  const perRow = Math.max(1, Math.floor((termWidth - indent.length) / colWidth));
  for (let i = 0; i < names.length; i += perRow) {
    console.log(
      indent +
        names
          .slice(i, i + perRow)
          .map((n) => n.padEnd(colWidth))
          .join('')
          .trimEnd(),
    );
  }
}

export function fail(message: string): never {
  console.error(pc.red(`error: ${message}`));
  process.exit(1);
}
