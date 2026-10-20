// JSON-lines logger. Never pass keys, cookies or passwords in fields.
export type Level = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface Logger {
  info(event: string, fields?: object): void;
  warn(event: string, fields?: object): void;
  error(event: string, fields?: object): void;
  critical(event: string, fields?: object): void;
}

export function jsonLogger(write: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const emit = (level: Level) => (event: string, fields: object = {}) =>
    write(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }));
  return { info: emit('info'), warn: emit('warn'), error: emit('error'), critical: emit('critical') };
}

/** Collects lines in memory (tests). */
export function memoryLogger(): Logger & { lines: { level: Level; event: string; fields: object }[] } {
  const lines: { level: Level; event: string; fields: object }[] = [];
  const emit = (level: Level) => (event: string, fields: object = {}) => void lines.push({ level, event, fields });
  return { lines, info: emit('info'), warn: emit('warn'), error: emit('error'), critical: emit('critical') };
}
