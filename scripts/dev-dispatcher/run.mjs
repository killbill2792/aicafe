#!/usr/bin/env node
import {settings} from './settings.mjs';
import {loadQueue} from './queue-source.mjs';
import {selectObservation} from './event-selection.mjs';
// Trusted-main, read-only by default. --commit only updates a private GitHub ledger.
// Does NOT submit prompts, merge PRs or use model APIs.
import { readFileSync, appendFileSync } from "node:fs";
import { requestCodexReview, inspectCodexWatch, codexWatchMinutes } from "./codex-review.mjs";
import { GitHubFacts } from "./github.mjs";
import { GitHubLedger, emptyLedger } from "./ledger.mjs";
import { validateQueue, dispatchFrontier, decideNudge, reconcileGithub, mergeGate, architectureFoundationReady, predecessorsForMerge, wakePendingActions, editableFiles } from "./core.mjs";
import { approvalSignature, approvalMatches, createDelivery, createAdhocDelivery } from "./delivery.mjs";
import { acceptanceDigest } from "./acceptance-runner.mjs";
import { revalidateQueuedActions, assignmentActionKey } from "./authorization.mjs";
import { linkPullRequests, adoptAdhocPullRequests } from "./dependencies.mjs";
import { mergeApprovedPr, integrationStatus, safeUpdateBranch, updateChildAfterParentMerge, retryStartupFailure, dispatchLandingCheck } from "./effects.mjs";
import { inspectReceipts, applyReceiptsSafely } from "./inbox.mjs";
import { reconcileReceiptFeedback, wakeReceiptFeedback } from "./receipt-recovery.mjs";
import { queueOwnerAlerts,applyOwnerStartApprovals,queueOwnerIssue,resolveOwnerIssue,wakePendingOwnerNotices } from "./alerts.mjs";
import {trackScheduleGap,verifiedMergedProof,recordDrift} from "./self-heal.mjs";
import {classifyCodexChange} from './codex-carryover.mjs';
import { applySafetySignals, stallMinutes, landingFailureForMerge } from "./safety.mjs";
import {dispatchReceiptWake} from './wake.mjs';
import {noticeOperationalIssues,reportFatalDispatcherError,reportProjectionFailure,reportProjectionRestored} from './notifications.mjs';
import { renderOwnerView, publishOwnerView } from "./owner-view.mjs";
import { publishPrivateQueue } from "./private-owner-view.mjs";

async function main() {
  // The checked-in queue or an external studio queue is read after GitHub auth.
  const repo = process.env.GITHUB_REPOSITORY;
  const githubToken = process.env.GITHUB_TOKEN;
  if (!repo || !githubToken || repo!==settings.repo) throw new Error('Dispatcher repository/settings mismatch');
  const commit = process.argv.includes("--commit");
  const ledgerRepo = process.env.DISPATCH_LEDGER_REPO || settings.ledger.repo;
  if(ledgerRepo!==settings.ledger.repo)throw Error('Dispatcher ledger/settings mismatch');
  const ledgerToken = process.env.DISPATCH_LEDGER_TOKEN;
  if (commit && (!ledgerRepo || !ledgerToken)) throw new Error("Cannot persist without private ledger repo and token");
  const ledger = ledgerRepo && ledgerToken ? new GitHubLedger({ repo: ledgerRepo, token: ledgerToken, path:settings.ledger.path }) : null;
  const gh = new GitHubFacts({ repo, token: githubToken });
  const queue = await loadQueue({github:gh,config:settings});
  validateQueue(queue);
  const taskById = new Map(queue.tasks.map(task => [task.id, task]));
  const current = ledger ? (await ledger.verifyPrivate(), (await ledger.load()).state) : emptyLedger();
  async function observe(state) {
    let eventPayload={};
    if(process.env.GITHUB_EVENT_PATH)try{
      eventPayload=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
    }catch{eventPayload={};}
    const selection=selectObservation({eventName:process.env.GITHUB_EVENT_NAME,
      payload:eventPayload,state});
    const mainRef = await gh.request("/git/ref/heads/main");
    const mainSha=mainRef.object?.sha || null;
    const snapshot = await gh.snapshot(mainSha,{state,...selection});
    const closedByPr = {};
    const openNumbers = new Set(snapshot.map(x => x.pr_number));
    // Check actual merge metadata; disappearing from the open list is not proof of merge.
    for (const rec of Object.values(state.tasks)) {
      if (!Number.isInteger(rec.pr_number) || openNumbers.has(rec.pr_number) ||
          (rec.github_state!=='open' && ['merged','integrated_proven','released_proven'].includes(rec.status))) continue;
      const closed = await gh.request(`/pulls/${rec.pr_number}`);
      const mergeSha=closed.merged_at ? closed.merge_commit_sha || null : null;
      // Trust only the verified Actions bot marker for this exact merge SHA.
      let landingFailure=null;
      const recent=closed.merged_at && Date.now()-Date.parse(closed.merged_at)<2*60*60*1000;
      if(mergeSha && recent && !rec.landing_failure) {
        const issueComments=await gh.paginated('/issues/'+rec.pr_number+'/comments','comments');
        landingFailure=landingFailureForMerge(issueComments,mergeSha);
      }
      closedByPr[rec.pr_number]={merged:Boolean(closed.merged_at),
        merge_sha:mergeSha,landing_failure:landingFailure};
    }
    const history=await gh.request('/actions/workflows/'+settings.workflows.dispatcher+'/runs?event=schedule&per_page=3').catch(()=>null);
    const previous=(history?.workflow_runs||[]).find(r=>r.created_at && r.id!==Number(process.env.GITHUB_RUN_ID));
    return {snapshot,closedByPr,mainSha,audited:selection.fullAudit,
      lastScheduleAt:previous?.created_at || null};
  }
  function reconcile(state, observed) {
    const initiallyLinked = linkPullRequests(state, observed.snapshot);
    const adopted = adoptAdhocPullRequests(initiallyLinked.state, observed.snapshot, [...taskById.keys()]);
    const linked = linkPullRequests(adopted.state, observed.snapshot);
    // Never latch unlinked PRs: re-evaluate branch receipts and optional markers on every wake.
    // First invalidate old-head actions, THEN process Muse receipts. A receipt
    // arriving during the same GitHub reconciliation must not revive old work.
    const live = reconcileGithub(linked.state, observed.snapshot, observed.closedByPr);
    const applied = applyReceiptsSafely(live,receiptScan.accepted,actorMap);
    // A planned parent-merge prompt is not a delivered instruction. Repair
    // pre-v2 early markers and advance only after an authenticated receipt.
    for (const [key, action] of Object.entries(applied.state.actions)) {
      if (action.type !== 'parent_merged') continue;
      const rec = applied.state.tasks[action.task_id];
      if (!rec?.parent_merged_sha ||
          (key !== 'parent_merged:' + encodeURIComponent(action.task_id) + ':' + rec.parent_merged_sha + ':' + rec.head_sha &&
           key !== 'parent_merged:' + encodeURIComponent(action.task_id) + ':' + rec.parent_merged_sha))
        continue;
      if (action.status === 'submitted') rec.last_parent_rebase_sha = rec.parent_merged_sha;
      else if (rec.last_parent_rebase_sha === rec.parent_merged_sha)
        rec.last_parent_rebase_sha = null;
    }
    const afterReceipts=linkPullRequests(adoptAdhocPullRequests(
      applied.state,observed.snapshot,[...taskById.keys()]).state,observed.snapshot);
    const withFeedback = reconcileReceiptFeedback(afterReceipts.state,{
      ...receiptScan,rejected:[...receiptScan.rejected,...applied.rejected]
    },new Date().toISOString());
    const safety=applySafetySignals(withFeedback,{queue:queue.tasks,repo,
      minutes:stallMinutes(process.env.DISPATCH_STALL_MINUTES)});
    const remaining=linkPullRequests(safety,observed.snapshot).unmapped;
    const copy = noticeOperationalIssues(queueOwnerAlerts(applyOwnerStartApprovals(safety,queue),
      {unmappedPrs:remaining,openPrs:observed.snapshot,queue}),{snapshot:observed.snapshot,scan:receiptScan});
    revalidateQueuedActions(copy, taskById, queue);
    wakePendingActions(copy, Date.now());
    wakePendingOwnerNotices(copy, Date.now());
    wakeReceiptFeedback(copy, Date.now());
    // Replace only still-planned legacy child follow-ups. Never cancel a
    // claimed/submitted/uncertain delivery or an owner-facing action.
    for (const action of Object.values(copy.actions)) {
      if (action.status === 'planned' &&
          ['repair_ci', 'repair_review', 'continue_pr'].includes(action.type) &&
          ['POS0b', 'POS0c', 'POS0d'].includes(action.task_id))
        action.status = 'cancelled_superseded_template';
    }
    for (const [id, rec] of Object.entries(copy.tasks)) {
      const task = taskById.get(id);
      if (!task || rec.github_state !== 'open') continue;
      const parent = (task.depends_on || [])
        .map(dep => copy.tasks[dep])
        .find(p => p && p.pr_number === rec.prerequisite_pr);
      if (parent?.github_state === 'open') {
        rec.parent_open = true;
        rec.waiting_only_for_parent = rec.ci_state === 'success' &&
          rec.github_state === 'open';
      } else {
        rec.parent_open = false;
        rec.waiting_only_for_parent = false;
        if (parent && ['merged','integrated_proven','released_proven'].includes(parent.status) &&
            parent.merge_sha) rec.parent_merged_sha = parent.merge_sha;
      }
      const previous = state.tasks[id];
      if (previous?.github_owner_question && !rec.github_owner_question &&
          rec.latest_owner_comment && rec.latest_owner_comment_at &&
          rec.latest_owner_comment_at !== previous.latest_owner_comment_at) {
        rec.owner_answer_text = rec.latest_owner_comment;
        rec.owner_answer_key = rec.latest_owner_comment_at;
      }
    }

    const assignments = dispatchFrontier(queue, copy.tasks);
    const assigned = [];
    const nudges = [];
    const now = new Date().toISOString();
    for (const assignment of assignments) {
      const key = assignmentActionKey(copy, assignment.task_id, queue);
      if (!key) continue;
      const record = { task_id: assignment.task_id, status: "assigned",
        agent: assignment.agent, branch: settings.naming.branch_prefix+assignment.task_id, base_branch: assignment.base_branch, prerequisite_pr: assignment.prerequisite_pr, approved: true,
        approval_hash: approvalSignature(taskById.get(assignment.task_id)),
        prompt_id: `task:${assignment.task_id}`, prompt_version: "v2" };
      let delivery;
      try {
        delivery = createDelivery({ task: taskById.get(assignment.task_id), record,
          action: "assign", actionId: key });
      } catch (error) {
        console.error(`Task ${assignment.task_id} delivery creation failed: ${error.message}`);
        continue;
      }
      assigned.push(assignment);
      copy.actions[key] = { ...assignment, task_id: assignment.task_id,
        type: "assign", status: "planned", delivery_owner: "muse", created_at: now, delivery };
      copy.tasks[assignment.task_id] = record;
    }
    for (const [id, rec] of Object.entries(copy.tasks)) {
      const normal=decideNudge(rec, Date.now());
      const proposal=normal.kind==='propose' ? normal :
        rec.stall_pending && !rec.stall_escalate
          ? {kind:'propose',action:'no_push_after_prompt',key:rec.stall_pending} : normal;
      // Never cancel a current-head findings prompt unless the replacement is
      // built successfully. Other obsolete undelivered prompts may be dropped.
      const superseded=[];
      for(const action of Object.values(copy.actions)) {
        if(action.task_id!==id||action.status!=='planned'||['assign','landing_failed'].includes(action.type))continue;
        if(action.delivery?.action_id===proposal.key)continue;
        if(rec.codex_state==='findings'&&action.type==='codex_comments'&&
           action.head_sha===rec.head_sha&&proposal.kind!=='propose')continue;
        superseded.push(action);
      }
      // Exactly one live prompt per PR. Superseded planned actions are counted
      // only after a replacement was actually produced.
      if(Object.values(copy.actions).some(a=>
          ['planned','claimed','uncertain'].includes(a.status)&&
          !superseded.includes(a)&&
          (a.task_id===id||(Number.isInteger(rec.pr_number)&&
            copy.tasks[a.task_id]?.pr_number===rec.pr_number))))continue;
      if(proposal.kind!=='propose'){
        for(const stale of superseded)stale.status='cancelled_state_changed';
        continue;
      }
      if (!copy.actions[proposal.key]) {
        const task = taskById.get(id);
        // Only approved, exactly owned tasks from the trusted queue can reach Dave.
        if (rec.adhoc) {
          if (rec.github_state !== 'open' || !rec.conversation_ref) continue;
        } else if (!task || task.architecture_approval?.approved !== true ||
            !editableFiles(task).length || !approvalMatches(task, rec.approval_hash) ||
            (Number.isInteger(rec.pr_number) && rec.github_state !== "open")) continue;
        let delivery;
        try {
          delivery = rec.adhoc
            ? createAdhocDelivery({record:rec,action:proposal.action,actionId:proposal.key})
            : createDelivery({ task, record: rec,
                action: proposal.action, actionId: proposal.key });
        } catch (error) {
          console.error(`Task ${id} delivery creation failed: ${error.message}`);
          continue;
        }
        rec.last_action_key = proposal.key;
        if (proposal.action === 'owner_answered') rec.last_owner_answer_key = rec.owner_answer_key;
        copy.actions[proposal.key] = { task_id: id, type: proposal.action,
          status: "planned", delivery_owner: "muse",
          head_sha: rec.head_sha || null,
          created_at: now, delivery };
        for(const stale of superseded)stale.status='cancelled_state_changed';
        nudges.push({ task_id: id, action: proposal.action });
      }
    }
    // After-merge failures return to the saved conversation via the same signed
    // Muse action and receipt path. Never reinterpret a success as a failure.
    for (const [id, rec] of Object.entries(copy.tasks)) {
      if (rec.github_state !== 'merged' || !rec.merge_sha || !rec.landing_failure ||
          !rec.approved || !rec.conversation_ref) continue;
      const key='landing_failed:'+encodeURIComponent(id)+':'+rec.merge_sha;
      if (copy.actions[key] || Object.values(copy.actions).some(a=>
        a.task_id===id && ['planned','claimed','uncertain'].includes(a.status))) continue;
      const task=taskById.get(id);
      if (!task && !rec.adhoc) continue;
      try {
        const delivery=rec.adhoc
          ? createAdhocDelivery({record:rec,action:'landing_failed',actionId:key})
          : createDelivery({task,record:rec,action:'landing_failed',actionId:key});
        copy.actions[key]={task_id:id,type:'landing_failed',status:'planned',
          delivery_owner:'muse',head_sha:rec.merge_sha,created_at:now,delivery};
        nudges.push({task_id:id,action:'landing_failed'});
      } catch (error) {
        console.error('Landing failure routing for '+id+': '+error.message);
      }
    }
    // Chat destinations are authenticated courier receipts, not owner-supplied
    // URLs. Keep a per-PR index only in the private ledger.
    copy.pr_chat_links ||= {};
    for (const [id, rec] of Object.entries(copy.tasks)) {
      if (!Number.isInteger(rec.pr_number)) continue;
      const indexed=copy.pr_chat_links[String(rec.pr_number)];
      if (indexed?.conversation_url && (!rec.conversation_ref ||
          Date.parse(indexed.updated_at||'') > Date.parse(rec.last_submission_at||''))) {
        rec.conversation_ref=indexed.conversation_url;
        rec.conversation_url=indexed.conversation_url;
      }
      if (!rec.conversation_ref) continue;
      rec.conversation_url=rec.conversation_ref;
      if (!indexed || indexed.conversation_url !== rec.conversation_ref ||
          indexed.head_sha !== (rec.head_sha||null))
        copy.pr_chat_links[String(rec.pr_number)] = {
          task_id:id,conversation_url:rec.conversation_ref,
          head_sha:rec.head_sha || null,
          updated_at:rec.last_submission_at || now
        };
    }
    // Proposals persist for later authorized delivery, never sent by this script.
    return { state: copy, assigned, nudges };
  }
  const actorMap = Object.fromEntries((process.env.DISPATCH_COURIER_ACTORS || "").split(",").filter(Boolean).map(part => {
    const [actor, courier] = part.split("=");
    if (!actor || !["muse", "dave"].includes(courier)) throw new Error("Invalid courier actor mapping");
    return [actor, courier];
  }));
  actorMap[settings.owner.login] ||= 'owner';
  const receiptScan = ledger
    ? await inspectReceipts({ledger,allowedActors:[...new Set([...Object.keys(actorMap),settings.owner.login])]})
    : {accepted:[],rejected:[],complete:false,scan_error:'private_ledger_unavailable'};
  const observed = await observe(current);
  const proposed = reconcile(current, observed);
  proposed.state=recordDrift(trackScheduleGap(proposed.state,{
    eventName:process.env.GITHUB_EVENT_NAME,now:new Date().toISOString(),
    observedScheduleAt:observed.lastScheduleAt}),current,observed.snapshot);
  const unmappedPrs = linkPullRequests(proposed.state, observed.snapshot).unmapped;
  async function applyCodexProvenance(state, prior) {
    for (const [id,rec] of Object.entries(state.tasks)) {
      const before=prior.tasks?.[id];
      if(!rec.head_sha || rec.github_state!=='open')continue;
      if(rec.codex_state==='clean' && rec.codex_reviewed_sha===rec.head_sha) {
        // Authenticate a direct Codex receipt before recording an anchor.
        rec.codex_clean_head_sha=rec.head_sha;
        rec.codex_clean_base_sha=rec.base_merge_sha || rec.base_sha;
        rec.codex_carried_over=null;
        continue;
      }
      if((rec.codex_state==='findings'&&rec.codex_reviewed_sha===rec.head_sha)||
         rec.codex_in_progress_sha===rec.head_sha){
        rec.codex_carried_over=null;continue;
      }
      if(before?.head_sha===rec.head_sha &&
         before.codex_carried_over?.case==='B' &&
         before.codex_carried_over.base_after_sha===rec.base_sha){
        rec.codex_carried_over=before.codex_carried_over;
        rec.codex_state='clean';rec.codex_reviewed_sha=rec.head_sha;
        continue;
      }
      if(!before || before.head_sha===rec.head_sha)continue;
      const evidence=await classifyCodexChange({github:gh,previous:before,current:rec});
      rec.codex_change_case=evidence;
      rec.codex_clean_head_sha=before.codex_clean_head_sha ||
        (before.codex_state==='clean' && before.codex_reviewed_sha===before.head_sha
          ?before.head_sha:null);
      rec.codex_clean_base_sha=before.codex_clean_base_sha ||
        (rec.codex_clean_head_sha===before.head_sha?before.base_merge_sha:null);
      rec.codex_carried_over=evidence.case==='B'&&rec.codex_state!=='findings'?evidence:null;
      if(rec.codex_carried_over){
        rec.codex_state='clean';rec.codex_reviewed_sha=rec.head_sha;
      }
    }
    return state;
  }
  async function promoteIntegration(state) {
    const pending=Object.entries(state.tasks).filter(([,r])=>
      r.status==='merged' && /^[a-f0-9]{40}$/.test(r.merge_sha||''));
    if(!pending.length)return;
    const runs=await gh.workflowRuns(settings.workflows.integration,'branch=main');
    for(const [id,rec] of pending) for(const run of runs) {
      if(run.name!==settings.required_checks.integration_workflow || run.head_branch!=='main' ||
         !['push','workflow_dispatch'].includes(run.event) ||
         run.status!=='completed'||run.conclusion!=='success'||
         (run.event==='push'&&run.head_sha!==rec.merge_sha))continue;
      const jobs=await gh.workflowJobs(run.id);
      const job=jobs.find(j=>j.name==='Required merged-main integration checks'&&
        j.status==='completed'&&j.conclusion==='success');
      if(!job)continue;
      // Skipped acceptance cannot promote integration even if the job is green.
      let artifact;
      try{artifact=await gh.integrationProof(run.id);}
      catch(error){
        const notice=queueOwnerIssue(state,{kind:'integration_proof_fetch_failed',task_id:id,
          pr_number:rec.pr_number,identity:rec.merge_sha,
          message:'PR #'+rec.pr_number+' integration artifact could not be read: '+error.message,
          needs:'Restore proof API access or verify a successful exact-merge-SHA run'});
        state.owner_alerts=notice.owner_alerts;continue;
      }
      const proof=verifiedMergedProof({run,job,artifact,taskId:id,mergeSha:rec.merge_sha,
        legacyBefore:settings.legacy_proof_before});
      const task=taskById.get(id);
      if(task&&proof&&integrationStatus({merged_sha:rec.merge_sha,
        main_sha:rec.merge_sha,proof,expectedAcceptance:task.acceptance})==='integrated_proven') {
        rec.integration_proof=proof;rec.integration_dispatch='verified';
        rec.status='integrated_proven';
        state.owner_alerts=resolveOwnerIssue(state,'integration_pending',rec.pr_number).owner_alerts;
        console.log('drift_fixed: integration PR #'+rec.pr_number+' proof run '+run.id+
          ' basis '+proof.proof_basis);
        break;
      }
    }
    for(const [id,rec] of pending){
      if(rec.status==='integrated_proven')continue;
      state.owner_alerts=queueOwnerIssue(state,{kind:'integration_pending',task_id:id,
        pr_number:rec.pr_number,identity:rec.merge_sha,
        message:'PR #'+rec.pr_number+' remains merged but integration cannot be promoted for '+rec.merge_sha,
        needs:'A completed exact-SHA Integration Proof job with all required green steps'}).owner_alerts;
    }
  }

  let persisted = null;
  if (commit && ledger) {
    // Reconcile against fresh facts on every CAS attempt; do not write an
    // identical state every five minutes (avoids 288 empty commits per day).
    persisted = await ledger.transaction(async existing => {
      const latest = JSON.stringify(existing)===JSON.stringify(current)
        ? observed : await observe(existing);
      let next = await applyCodexProvenance(reconcile(existing, latest).state,existing);
      if(latest.audited)next.last_full_audit_at=new Date().toISOString();
       next=trackScheduleGap(next,{eventName:process.env.GITHUB_EVENT_NAME,
        now:new Date().toISOString(),observedScheduleAt:latest.lastScheduleAt});
      await promoteIntegration(next);
      next=recordDrift(next,existing,latest.snapshot);
      // Dependency proof is recorded for reporting, not an unsolicited chat prompt.
      // Integration may become proven during this same pass: queue the owner
      // review with the actual saved chat URL without a second delayed cycle.
      const withNotices = noticeOperationalIssues(queueOwnerAlerts(next,{queue,
        unmappedPrs:linkPullRequests(next,latest.snapshot).unmapped,openPrs:latest.snapshot}),
        {snapshot:latest.snapshot,scan:receiptScan});
      return JSON.stringify(withNotices) === JSON.stringify(existing) ? null : withNotices;
    });
  }
  // The dispatcher, not a coder chat, requests the final-head review.
  // Revalidate live GitHub CI, acceptance artifacts, PR base and owner state
  // before one comment. The private record only deduplicates acknowledged
  // actions; a GitHub comment marker also survives ledger write retries.
  if (commit && ledger) {
    const currentTasks = persisted?.state?.tasks || proposed.state.tasks;
    for (const [id, rec] of Object.entries(currentTasks)) {
      const task=taskById.get(id);
      if ((!task && !rec.adhoc) || !rec.pr_number) continue;
      try {
        const result=await requestCodexReview({
          github:gh,record:rec,task,records:currentTasks
        });
        if (['requested','already_requested'].includes(result.status)) {
          await ledger.transaction(latest=>{
            const stored=latest.tasks?.[id];
            if (!stored || stored.head_sha !== result.head_sha ||
                stored.codex_review_requested_sha === result.head_sha) return null;
            stored.codex_review_requested_sha=result.head_sha;
            return latest;
          });
          if (result.status === 'requested')
            console.log('Codex review requested for task '+id+' on head '+result.head_sha);
        }
      } catch (error) {
        console.error('Codex review preflight failed for task '+id+': '+error.message);
      }
    }
  }
  // Missing Codex receipt is a referee notice, never a second review request.
  // The first request remains the only request for an immutable head.
  if(commit && ledger) {
    const minutes=codexWatchMinutes(process.env.DISPATCH_CODEX_WATCH_MINUTES);
    const tasks=persisted?.state?.tasks || proposed.state.tasks;
    for(const [id,rec] of Object.entries(tasks)) {
      if((!taskById.has(id) && !rec.adhoc) || !rec.pr_number ||
         rec.github_state!=='open' || rec.codex_review_requested_sha!==rec.head_sha ||
         (rec.codex_referee_sha===rec.head_sha &&
          rec.codex_fallback_requested_sha===rec.head_sha))continue;
      try {
        const decision=await inspectCodexWatch({github:gh,record:rec,minutes});
        if(decision.status==='auto_review_missing'){
          // A trusted Actions-bot Ready event did not produce any real Codex
          // reaction/review. After the quiet watchdog interval, one explicit
          // GitHub comment is the FIRST confirmed request, not a blind resend.
          // requestCodexReview independently rechecks the exact live green head
          // and dedupes existing signed comments. No repeat on the same SHA.
          const fallback=await requestCodexReview({github:gh,record:rec,
            task:taskById.get(id),records:tasks,autoMissFallback:true});
          if(['requested','already_requested'].includes(fallback.status))
            await ledger.transaction(latest=>{
              const task=latest.tasks?.[id];
              if(!task||task.head_sha!==rec.head_sha||
                 task.codex_fallback_requested_sha===rec.head_sha)return null;
              task.codex_fallback_requested_sha=rec.head_sha;
              task.codex_referee_sha=null;
              task.codex_watchdog={sha:rec.head_sha,attempts:1,
                status:fallback.status==='requested'?'fallback_requested':'request_present',
                event:'codex_auto_trigger_missing',at:new Date().toISOString()};
              return queueOwnerIssue(latest,{
                kind:'codex_auto_review_missed',task_id:id,pr_number:rec.pr_number,
                identity:rec.head_sha,
                message:'PR #'+rec.pr_number+' automatic Codex review did not acknowledge the green Ready head. GitHub verified no review activity and '+(fallback.status==='requested'?'posted one @codex review request.':'found the existing explicit review request.')+
                  ' No owner approval is needed.',
                needs:'GitHub checks the signed review receipt; if it remains missing after the watchdog, Muse escalates once'
              });
            });
          continue;
        }
        if(decision.status!=='escalate')continue;
        await ledger.transaction(latest=>{
          const task=latest.tasks?.[id];
          if(!task || task.head_sha!==rec.head_sha ||
             task.codex_review_requested_sha!==rec.head_sha ||
             task.codex_referee_sha===rec.head_sha)return null;
          task.codex_referee_sha=rec.head_sha;
          task.codex_watchdog={sha:rec.head_sha,attempts:1,status:'escalated',
            event:'codex_first_miss',at:new Date().toISOString()};
          return queueOwnerAlerts(latest,{queue});
        });
      } catch(error) { console.error('Codex watchdog task '+id+': '+error.message); }
    }
  }
  // Only independently classified runner startup errors may be retried, once.
  if (commit && ledger && process.env.DISPATCH_TRANSIENT_CI_RETRY === "true") {
    for (const [id, rec] of Object.entries(proposed.state.tasks)) {
      const result = await retryStartupFailure({github:gh,ledger,taskId:id,record:rec,enabled:true});
      if (result.status === "retry_requested") console.log(`Retried verified CI startup failure for task ${id} (run ${result.run_id})`);
    }
  }
  // Default branch maintenance, always using verified trusted-main GitHub facts.
  // Parent merge -> retarget to main -> update-branch -> exactly one subsequent
  // parent_merged same-chat nudge. This cannot release any merge proof gate.
  if (commit && ledger) {
    const currentTasks = persisted?.state?.tasks || proposed.state.tasks;
    for (const [id, rec] of Object.entries(currentTasks)) {
      if (rec.github_state !== 'open' || !rec.pr_number || !rec.approved) continue;
      const task = taskById.get(id);
      if (!task) continue;
      const parent = (task.depends_on || []).map(dep=>currentTasks[dep])
        .find(p=>p?.pr_number === rec.prerequisite_pr && p?.branch);
      if (parent?.merge_sha && ['merged','integrated_proven','released_proven'].includes(parent.status) &&
          rec.branch_maintenance_merge_sha !== parent.merge_sha) {
        let result;
        try {
          result = await updateChildAfterParentMerge({github:gh,dependent:rec,predecessor:parent});
        } catch (error) {
          console.error('Child #'+rec.pr_number+' automatic branch update needs retry: '+error.message);
          continue;
        }
        if (['update_requested','update_failed_needs_coder'].includes(result.status)) {
          await ledger.transaction(latest=>{
            const child=latest.tasks[id];
            if (!child || child.pr_number!==rec.pr_number ||
                child.parent_merged_sha!==parent.merge_sha) return null;
            child.branch_maintenance_merge_sha=parent.merge_sha;
            child.branch_maintenance_result=result.status;
            return latest;
          });
          console.log('Child #'+rec.pr_number+': parent merged; branch maintenance '+result.status);
        } else console.log('Child #'+rec.pr_number+': branch maintenance held ('+result.reason+')');
        continue;
      }
      // Ordinary main-based stale branches are refreshed without force-push.
      // A new head reruns CI; Codex carry-over is allowed only for verified case B.
      if (rec.base_current === false && rec.base_branch === 'main' &&
          !(rec.draft === true && rec.ci_state !== 'success')) {
        try {
          const result = await safeUpdateBranch({github:gh,record:rec,enabled:true});
          console.log('PR #'+rec.pr_number+' main branch maintenance: '+result.status);
          if(result.status==='updating') {
            await ledger.transaction(state=>{
              const saved=state.tasks[id];
              if(!saved || saved.head_sha!==rec.head_sha)return null;
              saved.codex_branch_update={old_head_sha:rec.head_sha,
                new_base_sha:rec.base_sha,status:'accepted_no_conflicts',
                at:new Date().toISOString()};
              saved.codex_branch_conflict=null;
              return state;
            });
          } else if(result.reason==='conflict_needs_coder') {
            await ledger.transaction(state=>{
              const saved=state.tasks[id];
              if(!saved || saved.head_sha!==rec.head_sha)return null;
              saved.codex_branch_conflict={old_head_sha:rec.head_sha,
                at:new Date().toISOString()};
              return state;
            });
          }
        } catch (error) {
          // A temporarily conflicting update must not stall other approved PRs.
          console.error('PR #'+rec.pr_number+' main branch update will retry: '+error.message);
        }
      }
    }
  }
  // Green drafts are made ready automatically. Auto-merge remains separately
  // controlled and still requires an exact-head clean Codex receipt.
  const autoMerge = settings.auto_merge.coding && process.env.DISPATCH_AUTO_MERGE !== "false" && commit;
  if (commit && ledger) {
    for (const [id, rec] of Object.entries(persisted?.state?.tasks || proposed.state.tasks)) {
      if (!rec.pr_number || rec.github_state !== "open") continue;
      const task = taskById.get(id);
      if ((!task && !rec.adhoc) || (rec.draft !== true && !autoMerge)) continue;
      // Owner-merge-only infrastructure may become Ready after green CI so
      // GitHub can start automatic Codex, but never enters the merge action.
      if (rec.dispatcher_only && rec.draft === false) continue;
      const predecessorRecords = rec.adhoc ? [] : predecessorsForMerge(task, queue, proposed.state.tasks);
      // Ready transitions need only green CI, not coder-done. The later merge
      // is a separate fresh reconciliation, never the same snapshot.
      const outcome = await mergeApprovedPr({ github: gh, record: rec, predecessors: predecessorRecords,
        enabled: true, action: rec.draft ? "ready" : "merge" });
      if (outcome.status === "ready_for_review") {
        await ledger.transaction(state=>{
          const r=state.tasks?.[id];
          if(!r||r.head_sha!==rec.head_sha)return null;
          // Ready itself invokes GitHub's automatic Codex review. Never duplicate.
          r.codex_review_requested_sha=rec.head_sha;
          r.ready_transition_at=new Date().toISOString();
          return state;
        });
        await dispatchReceiptWake({token:githubToken,event:'dispatcher_delayed'}).catch(e=>
          console.error('Ready transition self-wake failed: '+e.message));
        console.log(`Verified PR #${rec.pr_number} ready on green exact head; automatic Codex follows`);
        continue;
      }
      if (outcome.status === "merged_unproven") {
        await ledger.transaction(state => {
          const currentRec = state.tasks[id];
          if (!currentRec || currentRec.head_sha !== rec.head_sha) return null;
          currentRec.status = "merged"; currentRec.merge_sha = outcome.merge_sha;
          currentRec.github_state = "merged"; currentRec.integration_dispatch = outcome.integration_dispatch;
          currentRec.landing_dispatch = outcome.landing_dispatch;
          return state;
        });
      }
    }
  }
  if (commit && ledger) {
    for (const [id, rec] of Object.entries(persisted?.state?.tasks || proposed.state.tasks)) {
      if (rec.landing_dispatch !== 'failed_needs_retry' || !rec.merge_sha ||
          !['merged','integrated_proven','released_proven'].includes(rec.status)) continue;
      const outcome=await dispatchLandingCheck(gh,rec.merge_sha);
      if (outcome === 'requested') await ledger.transaction(state=>{
        const task=state.tasks?.[id];
        if (!task || task.merge_sha!==rec.merge_sha || task.landing_dispatch!=='failed_needs_retry') return null;
        task.landing_dispatch='requested';
        return state;
      });
    }
  }
  const gateCounts = { ready: 0, blocked: 0 };
  for (const rec of Object.values(proposed.state.tasks)) {
    const gate = mergeGate(rec);
    gateCounts[gate.eligible ? "ready" : "blocked"]++;
  }
  const effectiveState = persisted?.state || proposed.state;
  // The existing GitHub Actions summary is the owner-readable control surface.
  // Never expose private courier prompts or conversation URLs in public logs.
  const active = Object.entries(effectiveState.tasks).filter(([,rec])=>
    Number.isInteger(rec.pr_number) && rec.github_state === "open");
  const rows = active.sort(([,a],[,b])=>a.pr_number-b.pr_number).map(([id,rec])=>{
    const task = taskById.get(id);
    const dependencies = task ? predecessorsForMerge(task,queue,effectiveState.tasks) : [];
    const reasons = [
      ...mergeGate(rec,dependencies).reasons,
      ...(rec.adhoc && rec.dispatcher_only ? ['owner_merge_required'] : [])
    ];
    const outstanding = Object.values(effectiveState.actions).filter(action=>
      action.task_id === id && action.status === "planned")
      .sort((a,b)=>String(b.created_at||"").localeCompare(String(a.created_at||"")));
    const next = rec.owner_question || rec.github_owner_question ? "Owner decision + permitted coder fixes" :
      rec.ci_state === "failure" ? "Coder: repair CI" :
      rec.codex_state === "findings" ? "Coder: address review" :
      reasons.length ? "Coder/dispatcher: finish proof" : "GitHub: ready/merge gate";
    const action = outstanding[0];
    const pending = action ? action.type + " planned (Muse not verified)" : "none";
    return `| ${id} | [#${rec.pr_number}](https://github.com/${repo}/pull/${rec.pr_number}) | ${rec.draft ? "Draft" : "Open"} | ${rec.ci_state || "unknown"} | ${rec.codex_state || "unknown"} | ${next} | ${pending} | ${reasons.join(", ") || "eligible"} |`;
  });
  const foundationId = queue.dispatch_rules?.architecture_foundation_proof_task;
  const foundationRecord = effectiveState.tasks?.[foundationId];
  const foundationReviewPending = !!foundationId &&
    ["merged","integrated_proven","released_proven"].includes(foundationRecord?.status) &&
    !architectureFoundationReady(queue,effectiveState.tasks);
  const hasChatReceipt = !!foundationRecord?.conversation_ref;
  const summary = [
     '## '+settings.chatgpt.project_name+' development dispatcher — coordination status',
    `- Last persisted state: **${effectiveState.updated_at || "not yet saved"}** (an unchanged ledger alone is not a scheduler heartbeat)`,
    "- 10-minute code inactivity / 15-minute post-delivery checks are best-effort; GitHub scheduled runs may be delayed or dropped.",
    "",
    "### Current PRs and next responsible party",
    "| Task | PR | Stage | CI | Codex | Next actor | Muse action | Merge blockers |",
    "|---|---|---|---|---|---|---|---|",
    ...(rows.length ? rows : ["| — | — | — | — | — | No active tracked PR | — | — |"]),
    "",
    `- GitHub open PRs observed: **${observed.snapshot.length}**`,
    `- Unmapped PRs requiring owner/coder identification (never guessed): **${unmappedPrs.join(", ") || "none"}**`,
    `- Approved new assignments: **${proposed.assigned.length}**`,
    `- Eligible follow-ups (NOT sent): **${proposed.nudges.length}**`,
    `- Planned Muse owner notices (NOT sent): **${Object.values(effectiveState.owner_alerts || {}).filter(n=>n.status==="planned").length}**`,
    `- Muse receipt-authentication repairs: **${Object.values(effectiveState.receipt_feedback || {}).filter(f=>f.status==="rejected").length}** (same receipt; no browser re-send)`,
    `- Courier receipt scan: **${effectiveState.receipt_scan?.complete===true?"complete":"incomplete; preserve existing holds"}**`,
    `- Architecture owner review pending: **${foundationReviewPending ? (hasChatReceipt ? "Muse notice queued or already submitted" : "waiting for verified ChatGPT conversation receipt") : "no"}**`,
    `- Tracked merge gates: ready **${gateCounts.ready}**, blocked **${gateCounts.blocked}**`,
    `- Private durable state: **${commit ? persisted?.committed ? "saved" : "unchanged" : ledger ? "read-only" : "not configured"} (no external actions)**`,
    "- Browser submissions: **not performed by GitHub**; courier execution is separate.",
    `- Auto-merge opt-in: **${autoMerge ? "enabled (strict gates enforced)" : "disabled"}**.`,
    `- Branch maintenance: **${commit && ledger ? "enabled by default (trusted-main; exact-head proof unchanged)" : "read-only"}**.`,
    `- Transient CI retry opt-in: **${commit && process.env.DISPATCH_TRANSIENT_CI_RETRY === "true" ? "enabled" : "disabled"}**.`,
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  // A separate owner-readable projection lives IN THE ALREADY PRIVATE
  // ledger repository; never place its contents in a public issue or Pages.
  // Failure cannot stop courier signals or the authoritative JSON ledger.
  if (commit && ledger && persisted) {
    try {
      const privateView = await publishPrivateQueue({ledger});
      console.log(`Private Muse owner queue ${privateView.status}`);
      try{await reportProjectionRestored({ledger,kind:'private_queue_publish_failed',
        identity:settings.ledger.owner_view_path});}
      catch(health){console.error('Private queue recovery notice failed: '+health.message);}
    } catch (error) {
      console.error(`Private Muse owner queue publication failed: ${error.message}`);
      try{await reportProjectionFailure({ledger,kind:'private_queue_publish_failed',
        identity:settings.ledger.owner_view_path});}
      catch(health){console.error('Private queue failure notice unavailable: '+health.message);}
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          '\\n**Private queue view update failed** — see runner log; authoritative ledger is unchanged.\\n');
    }
  }
  // Single owner-facing view in issue #411, updated by the same trusted-main
  // reconciliation. Dashboard publishing is never allowed to block the
  // private ledger or the opaque Muse wake-up signal.
  const ownerIssue = Number(process.env.DISPATCH_OWNER_DASHBOARD_ISSUE || settings.owner.dashboard_issue);
  if (commit && ledger && persisted && Number.isSafeInteger(ownerIssue) && ownerIssue > 0) {
    const runUrl = process.env.GITHUB_RUN_ID
      ? `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
    try {
      const body = renderOwnerView(effectiveState,{repo,asOf:new Date().toISOString(),runUrl,queue});
      const published = await publishOwnerView({github:gh,issue:ownerIssue,body});
      console.log(`Owner control center ${published.status}: issue #${ownerIssue}, comment ${published.id}`);
      try{await reportProjectionRestored({ledger,kind:'owner_dashboard_publish_failed',
        identity:String(ownerIssue)});}
      catch(health){console.error('Dashboard recovery notice failed: '+health.message);}
    } catch (error) {
      console.error(`Owner control center publication failed: ${error.message}`);
      try{await reportProjectionFailure({ledger,kind:'owner_dashboard_publish_failed',
        identity:String(ownerIssue)});}
      catch(health){console.error('Dashboard failure notice unavailable: '+health.message);}
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n**Owner dashboard update failed** — see the reconciliation log. Private ledger and courier signal remain independent.\n');
    }
  }
}
main().catch(async error => {
 const secrets=[process.env.GITHUB_TOKEN,process.env.DISPATCH_LEDGER_TOKEN].filter(Boolean);
 const detail=secrets.reduce((s,t)=>s.split(t).join('[REDACTED]'),String(error.message||error)).slice(0,250);
 console.error('Dispatcher failed: '+detail);
 if(error.code==='RATE_LIMIT'){
  // The private ledger token already reports 0 remaining. Repeated writes
  // would only extend a GitHub outage or further exhaust the shared budget.
  // This failed Actions run is an explicit status; no notice is claimed sent.
  console.error('Private ledger API budget exhausted; skip futile Muse alert write; retry only after GitHub reset '+(error.reset_at||'unknown')+'.');
 }else if(process.env.DISPATCH_LEDGER_TOKEN){
  try{
   const ledger=new GitHubLedger({repo:settings.ledger.repo,token:process.env.DISPATCH_LEDGER_TOKEN,
    path:settings.ledger.path});
   await reportFatalDispatcherError({ledger,sha:process.env.GITHUB_SHA||'unknown',
    message:detail,wake:()=>dispatchReceiptWake({token:process.env.GITHUB_TOKEN})});
  }catch(second){console.error('Owner alert persistence or wake failed: '+String(second.message).slice(0,160));}
 }
 process.exitCode=1;
});
