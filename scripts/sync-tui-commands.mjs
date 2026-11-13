// Refreshes test/fixtures/tui-commands.json from a sibling alran-code checkout.
// The parity test reads that file, so the extension's tests need no other repository.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { hasSibling, readTuiCommands, SIBLING } from './tui-commands.mjs';

if (!hasSibling()) {
  console.error(`No alran-code checkout at ${SIBLING}. Clone it next to this repository and run again.`);
  process.exit(1);
}
const commands = readTuiCommands();
const target = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'tui-commands.json');
writeFileSync(target, `${JSON.stringify(commands, null, 2)}\n`);
console.log(`${target}: ${commands.names.length} commands, ${commands.aliases.length} aliases (alran-code ${commands.alranCodeVersion})`);
