// Reads the slash commands of the Alran TUI from a checkout of alran-code.
// Used by `pnpm sync:tui` and by the parity test when that checkout exists.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SIBLING = path.resolve(import.meta.dirname, '..', '..', 'alran-code');

export function hasSibling() {
  return existsSync(path.join(SIBLING, 'packages', 'tui', 'src', 'tui', 'commands', 'catalog.ts'));
}

/** Public command names and aliases of the TUI, sorted. */
export function readTuiCommands() {
  const catalog = readFileSync(path.join(SIBLING, 'packages', 'tui', 'src', 'tui', 'commands', 'catalog.ts'), 'utf8');
  const descriptors = readFileSync(path.join(SIBLING, 'packages', 'tui', 'src', 'application', 'command-descriptors.ts'), 'utf8');
  const names = new Set(
    [...catalog.matchAll(/^\s+name: '([a-z-]+)',/gmu), ...descriptors.matchAll(/^\s+name: '([a-z-]+)',/gmu)].map((match) => match[1]),
  );
  const aliases = new Set(
    [...catalog.matchAll(/aliases: \[([^\]]+)\]/gu)].flatMap((match) => [...match[1].matchAll(/'([a-z-]+)'/gu)].map((alias) => alias[1])),
  );
  const version = JSON.parse(readFileSync(path.join(SIBLING, 'package.json'), 'utf8')).version;
  return { alranCodeVersion: version, names: [...names].sort(), aliases: [...aliases].sort() };
}
