import test from 'node:test';
import assert from 'node:assert/strict';
import {assessDispatcherHeartbeat} from './heartbeat-probe.mjs';

test('Muse external heartbeat uses verified schedule evidence, not unrelated ledger writes',()=>{
 const now='2026-11-11T17:20:00Z';
 const healthy={schedule_health:{last_schedule_at:'2026-11-11T17:08:00Z'},
  updated_at:'2026-11-11T17:20:00Z'};
 assert.equal(assessDispatcherHeartbeat(healthy,{now}).status,'healthy');
 const stale={...healthy,schedule_health:{last_schedule_at:'2026-11-11T16:00:00Z'},
  updated_at:now};
 const observed=assessDispatcherHeartbeat(stale,{now});
 assert.equal(observed.status,'stale');
 assert.equal(observed.kind,'missed_schedule');
 assert.equal(observed.gap_minutes,80);
 assert.equal(assessDispatcherHeartbeat({updated_at:now},{now}).status,'unverified');
 assert.equal(assessDispatcherHeartbeat({schedule_health:{
  last_schedule_at:'2026-11-12T17:20:00Z'}},{now}).kind,'schedule_clock_skew');
});
