#!/usr/bin/env node
// One-shot CLI: no model call when the private queue has no eligible task.
import { runOnce } from './bridge.mjs';
const args = process.argv.slice(2);
if (args.length !== 1 || !['--send', '--dry-run'].includes(args[0])) {
  console.error('Usage: node cli.mjs --dry-run | --send');
  process.exitCode = 2;
} else if (args[0] === '--send' && process.env.DAVE_HANDOFF_SEND_ENABLED !== '1') {
  console.error('Live handoff OFF. Requires --send and DAVE_HANDOFF_SEND_ENABLED=1');
  process.exitCode = 2;
} else {
  runOnce({ sendEnabled: args[0] === '--send' && process.env.DAVE_HANDOFF_SEND_ENABLED === '1' })
    .then(x => console.log(JSON.stringify(x)))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
