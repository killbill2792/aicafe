#!/usr/bin/env node
// One-shot: use an external cron/systemd timer; idle runs make ZERO model calls.
import { runOnce } from './bridge.mjs';
const send = process.argv.includes('--send');
if (process.argv.some(a => !['--send', '--dry-run'].includes(a))) {
  console.error('Usage: node cli.mjs --dry-run | --send');
  process.exitCode = 2;
} else if (send && process.env.DAVE_HANDOFF_SEND_ENABLED !== '1') {
  console.error('Live handoff OFF. Requires --send and DAVE_HANDOFF_SEND_ENABLED=1');
  process.exitCode = 2;
} else {
  runOnce({ sendEnabled: send && process.env.DAVE_HANDOFF_SEND_ENABLED === '1' })
    .then(x => console.log(JSON.stringify(x)))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
