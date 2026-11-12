import test from 'node:test';
import assert from 'node:assert/strict';
import {isDispatcherMaintenanceChange} from './github.mjs';

test('Muse Git resilience PR is classified as protected infrastructure and not auto-mergeable coding',()=>{
 const files=[
  '.github/workflows/ai-cafe-dev-dispatcher.yml',
  'docs/plans/dispatcher-muse-git-resilience.md',
  'scripts/dev-dispatcher/run.mjs',
  'scripts/dev-dispatcher/git-recovery-transport.mjs',
  'scripts/dev-dispatcher/merged-pr-recovery.mjs'
 ];
 assert.equal(isDispatcherMaintenanceChange(files.map(filename=>({filename}))),true);
 assert.equal(isDispatcherMaintenanceChange([...files,
   'src/app/api/payments/route.ts'].map(filename=>({filename}))),false);
 assert.equal(isDispatcherMaintenanceChange([...files,
   'docs/plans/another-unreviewed-runbook.md'].map(filename=>({filename}))),false);
});
