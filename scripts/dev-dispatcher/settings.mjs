import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
// A copied installation always reads ITS OWN checked-in config; no shared runtime globals.
export const SETTINGS_PATH=resolve(dirname(fileURLToPath(import.meta.url)),'../../.dispatcher/settings.json');
const repoPattern=/^[\w.-]+\/[\w.-]+$/;
const pathOK=p=>typeof p==='string'&&p.length>0&&p.length<240&&!p.startsWith('/')&&!p.split('/').includes('..');
export function validateSettings(s,{expectedRepo}={}){
 if(!s||s.version!==1||(s.legacy_proof_before!=null &&
   !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s.legacy_proof_before))||!repoPattern.test(s.repo)||expectedRepo&&expectedRepo!==s.repo||
   !repoPattern.test(s.queue?.repo)||!pathOK(s.queue.path)||
   s.queue.ref!=='main'||!repoPattern.test(s.ledger?.repo)||!pathOK(s.ledger.path)||
   !pathOK(s.ledger.receipts_path)||!pathOK(s.ledger.owner_view_path)||
   !/^https:\/\/chatgpt\.com\/g\/[a-zA-Z0-9_-]+\/?$/.test(s.chatgpt?.project_url||'')||
   !s.chatgpt.account_label||!s.chatgpt.project_id||!s.chatgpt.project_name||
   !s.muse?.space||s.muse.delivery_owner!=='muse'||s.effort_default!=='high'||
   s.codex?.policy!=='A-D'||!Number.isInteger(s.codex.settle_seconds)||
   s.codex.settle_seconds<300||s.auto_merge?.infrastructure!==false||
   typeof s.auto_merge.coding!=='boolean'||!s.required_checks?.baseline||
   !s.required_checks.baseline_workflow||!s.required_checks.integration_workflow||
   !s.required_checks.acceptance_workflow||
   !/^[a-z0-9-]+\.yml$/.test(s.workflows?.dispatcher||'')||
   !/^[a-z0-9-]+\.yml$/.test(s.workflows?.integration||'')||
   !/^[a-z0-9-]+\.yml$/.test(s.workflows?.delayed_wake||'')||
   !repoPattern.test(s.owner?.login+'/x')||
   !pathOK(s.paths?.signal)||!pathOK(s.paths?.authority)||!pathOK(s.paths?.progress)||
   !pathOK(s.paths?.skills)||!pathOK(s.paths?.task_brief_root)||!s.naming?.task_prefix||!s.naming.branch_prefix||
   !/^[a-z0-9-]+$/.test(s.naming.marker_prefix)||
   !pathOK(s.auto_test_branch)||!Array.isArray(s.protected_files)||s.protected_files.some(g=>
    !g.owner||!Array.isArray(g.paths)||g.paths.some(p=>!pathOK(p)))||
   !Array.isArray(s.required_checks.names)||!s.required_checks.names.length||
   !Array.isArray(s.setup?.required_secrets)||!Array.isArray(s.setup?.required_vars))throw Error('Invalid or cross-repository dispatcher settings');
 return s;
}
export function loadSettings(path=SETTINGS_PATH,options={}){
 return validateSettings(JSON.parse(readFileSync(path,'utf8')),options);
}
export const settings=loadSettings();
