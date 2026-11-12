// Public-shape, private-location Muse operational contract. It is generated
// into the EXISTING private queue by the trusted Git CAS writer; Muse must
// never need to inspect source code after a dispatcher update.
import {settings} from './settings.mjs';
export const MUSE_OPERATIONS_VERSION=1;
export function museOperationsContract(){
 return {
  schema:'muse.operations.v1',version:MUSE_OPERATIONS_VERSION,
  project_id:settings.naming.task_prefix,
  dispatcher:{repository:settings.repo,branch:'main'},
  queue:{repository:settings.ledger.repo,branch:'main',
   state:settings.ledger.path,
   human_view:settings.ledger.owner_view_path,
   approved_tasks:'docs/plans/universal-supervisor-queue.json'},
  read:{
   tasks:'state.tasks',lifecycle:'state.lifecycle_v3.rows',
   actions:'state.actions',owner_notices:'state.owner_alerts',
   owner_instructions:'state.owner_instruction_events',
   muse_recovery_receipts:'state.muse_recovery_events',
   recovery_ack:'state.recovery_requests[request_id]',
   recovery_rejection:'state.recovery_rejections[request_id]'},
  writes:{
   receipts:settings.ledger.receipts_path+'/<receiptFilename>.json',
   signed_recovery_optional:'dispatcher/recovery-requests/<request_id>.json',
   forbidden:['dispatcher/state.json','dispatcher/owner-queue.md']},
  scripts:{
   recovery:'node scripts/dev-dispatcher/muse-recovery-git-cli.mjs < request.json',
   receipt_name:'node scripts/dev-dispatcher/receipt-identity.mjs < receipt.json',
   watch:'node scripts/dev-dispatcher/muse-watch-v3.mjs <ledger> <backlog> [queue]'},
  recovery:{
   preferred_transport:'private_git_authenticated_receipt',
   raw_signing_key_required:false,
   event_type:'dispatcher_git_wake',
   event_payload:{version:1},
   command_example:{version:1,intent:'RECONCILE',
      task_id:null,pr_number:null,expected_head_sha:null},
   receipt_kind:'muse_recovery',
   receipt_identity:'event_id',
   receipt_example:{kind:'muse_recovery',version:1,
    project_id:settings.naming.task_prefix,repo:settings.repo,
    event_id:'<stable unique event id>',intent:'RECONCILE',
    task_id:null,pr_number:null,expected_head_sha:null,
    submitted_at:'<actual UTC ISO timestamp>'},
   ack_event_path:'state.muse_recovery_events[event_id]',
   ack_request_path:'state.recovery_requests[request_id]',
   ack_rejection_path:'state.recovery_rejections[request_id]',
   wake_cooldown_minutes:15,
   auth:'GitHub verified commit actor in DISPATCH_COURIER_ACTORS=muse'},
  owner_relay:{
   kind:'owner_instruction',
   payload_fields:['kind','event_id','target','text','submitted_at'],
   status:'state.owner_instruction_events[event_id]',
   credential:'existing authenticated Muse private-Git receipt writer'},
  browser_delivery:{
   instruction:'state.actions[action_id].delivery',
   receipt:'dispatcher/receipts/<receiptFilename>.json',
   actual_send_required:true},
  state_distinctions:{
   queued:'Git write verified but not yet processed',
   requested:'GitHub recorded a request, not task completion',
   observed:'Reconciliation ran but did not prove an effect',
   satisfied:'Matching GitHub evidence verified',
   blocked:'Command rejected by existing identity or safety gates'},
  note:'Never create owner approvals or status facts. A new source PR must publish the next versioned operating contract.',
 };
}
