import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
// No-provider-cost first stage of Luna evidence reuse.
// Run from trusted main; input trees must be fetched by the trusted caller
// from GitHub's exact commits, never from candidate-supplied JSON.
// This comparison is NOT authentication of a Luna receipt or merge clearance.
const SHA=/^[a-f0-9]{40}$/;
// Narrow, reviewer-owned list. Never exempt a directory, glob, runtime
// configuration, generated source, test fixture or candidate-provided list.
const DOCUMENTS=new Set([
 'AGENTS.md',
 'docs/rules/acceptance-quality.md',
 'docs/rules/shared-luna-acceptance.md',
 'docs/rules/workflow-and-review.md',
 'docs/plans/muse-lightweight-coordination.md',
 '.github/pull_request_template.md',
 '.claude/skills/aicafe-pr-lifecycle/SKILL.md'
]);
function indexTree(tree){
 if(tree?.truncated!==false||!SHA.test(tree.sha||'')||!Array.isArray(tree.tree))
  throw Error('Complete Git tree required');
 const entries=new Map(),seen=new Set();
 for(const e of tree.tree){
  if(typeof e.path!=='string'||!e.path||e.path.split('/').some(p=>!p||p==='.'||p==='..')||
     /[\x00-\x1f\x7f]/.test(e.path)||seen.has(e.path)||!SHA.test(e.sha||''))
   throw Error('Invalid or duplicate Git tree entry');
  seen.add(e.path);
  if(e.type==='tree'&&e.mode==='040000')continue;
  if(!((e.type==='blob'&&['100644','100755','120000'].includes(e.mode))||
       (e.type==='commit'&&e.mode==='160000')))
   throw Error('Unknown Git tree entry type or mode');
  entries.set(e.path,{mode:e.mode,type:e.type,sha:e.sha});
 }
 return entries;
}
export function compareLunaTrees(tested,candidate){
 let before,after;
 try{before=indexTree(tested);after=indexTree(candidate);}
 catch(e){return {status:'UNKNOWN',reason:String(e.message),changed:[],impact:[]};}
 const paths=[...new Set([...before.keys(),...after.keys()])].sort();
 const changed=[],impact=[];
 for(const path of paths){
  const a=before.get(path),b=after.get(path);
  if(a&&b&&a.sha===b.sha&&a.mode===b.mode&&a.type===b.type)continue;
  changed.push(path);
  // Only content edits to an existing ordinary, explicitly reviewed document.
  // Deletions/additions, symlinks, executable-bit changes and renames are unsafe.
  if(!(DOCUMENTS.has(path)&&a?.mode==='100644'&&b?.mode==='100644'&&
       a.type==='blob'&&b.type==='blob'))impact.push(path);
 }
 return {status:impact.length?'IMPACT_CHANGED':'COMPARISON_ELIGIBLE',
  tested_tree:tested.sha,candidate_tree:candidate.sha,changed,impact,
  reason:impact.length?'Non-exempt code, resource or mode changed; independence not established':
   'No changes outside the narrow reviewed document allowlist'};
}

const REPO='killbill2792/aicafe', OWNER='killbill2792';
const WORKFLOW='.github/workflows/ai-cafe-luna-shared.yml';
const scenarioId=/^[a-z0-9][a-z0-9-]{0,31}$/;
const positiveInt=n=>Number.isSafeInteger(n)&&n>0;
const assert=(ok,msg)=>{if(!ok)throw Error(msg);};
const step=(job,name)=>job.steps?.filter(s=>s.name===name).length===1&&
 job.steps.find(s=>s.name===name).conclusion==='success';
export function validateLunaReceipt({workflow,run,jobs,artifact,proof,runId,scenario}){
 assert(positiveInt(runId)&&scenarioId.test(scenario),'Invalid receipt identity');
 assert(workflow?.path===WORKFLOW&&positiveInt(workflow.id)&&run?.workflow_id===workflow.id&&run.id===runId&&
  run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
  run.head_branch==='main'&&SHA.test(run.head_sha||'')&&
  run.actor?.login===OWNER&&run.triggering_actor?.login===OWNER&&
  ['issue_comment','workflow_dispatch'].includes(run.event)&&run.run_attempt===1&&
  run.status==='completed'&&run.conclusion==='success',
  'Expected successful owner-authorized first attempt of trusted main runner');
 if(run.event==='issue_comment')assert(/^luna-owner-comment-[1-9]\d*$/.test(run.display_title||''),'Owner comment identity missing');
 else assert(run.display_title==='luna-manual-'+runId,'Manual owner run identity missing');
 assert(Array.isArray(jobs),'Complete run jobs required');
 const auth=jobs.filter(j=>j.name==='Verify first owner comment run from immutable Actions history');
 const live=jobs.filter(j=>j.name==='Real Luna — '+scenario);
 assert(auth.length===1&&live.length===1&&[auth[0],live[0]].every(j=>positiveInt(j.id)&&
  j.run_id===runId&&j.conclusion==='success'&&j.status==='completed'),
  'Successful authorization and exact scenario job missing');
 assert(step(auth[0],'Validate immutable owner-run authorization before any secret')&&
  ['Reverify consumed owner grant and current SHA immediately before provider access',
   'Real registered Supervisor scenario in unprivileged candidate Docker',
   'Independently verify model receipts and source/owner data on trusted host',
   'Upload only the sanitized independent verdict'].every(n=>step(live[0],n)),
  'Trusted host authorization/attestation steps missing');
 assert(positiveInt(artifact?.id)&&artifact.name==='luna-'+scenario+'-exact-head-host-proof'&&
  artifact.expired===false&&artifact.workflow_run?.id===runId&&
  artifact.workflow_run.head_sha===run.head_sha&&artifact.workflow_run.head_branch==='main'&&
  /^sha256:[a-f0-9]{64}$/.test(artifact.digest||''),'Artifact identity or digest unverified');
 assert(proof&&SHA.test(proof.head||'')&&proof.model==='gpt-6-luna'&&
  proof.acceptanceProof!==false&&proof.result!=='FAILED','Invalid model or candidate proof');
 const attempts=proof.attempts??proof.providerAttempts;
 const cost=proof.reservedUpperUSD??proof.upperCostReservationUSD;
 assert(positiveInt(attempts)&&attempts<=18&&typeof cost==='number'&&cost>0&&cost<=0.18,
  'Invalid bounded provider proof');
 if(scenario==='13c'||scenario==='13d'){
  assert(proof.task===scenario.toUpperCase()&&proof.provider==='openai_responses'&&
   proof.independentOwnerDatabaseProof===true&&
   (scenario==='13c'?proof.staffAndRosterCorroborated:proof.caseAndRosterCorroborated)===true,
   'Invalid staffing legacy attestation');
 }else if(scenario==='14b'){
  assert(proof.realModelObjectivePassed===true&&Array.isArray(proof.providerSelectedTools)&&
   ['inspect_supplier_purchase','propose_supplier_purchase_order','get_supplier_purchase_orders']
    .every(t=>proof.providerSelectedTools.includes(t)),'Invalid purchasing legacy attestation');
 }else{
  assert(proof.scenario===scenario&&proof.provider==='openai_responses'&&
   proof.realModelAndDatabaseProof===true&&Array.isArray(proof.independentDatabaseReadbacks)&&
   proof.independentDatabaseReadbacks.every(c=>c.passed===true)&&
   ['source','owner','isolation'].every(k=>proof.independentDatabaseReadbacks.some(c=>c.kind===k)),
   'Invalid generic independent host proof');
 }
 return {scenario,tested_sha:proof.head,run_id:runId,job_id:live[0].id,artifact_id:artifact.id,
  trusted_runner_sha:run.head_sha,artifact_digest:artifact.digest,provider_attempts:attempts,
  reserved_upper_usd:cost,actual_input_tokens:proof.actualInputTokens??null,
  actual_output_tokens:proof.actualOutputTokens??null};
}
// Report a conservative validity assessment; no permission, feature activation
// or release can be inferred from one scenario. Until the dependency model is
// independently reviewed, only a byte-identical complete tree is sufficient.
export async function assessLunaEvidence({scenario,runId,candidateSha,api,readArchive}){
 const missing=reason=>({scenario,candidate_sha:candidateSha,status:'MISSING_OR_UNVERIFIED',reason});
 try{
  assert(SHA.test(candidateSha||'')&&scenarioId.test(scenario||'')&&positiveInt(runId),'Invalid assessment inputs');
  const workflow=await api('/actions/workflows/ai-cafe-luna-shared.yml');
  const run=await api('/actions/runs/'+runId);
  const jobPage=await api('/actions/runs/'+runId+'/attempts/1/jobs?per_page=100');
  const artPage=await api('/actions/runs/'+runId+'/artifacts?per_page=100');
  assert(jobPage.total_count===jobPage.jobs?.length&&artPage.total_count===artPage.artifacts?.length,
   'Incomplete evidence listing');
  const arts=artPage.artifacts.filter(a=>a.name==='luna-'+scenario+'-exact-head-host-proof');
  assert(arts.length===1,'Exactly one scenario host artifact required');
  const artifact=arts[0];
  assert(positiveInt(artifact.id)&&artifact.expired===false&&positiveInt(artifact.size_in_bytes)&&
   artifact.size_in_bytes<=256*1024&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest||''),'Artifact unavailable or unsafe');
  const {bytes,proof}=await readArchive(artifact);
  assert(bytes instanceof Uint8Array&&bytes.length<=256*1024&&
   'sha256:'+createHash('sha256').update(bytes).digest('hex')===artifact.digest,'Artifact digest mismatch');
  const evidence=validateLunaReceipt({workflow,run,jobs:jobPage.jobs,artifact,proof,runId,scenario});
  const readTree=async sha=>{
   const commit=await api('/git/commits/'+sha);
   assert(commit.sha===sha&&SHA.test(commit.tree?.sha||''),'Commit/tree provenance mismatch');
   const tree=await api('/git/trees/'+commit.tree.sha+'?recursive=1');
   assert(tree.sha===commit.tree.sha,'Incorrect Git tree');
   return tree;
  };
  const [tested,current]=await Promise.all([readTree(evidence.tested_sha),readTree(candidateSha)]);
  const comparison=compareLunaTrees(tested,current);
  if(comparison.status==='UNKNOWN')return missing(comparison.reason);
  const identical=tested.sha===current.sha&&comparison.changed.length===0;
  return {...evidence,candidate_sha:candidateSha,status:identical?'VERIFIED_REUSE':'FRESH_TEST_REQUIRED',
   changed:comparison.changed,impact:comparison.impact,
   reason:identical?'Authenticated success and byte-identical candidate tree':
    'Candidate tree changed; scenario dependency equivalence is not independently established'};
 }catch(e){return missing(String(e.message||e));}
}
async function readLimited(response,limit){
 assert(response.ok&&response.body,'GitHub evidence read unavailable');
 const reader=response.body.getReader();const chunks=[];let length=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;
  length+=value.length;assert(length<=limit,'Evidence response exceeds safe limit');chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 return Buffer.concat(chunks);
}
// Trusted caller only: authenticated GitHub data and an immutable v4 archive.
// No checkout or candidate execution; no credentials forwarded to file storage.
export function githubEvidenceReader(token,fetchImpl=fetch){
 assert(typeof token==='string'&&token.length>0,'Read-only GitHub token required');
 const base='https://api.github.com/repos/'+REPO;
 const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
 const api=async path=>JSON.parse((await readLimited(await fetchImpl(base+path,{headers,redirect:'error'}),32*1024*1024)).toString('utf8'));
 const readArchive=async artifact=>{
  const response=await fetchImpl(base+'/actions/artifacts/'+artifact.id+'/zip',{headers,redirect:'manual'});
  assert(response.status===302,'Artifact download redirect unavailable');
  const url=new URL(response.headers.get('location')||'');
  assert(url.protocol==='https:'&&!url.username&&!url.password,'Unsafe artifact redirect');
  const bytes=await readLimited(await fetchImpl(url,{redirect:'error'}),256*1024);
  assert('sha256:'+createHash('sha256').update(bytes).digest('hex')===artifact.digest,'Artifact digest mismatch');
  const dir=mkdtempSync(join(tmpdir(),'aicafe-luna-proof-'));
  try{
   const file=join(dir,'proof.zip');writeFileSync(file,bytes,{mode:0o600});
   const output={encoding:'utf8',timeout:5000,maxBuffer:128*1024};
   assert(execFileSync('unzip',['-Z1',file],output).trim()==='luna-sanitized-result.json','Unexpected archive contents');
   const proof=JSON.parse(execFileSync('unzip',['-p',file,'luna-sanitized-result.json'],output));
   return {bytes,proof};
  }finally{rmSync(dir,{recursive:true,force:true});}
 };
 return {api,readArchive};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [scenario,runId,candidateSha]=process.argv.slice(2);
 const result=await assessLunaEvidence({scenario,runId:Number(runId),candidateSha,
  ...githubEvidenceReader(process.env.GH_TOKEN||process.env.GITHUB_TOKEN)});
 console.log(JSON.stringify(result,null,2));
}
