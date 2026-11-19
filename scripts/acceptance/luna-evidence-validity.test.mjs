import test from 'node:test';
import assert from 'node:assert/strict';
import {compareLunaTrees} from './luna-evidence-validity.mjs';
const sha=c=>c.repeat(40);
const file=(path,c='a',mode='100644',type='blob')=>({path,sha:sha(c),mode,type});
const tree=(entries,root='b')=>({sha:sha(root),truncated:false,tree:entries});
test('identical content and exact reviewed document edits are comparison eligible',()=>{
 const a=tree([file('lib/ai/agent/loop.ts'),file('AGENTS.md')]);
 assert.equal(compareLunaTrees(a,a).status,'COMPARISON_ELIGIBLE');
 const b=tree([file('lib/ai/agent/loop.ts'),file('AGENTS.md','c')],'d');
 assert.deepEqual(compareLunaTrees(a,b).impact,[]);
});
test('any runtime, prompt, migration, fixture, dependency, workflow or unreviewed document change is unsafe',()=>{
 for(const p of ['lib/ai/agent/loop.ts','supabase/migrations/01.sql','package-lock.json',
  '.github/luna/scenarios/14c.json','.github/workflows/ai-cafe-luna-shared.yml',
  'scripts/acceptance/shared-luna.mjs','docs/prompt.md','app/page.tsx','unknown.bin']){
  const v=compareLunaTrees(tree([file(p)]),tree([file(p,'c')],'d'));
  assert.equal(v.status,'IMPACT_CHANGED',p);assert.deepEqual(v.impact,[p]);
 }
});
test('adds, deletes, symlinks, permission changes, gitlinks and renames cannot be exempted',()=>{
 for(const [a,b] of [
  [[],[file('AGENTS.md')]],
  [[file('AGENTS.md')],[]],
  [[file('AGENTS.md')],[file('AGENTS.md','c','120000')]],
  [[file('AGENTS.md')],[file('AGENTS.md','a','100755')]],
  [[file('AGENTS.md')],[file('docs/prompt.md')]],
  [[file('module','a','160000','commit')],[file('module','c','160000','commit')]]
 ])assert.equal(compareLunaTrees(tree(a),tree(b,'d')).status,'IMPACT_CHANGED');
});
test('incomplete, malformed or duplicate tree entries fail closed',()=>{
 const a=tree([file('AGENTS.md')]);
 for(const bad of [null,{...a,truncated:true},{...a,truncated:undefined},
  tree([file('AGENTS.md'),file('AGENTS.md')]),tree([file('../AGENTS.md')]),
  tree([file('AGENTS.md','a','100777')]),tree([{...file('AGENTS.md'),sha:'bad'}])]){
  assert.equal(compareLunaTrees(a,bad).status,'UNKNOWN');
 }
});
test('tree ancestor hash changes alone do not invalidate an otherwise eligible edit',()=>{
 const p='docs/rules/shared-luna-acceptance.md';
 const a=tree([file('docs','b','040000','tree'),file(p)]);
 const b=tree([file('docs','c','040000','tree'),file(p,'c')],'d');
 assert.equal(compareLunaTrees(a,b).status,'COMPARISON_ELIGIBLE');
});
