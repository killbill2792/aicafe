import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePublicExtras,parseRecentMerges,MERGED_PULLS_URL,MERGE_REFRESH_INTERVAL_MS} from '../../docs/owner-dashboard-extras.mjs';
test('reads graph and dispatcher history without creating a new state source',()=>{
 const s=['<!-- aicafe-dispatcher-owner-view:v1 -->','## AI CAFE',
  '[Open dispatcher execution](https://github.com/killbill2792/aicafe/actions/runs/123)',
  '### Approved architecture to implementation map',
  '\x60\x60\x60mermaid','flowchart TD',
  '  T_POS0a["POS0a - Architecture<br/>PR #398 - Merged"]',
  '  T_POS0e["POS0e - Reader<br/>PR #404 - Draft"]',
  '  T_POS0a --> T_POS0e','\x60\x60\x60',
  '### Recent dispatcher history',
  '| Task | Action | Recorded status | Timestamp (UTC) |',
  '|---|---|---|---|',
  '| POS0c | repair_review | planned | 2026-11-09T23:54:55Z |'].join('\n');
 const out=parsePublicExtras(s);
 assert.equal(out.graph.nodes.length,2);
 assert.deepEqual(out.graph.edges,[{from:'POS0a',to:'POS0e'}]);
 assert.equal(out.history[0].status,'planned');
 assert.equal(out.runUrl,'https://github.com/killbill2792/aicafe/actions/runs/123');
 assert.throws(()=>parsePublicExtras('untrusted'),/trusted public/);
});
test('merged feed filters closed-unmerged PRs and unsafe URLs',()=>{
 const p={number:416,title:'Owner blueprint',html_url:'https://github.com/killbill2792/aicafe/pull/416',
   merged_at:'2026-11-09T23:40:46Z',merge_commit_sha:'9cdc6c8aff2e5ae65843cae7297f0e4a3f879f0f'};
 const list=parseRecentMerges([p,{...p,number:420,html_url:'https://github.com/killbill2792/aicafe/pull/420',merged_at:null},
   {...p,number:421,html_url:'https://evil.example/pull/421'}]);
 assert.equal(list.length,1);
 assert.equal(list[0].pr,416);
 assert.equal(list[0].sha,'9cdc6c8af');
 assert.equal(MERGE_REFRESH_INTERVAL_MS,600000);
 assert.match(MERGED_PULLS_URL,/state=closed/);
 assert.throws(()=>parseRecentMerges({}),/Invalid GitHub PR/);
});
