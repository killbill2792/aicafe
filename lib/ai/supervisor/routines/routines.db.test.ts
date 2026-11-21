import {readFileSync,existsSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {Client} from "pg";
import {describe,expect,it} from "vitest";

// The existing CI regression shards lack an active database. The DB acceptance
// lane requires an explicitly opted-in disposable local Supabase at 54322;
// NEVER accept production/staging URLs or silently treat skipped proof as pass.
const sandbox=process.env.SUPERVISOR_ROUTINES_DB_SANDBOX_ONLY==="1";
const url=process.env.SUPERVISOR_ROUTINES_DB_URL??"";
if(sandbox){
  if(!url)throw new Error("Disposable routine DB URL required");
  const parsed=new URL(url);
  if(!["127.0.0.1","localhost"].includes(parsed.hostname)||
    parsed.port!=="54322"||parsed.pathname!=="/postgres")
    throw new Error("Routine DB test refuses non-disposable database");
}
async function connect(role:"postgres"|"owner"|"service",ownerId?:string){
  const db=new Client({connectionString:url});
  await db.connect();
  if(role==="owner"){
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ownerId]);
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)");
    await db.query("set role authenticated");
  }else if(role==="service"){
    await db.query("select set_config('request.jwt.claim.role','service_role',false)");
    await db.query("set role service_role");
  }
  return db;
}
const call=(db:Client,name:string,args:unknown[])=>
  db.query("select to_jsonb(public."+name+"("+args.map((_,i)=>"$"+(i+1)).join(",")+
    ")) as result",args).then(rows=>rows.rows[0].result);

describe("routine SQL security contract",()=>{
  it("keeps owner notice security, atomic source proof and worker separation",()=>{
    const sql=readFileSync("supabase/migrations/20261111000204_supervisor_routines.sql","utf8");
    expect(sql).toContain("primary key (business_id,routine_id,local_date)");
    expect(sql).toContain("on conflict do nothing");
    expect(sql).toContain("operating_priority_notice_owner_only");
    expect(sql).toContain("role='owner'");
    expect(sql).toContain("post_supervisor_priority_notice");
    expect(sql).not.toContain("alter table public.supervisor_runs");
  });
  (sandbox?it:it.skip)("claims one local-day run across two workers, enforces owner CAS and commits one private notice",async()=>{
    const admin=await connect("postgres");
    const business=randomUUID(),ownerId=randomUUID(),threadId=randomUUID();
    const otherOwner=randomUUID(),otherBusiness=randomUUID(),otherThread=randomUUID();
    const routineId=randomUUID(),secondRoutine=randomUUID();
    let owner:Client|undefined,workerA:Client|undefined,workerB:Client|undefined;
    const insertOwner=async(id:string,cafe:string,thread:string)=>{
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
        [id,"routine-"+id+"@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,$2,'America/Los_Angeles',false)",
        [cafe,"Disposable routine café"]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[cafe,id]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
        [thread,cafe,id,randomUUID()]);
    };
    try{
      await insertOwner(ownerId,business,threadId);
      await insertOwner(otherOwner,otherBusiness,otherThread);
      owner=await connect("owner",ownerId);
      workerA=await connect("service");
      workerB=await connect("service");
      const makeArgs=(id:string)=>[business,ownerId,threadId,"Check evidence","daily",[],"08:00",id];
      const first=await call(owner,"create_supervisor_routine",makeArgs(routineId));
      expect(first.id).toBe(routineId);
      expect((await call(owner,"create_supervisor_routine",makeArgs(routineId))).id).toBe(routineId);
      await expect(call(owner,"create_supervisor_routine",
        [otherBusiness,otherOwner,otherThread,"Cross-tenant","daily",[],"08:00",randomUUID()]))
        .rejects.toThrow();
      await call(owner,"create_supervisor_routine",makeArgs(secondRoutine));
      // Simulate the start of a previously active schedule without using
      // production timestamps or pretending a past cron ran in real life.
      await admin.query("update public.supervisor_routines set updated_at='2026-01-01T00:00:00Z' where business_id=$1",
        [business]);
      // An outage spans local dates; the existing occurrence identity remains
      // the dedupe boundary. Source checks are made on recovery, not backdated.
      const catchUpNow="2026-11-06T18:00:00Z";
      await admin.query("update public.supervisor_routines set updated_at='2026-11-01T00:00:00Z' where business_id=$1 and id=$2",[business,routineId]);
      const candidateArgs=[business,routineId,1,catchUpNow];
      const candidates=await workerA.query("select local_date::text,scheduled_for_utc from public.supervisor_due_routine_dates($1,$2,$3,$4)",candidateArgs);
      expect(candidates.rows.map(x=>x.local_date)).toEqual(["2026-10-31","2026-11-01","2026-11-02","2026-11-03","2026-11-04"]);
      expect(candidates.rows.every(x=>x.scheduled_for_utc===null)).toBe(true);
      await expect(owner.query("select * from public.supervisor_due_routine_dates($1,$2,$3,$4)",candidateArgs)).rejects.toThrow();
      expect(await call(workerA,"supervisor_claim_current_routine_occurrence",[business,routineId,999,"2026-11-02","2026-11-02T16:00:00Z",catchUpNow])).toBeNull();
      const abandoned=await call(workerA,"supervisor_claim_current_routine_occurrence",[business,routineId,1,"2026-11-02","2026-11-02T16:00:00Z",catchUpNow]);
      expect(abandoned).not.toBeNull();
      await admin.query("update public.supervisor_routine_occurrences set lease_until='2026-11-06T17:59:00Z',attempts=5 where business_id=$1 and run_id=$2",[business,abandoned.run_id]);
      const retryDates=await workerA.query("select local_date::text,scheduled_for_utc from public.supervisor_due_routine_dates($1,$2,$3,$4)",candidateArgs);
      expect(retryDates.rows.find(x=>x.local_date==="2026-11-02")?.scheduled_for_utc.toISOString()).toBe("2026-11-02T16:00:00.000Z");
      expect(await call(workerB,"supervisor_claim_current_routine_occurrence",[business,routineId,1,"2026-11-02","2026-11-02T16:00:00Z",catchUpNow])).toBeNull();
      expect((await admin.query("select state,last_error,lease_token from public.supervisor_routine_occurrences where business_id=$1 and run_id=$2",[business,abandoned.run_id])).rows).toEqual([{state:"failed",last_error:"lease_expired",lease_token:null}]);
      const claimArgs=[business,routineId,"2026-11-01","2026-11-01T16:00:00Z","2026-11-01T16:02:00Z"];
      const [a,b]=await Promise.all([
        call(workerA,"claim_supervisor_routine_occurrence",claimArgs),
        call(workerB,"claim_supervisor_routine_occurrence",claimArgs),
      ]);
      const claimed=a??b;
      expect(Boolean(a) !== Boolean(b)).toBe(true);
      expect(claimed.run_id).toBeTruthy();
      const other=await call(workerB,"claim_supervisor_routine_occurrence",
        [business,secondRoutine,"2026-11-01","2026-11-01T16:00:00Z","2026-11-01T16:02:00Z"]);
      expect(other.run_id).not.toBe(claimed.run_id);
      const sourceId="routine-source-"+randomUUID();
      await admin.query("insert into public.operating_tasks(business_id,id,agent_id,kind,status,payload,confidence,evidence) values ($1,$2,'leo','data_quality','needs_owner','{}','high','[]')",
        [business,sourceId]);
      const noticeArgs=[business,ownerId,threadId,"operating_task",sourceId,
        "1".repeat(64),"2".repeat(64),"Owner task needs review",
        "2026-11-01T16:03:00Z",routineId,claimed.run_id,claimed.lease_token];
      expect(await call(workerA,"post_supervisor_priority_notice",noticeArgs)).toBe(true);
      expect(await call(workerB,"post_supervisor_priority_notice",noticeArgs)).toBe(false);
      // A concurrent retry may wait on the same unique key; only the actual
      // transaction that inserted the notice may claim a fresh delivery.
      expect((await admin.query("select count(*)::int n from public.operating_tasks where business_id=$1 and kind='priority_notice'",
        [business])).rows[0].n).toBe(1);
      const complete=[business,routineId,claimed.run_id,claimed.lease_token,
        true,"priority-check:1","2026-11-01T16:03:00Z"];
      expect(await call(workerA,"finish_supervisor_routine_occurrence",complete)).toBe(true);
      expect(await call(workerB,"claim_supervisor_routine_occurrence",claimArgs)).toBeNull();
      const proof=await admin.query("select count(*)::int as n from public.operating_tasks where business_id=$1 and kind='priority_notice'",[business]);
      expect(proof.rows[0].n).toBe(1);
      // A handled source closes its notice in the same database transaction;
      // the private receipt must never remain a second independent Needs-you.
      await admin.query("update public.operating_tasks set status='handled' where business_id=$1 and id=$2",
        [business,sourceId]);
      const settled=await admin.query("select status,resolved_at from public.operating_tasks where business_id=$1 and kind='priority_notice'",
        [business]);
      expect(settled.rows).toHaveLength(1);
      expect(settled.rows[0].status).toBe("handled");
      expect(settled.rows[0].resolved_at).not.toBeNull();
      const alertId=randomUUID();
      await admin.query("insert into public.alerts(id,business_id,kind,status,payload) values ($1,$2,'meal_break','new','{}')",
        [alertId,business]);
      const alertKey="4".repeat(64);
      expect(await call(workerA,"post_supervisor_priority_notice",[
        business,ownerId,threadId,"alert",alertId,"3".repeat(64),
        alertKey,"Actionable café alert needs review","2026-11-01T16:04:00Z",
        null,null,null,
      ])).toBe(true);
      await admin.query("update public.alerts set status='dismissed' where business_id=$1 and id=$2",
        [business,alertId]);
      const alertReceipt=await admin.query(
        "select status,resolved_at from public.operating_tasks where business_id=$1 and id=$2",
        [business,"priority:"+alertKey]);
      expect(alertReceipt.rows[0].status).toBe("handled");
      expect(alertReceipt.rows[0].resolved_at).not.toBeNull();
      const updated=await call(owner,"change_supervisor_routine",
        [business,ownerId,threadId,secondRoutine,1,JSON.stringify({status:"paused"})]);
      expect(updated.status).toBe("paused");
      await expect(call(owner,"change_supervisor_routine",
        [business,ownerId,threadId,secondRoutine,1,JSON.stringify({status:"active"})]))
        .rejects.toThrow();
      const revoked=await call(owner,"change_supervisor_routine",
        [business,ownerId,threadId,secondRoutine,2,JSON.stringify({status:"revoked"})]);
      expect(revoked.status).toBe("revoked");
      expect(await call(workerB,"claim_supervisor_routine_occurrence",
        [business,secondRoutine,"2026-11-02","2026-11-02T16:00:00Z","2026-11-02T16:02:00Z"]))
        .toBeNull();
      await expect(call(owner,"change_supervisor_routine",
        [business,ownerId,threadId,secondRoutine,3,JSON.stringify({status:"active"})]))
        .rejects.toThrow();
    }finally{
      await Promise.all([owner?.end(),workerA?.end(),workerB?.end()]);
      await admin.query("delete from public.businesses where id=any($1::uuid[])",[[business,otherBusiness]]);
      await admin.query("delete from auth.users where id=any($1::uuid[])",[[ownerId,otherOwner]]);
      await admin.end();
    }
  },120_000);
});


describe("U4 migrated model-objective and autonomous Watch SQL contract",()=>{
  (sandbox?it:it.skip)("stores original owner goal, fences exact lease, posts one private proof and silences irrelevant Watch",async()=>{
    const admin=await connect("postgres");
    const business=randomUUID(),ownerId=randomUUID(),threadId=randomUUID();
    const ownerMessageId=randomUUID(),editMessageId=randomUUID(),goalEditMessageId=randomUUID(),routineId=randomUUID();
    const scheduleAnswerId=randomUUID(),clarifiedRoutineId=randomUUID();
    let owner:Client|undefined,worker:Client|undefined;
    try{
      await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
        [ownerId,"u4-"+ownerId+"@example.invalid"]);
      await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Disposable U4 café','America/Los_Angeles',false)",[business]);
      await admin.query("insert into public.cafe_access(business_id,mode) "+
        "values($1,'grandfathered') on conflict(business_id) do update "+
        "set mode='grandfathered',access_end=null",[business]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[business,ownerId]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
        [threadId,business,ownerId,randomUUID()]);
      const original="Every morning, check staffing, stock and changing sales. Investigate cross-domain issues that matter.";
      const edit="Keep checking staffing, inventory and demand, but explain relevant recurring costs too.";
      const goalEdit="Change my morning objective: compare cash pressure with inventory and expected local demand.";
      for(const [id,msg] of [[ownerMessageId,original],[editMessageId,edit],[goalEditMessageId,goalEdit]]){
        await admin.query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) values ($1,$2,$3,$4,$4,'owner','text',$5,$6)",
          [id,business,threadId,ownerId,msg,randomUUID()]);
      }
      // A later owner reply only fills in scheduling; it must NOT become the
      // entire persisted research objective or lose the original owner source.
      await admin.query("insert into public.ai_messages(id,business_id,thread_id,owner_user_id,author_user_id,role,content_type,text_content,client_message_id) values ($1,$2,$3,$4,$4,'owner','text',$5,$6)",
        [scheduleAnswerId,business,threadId,ownerId,"Every Monday at nine.",randomUUID()]);
      owner=await connect("owner",ownerId);
      worker=await connect("service");
      const make=[business,ownerId,threadId,"Morning intelligence","daily",[],"08:00",routineId,ownerMessageId];
      const saved=await call(owner,"u4_create_objective_routine",make);
      expect(saved).toMatchObject({id:routineId,execution_mode:"objective",
        objective_text:original,objective_source_message_id:ownerMessageId,revision:1});
      expect((await call(owner,"u4_create_objective_routine",make)).id).toBe(routineId);
      const clarifiedArgs=[business,ownerId,threadId,"Monday research",
        "weekly",[1],"09:00",clarifiedRoutineId,scheduleAnswerId,ownerMessageId];
      const clarified=await call(owner,"u4_create_objective_routine",clarifiedArgs);
      expect(clarified).toMatchObject({
        id:clarifiedRoutineId,execution_mode:"objective",
        objective_source_message_id:ownerMessageId,
        objective_text:original+"\nOwner schedule clarification: Every Monday at nine.",
      });
      expect((await call(owner,"u4_create_objective_routine",clarifiedArgs)).id)
        .toBe(clarifiedRoutineId);
      // A fabricated or foreign goal source is not a valid replacement for
      // the original authenticated, chronological same-thread owner request.
      await expect(call(owner,"u4_create_objective_routine",[
        business,ownerId,threadId,"Forged goal","weekly",[1],"09:00",
        randomUUID(),scheduleAnswerId,randomUUID(),
      ])).rejects.toThrow();
      await expect(call(owner,"u4_create_objective_routine",
        [business,ownerId,threadId,"Forged","daily",[],"08:30",randomUUID(),randomUUID()]))
        .rejects.toThrow();
      const edited=await call(owner,"u4_edit_objective_routine",
        [business,ownerId,threadId,routineId,1,
          {title:"Morning intelligence and costs"},editMessageId]);
      expect(edited.revision).toBe(2);
      expect(edited.objective_text).toBe(original);
      expect(edited.objective_updates).toEqual([{
        sourceMessageId:editMessageId,text:edit,revision:2,
      }]);
      const goalOnly=await call(owner,"u4_edit_objective_routine",
        [business,ownerId,threadId,routineId,2,{},goalEditMessageId]);
      expect(goalOnly).toMatchObject({title:"Morning intelligence and costs",
        local_time:"08:00:00",revision:3});
      expect(goalOnly.objective_updates).toHaveLength(2);
      expect(goalOnly.objective_updates[1]).toMatchObject({
        sourceMessageId:goalEditMessageId,text:goalEdit,revision:3,
      });
      await expect(call(owner,"u4_edit_objective_routine",
        [business,ownerId,threadId,routineId,2,{},goalEditMessageId]))
        .rejects.toThrow();
      await expect(call(owner,"u4_edit_objective_routine",
        [business,ownerId,threadId,routineId,1,{title:"Stale change"},editMessageId]))
        .rejects.toThrow();
      await admin.query("update public.supervisor_routines set updated_at='2026-11-01T00:00:00Z' where business_id=$1 and id=$2",[business,routineId]);
      const createdWatch=await call(worker,"u4_ensure_watch_routine",
        [business,ownerId,threadId,"09:00"]);
      expect(typeof createdWatch).toBe("string");
      expect(await call(worker,"u4_ensure_watch_routine",
        [business,ownerId,threadId,"09:00"])).toBe(createdWatch);
      const persisted=await admin.query("select execution_mode,objective_source_message_id from public.supervisor_routines where business_id=$1 and id=$2",[business,createdWatch]);
      expect(persisted.rows).toEqual([{execution_mode:"watch",objective_source_message_id:null}]);
      await expect(call(owner,"u4_ensure_watch_routine",
        [business,ownerId,threadId,"09:00"])).rejects.toThrow();
      const now=new Date().toISOString();
      let first=await call(worker,"claim_supervisor_routine_occurrence",[
        business,routineId,"2026-11-20","2026-11-20T16:00:00Z",now,
      ]);
      expect(first?.run_id).toBeTruthy();
      expect(await call(worker,"claim_supervisor_routine_occurrence",[
        business,routineId,"2026-11-20","2026-11-20T16:00:00Z",now,
      ])).toBeNull();
      expect(await call(worker,"u4_routine_lease_active",[
        business,routineId,first.run_id,first.lease_token,
      ])).toBe(true);
      expect(await call(worker,"u4_routine_lease_active",[
        business,routineId,first.run_id,randomUUID(),
      ])).toBe(false);
      // U3 optional SQL research has a dedicated aggregate-only U4 ticket.
      // It cannot impersonate an interactive owner or an incident work lease.
      const scopeArgs=[business,ownerId,threadId,
        "routine",null,null,first.run_id,first.lease_token];
      const routineTicket=await call(worker,"u3_issue_research_scope",scopeArgs);
      expect(typeof routineTicket).toBe("string");
      expect(routineTicket.length).toBeGreaterThan(75);
      const readResearchScope=async(ticket:string)=>{
        await admin.query("begin");
        try{
          // PostgreSQL's admin role intentionally cannot SET ROLE into
          // aicafe_research_view_owner. Execute the SECURITY DEFINER verifier
          // directly; the existing U3 real-role DB suite independently checks
          // read-only SQL role permissions and cross-café data isolation.
          await admin.query("select set_config('aicafe.u3_research_scope',$1,true)",[ticket]);
          const scoped=await admin.query(
            "select business_id,owner_user_id,mode from u3_research_private.scope()");
          return scoped.rows;
        }finally{await admin.query("rollback");}
      };
      expect(await readResearchScope(routineTicket)).toEqual([{
        business_id:business,owner_user_id:ownerId,mode:"routine",
      }]);
      const tampered=routineTicket.slice(0,-1)+
        (routineTicket.endsWith("0")?"1":"0");
      expect(await readResearchScope(tampered)).toEqual([]);
      await expect(call(owner,"u3_issue_research_scope",scopeArgs))
        .rejects.toThrow();
      await expect(call(worker,"u3_issue_research_scope",[
        business,randomUUID(),threadId,"routine",
        null,null,first.run_id,first.lease_token,
      ])).rejects.toThrow();
      await expect(call(worker,"u3_issue_research_scope",[
        business,ownerId,threadId,"routine",
        null,null,first.run_id,randomUUID(),
      ])).rejects.toThrow();

      // The child runs the ACTUAL registered runAgentTurn and get_sales
      // against this disposable source row with a recorded (free) provider.
      // Kill only after its real tool result committed the production U4
      // checkpoint. No direct SQL call pretending to be a model/tool event.
      await admin.query("insert into public.daily_rollups("+
        "business_id,business_date,net_sales_cents,orders_count,drinks_count,"+
        "ingredients_cents,staff_wages_cents,staff_tax_cents,card_fees_cents,"+
        "voids_cents,sales_data_status) "+
        "values($1,'2026-11-20',4875,9,9,1200,0,0,0,0,'actual')",
        [business]);
      const originalLease=first.lease_token;
      const directory=mkdtempSync(join(tmpdir(),"u4-actual-loop-"));
      const marker=join(directory,"checkpoint.txt");
      const startChild=(mode:"crash"|"resume",token:string)=>{
        const child=spawn(process.execPath,[
          "node_modules/vitest/vitest.mjs","run",
          "lib/ai/supervisor/routines/u4ActualLoopProcess.test.ts",
          "--reporter=dot","--maxWorkers=1","--fileParallelism=false","--pool=threads",
        ],{
          cwd:process.cwd(),
          env:{...process.env,SUPERVISOR_ROUTINES_DB_SANDBOX_ONLY:"1",
            SUPERVISOR_OPENAI_MODEL:"gpt-6-luna",
            U4_ACTUAL_LOOP_CHILD:"1",U4_PROCESS_MODE:mode,
            U4_PROCESS_MARKER:marker,
            U4_CRASH_BUSINESS:business,U4_CRASH_ROUTINE:routineId,
            U4_CRASH_RUN:first.run_id,U4_CRASH_LEASE:token,
            U4_CRASH_OWNER:ownerId,U4_CRASH_THREAD:threadId},
          stdio:["ignore","pipe","pipe"],
        });
        let diagnostics="";
        for(const stream of [child.stdout,child.stderr])
          stream.on("data",(chunk:Buffer)=>{
            diagnostics=(diagnostics+chunk.toString("utf8")).slice(-4500);
          });
        return {child,diagnostics:()=>diagnostics};
      };
      try{
        const crashed=startChild("crash",originalLease);
        const deadline=Date.now()+45_000;
        while(!existsSync(marker)&&Date.now()<deadline&&
          crashed.child.exitCode===null&&crashed.child.signalCode===null)
          await sleep(80);
        if(!existsSync(marker)){
          crashed.child.kill("SIGKILL");
          throw Error("u4_actual_registered_tool_checkpoint_timeout:"+
            crashed.diagnostics());
        }
        expect(readFileSync(marker,"utf8")).toBe("tool_complete_committed\n");
        crashed.child.kill("SIGKILL");
        const [crashCode,crashSignal]=await once(crashed.child,"exit");
        expect(crashCode).toBeNull();
        expect(crashSignal).toBe("SIGKILL");
      }finally{rmSync(directory,{recursive:true,force:true});}
      const observed=await admin.query("select u4_checkpoint,run_id,state,attempts "+
        "from public.supervisor_routine_occurrences where business_id=$1 and routine_id=$2 "+
        "and run_id=$3",[business,routineId,first.run_id]);
      expect(observed.rows).toHaveLength(1);
      expect(observed.rows[0].u4_checkpoint).toMatchObject({
        lastStage:"tool_complete",
      });
      expect(observed.rows[0]).toMatchObject({run_id:first.run_id,state:"running"});
      expect(Number(observed.rows[0].attempts)).toBe(1);
      // Simulate lease expiry after the genuine process death; this advances
      // only disposable fixture state, not a production clock.
      await admin.query("update public.supervisor_routine_occurrences "+
        "set lease_until=now()-interval '1 second' where business_id=$1 and run_id=$2",
        [business,first.run_id]);
      const resumed=await call(worker,"claim_supervisor_routine_occurrence",[
        business,routineId,"2026-11-20","2026-11-20T16:00:00Z",new Date().toISOString(),
      ]);
      expect(resumed?.run_id).toBe(first.run_id);
      expect(resumed?.lease_token).not.toBe(originalLease);
      expect(await call(worker,"u4_routine_lease_active",[
        business,routineId,first.run_id,originalLease,
      ])).toBe(false);
      // Previously issued SQL tickets fail after the ORIGINAL worker lease
      // expires. A resumed run must receive a new scoped ticket.
      expect(await readResearchScope(routineTicket)).toEqual([]);
      const resumedTicket=await call(worker,"u3_issue_research_scope",[
        business,ownerId,threadId,"routine",null,null,
        resumed.run_id,resumed.lease_token,
      ]);
      expect(await readResearchScope(resumedTicket)).toHaveLength(1);
      expect(await call(worker,"u4_routine_lease_active",[
        business,routineId,resumed.run_id,resumed.lease_token,
      ])).toBe(true);
      first=resumed;
      // Resume the SAME work identity on another real process. It reads the
      // checkpoint only as historical progress, independently runs get_sales
      // again, reserves model calls against the same owner quota, and posts
      // through the production U4 report RPC.
      const resumeDirectory=mkdtempSync(join(tmpdir(),"u4-resumed-loop-"));
      const resumeMarker=join(resumeDirectory,"checkpoint.txt");
      const resumeProcess=spawn(process.execPath,[
        "node_modules/vitest/vitest.mjs","run",
        "lib/ai/supervisor/routines/u4ActualLoopProcess.test.ts",
        "--reporter=dot","--maxWorkers=1","--fileParallelism=false","--pool=threads",
      ],{
        cwd:process.cwd(),
        env:{...process.env,SUPERVISOR_ROUTINES_DB_SANDBOX_ONLY:"1",
          SUPERVISOR_OPENAI_MODEL:"gpt-6-luna",
          U4_ACTUAL_LOOP_CHILD:"1",U4_PROCESS_MODE:"resume",
          U4_PROCESS_MARKER:resumeMarker,
          U4_CRASH_BUSINESS:business,U4_CRASH_ROUTINE:routineId,
          U4_CRASH_RUN:first.run_id,U4_CRASH_LEASE:first.lease_token,
          U4_CRASH_OWNER:ownerId,U4_CRASH_THREAD:threadId},
        stdio:["ignore","pipe","pipe"],
      });
      let resumedDiagnostics="";
      for(const stream of [resumeProcess.stdout,resumeProcess.stderr])
        stream.on("data",(chunk:Buffer)=>{
          resumedDiagnostics=(resumedDiagnostics+chunk.toString("utf8")).slice(-4500);
        });
      let resumeCode:number|null=null;
      let resumeSignal:NodeJS.Signals|null=null;
      try{
        [resumeCode,resumeSignal]=await new Promise<[number|null,NodeJS.Signals|null]>((resolve,reject)=>{
          const timeout=setTimeout(()=>{
            resumeProcess.kill("SIGKILL");
            reject(Error("u4_actual_loop_resume_timeout:"+resumedDiagnostics));
          },65_000);
          resumeProcess.once("exit",(code,signal)=>{
            clearTimeout(timeout);resolve([code,signal]);
          });
          resumeProcess.once("error",error=>{
            clearTimeout(timeout);reject(error);
          });
        });
        expect(resumeCode,resumedDiagnostics).toBe(0);
        expect(resumeSignal).toBeNull();
        expect(readFileSync(resumeMarker,"utf8")).toBe("resumed_and_published\n");
      }finally{rmSync(resumeDirectory,{recursive:true,force:true});}
      expect(await call(worker,"u4_publish_objective_report",[
        business,routineId,first.run_id,first.lease_token,
        "A duplicate report.","attention",{
          sources:[],sourceCount:0,quality:"partial",missing:[],
          externalEffects:"not_attempted",
        },new Date().toISOString(),
      ])).toBe(false);
      const actualUsage=await admin.query("select status,model_call_count "+
        "from public.supervisor_system_usage_events "+
        "where business_id=$1 and owner_user_id=$2 "+
        "and source_type='routine' and source_id=$3",
        [business,ownerId,first.run_id]);
      // The pre-death provider call remains charged. Recovery cannot start
      // a new owner quota, reset its original run, or reuse a prior lease.
      expect(actualUsage.rows.length).toBeGreaterThanOrEqual(3);
      expect(actualUsage.rows.every(row=>row.status==="completed"&&
        Number(row.model_call_count)===1)).toBe(true);
      const audited=await admin.query("select state,receipt_ref,u4_result from public.supervisor_routine_occurrences where business_id=$1 and run_id=$2",[business,first.run_id]);
      expect(audited.rows[0].state).toBe("completed");
      expect(audited.rows[0].receipt_ref).toBe("u4-verified:"+first.run_id);
      expect(audited.rows[0].u4_result).toMatchObject({
        attention:"attention",proof:{sourceCount:1,quality:"verified",
          externalEffects:"not_attempted"},
      });
      const ownerReports=await admin.query("select grounding,structured_content from public.ai_messages where business_id=$1 and owner_user_id=$2 and role='supervisor' and grounding->'agentMetadata'->>'u4Kind'='routine'",[business,ownerId]);
      expect(ownerReports.rows).toHaveLength(1);
      expect(ownerReports.rows[0].grounding.agentMetadata.runId).toBe(first.run_id);
      expect(ownerReports.rows[0].structured_content[0].text).toContain("recorded sales");
    }finally{
      await owner?.end();await worker?.end();
      await admin.query("delete from public.businesses where id=$1",[business]);
      await admin.query("delete from auth.users where id=$1",[ownerId]);
      await admin.end();
    }
  });
  (sandbox?it:it.skip)("provisions a true unsolicited Watch without prior chat or detector",async()=>{
    const admin=await connect("postgres");
    const business=randomUUID(),foreignBusiness=randomUUID();
    const ownerId=randomUUID(),foreignOwner=randomUUID();
    let worker:Client|undefined,owner:Client|undefined;
    try{
      for(const [b,o] of [[business,ownerId],[foreignBusiness,foreignOwner]]){
        await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",
          [o,"u4-watch-"+o+"@example.invalid"]);
        await admin.query("insert into public.businesses(id,name,timezone,is_demo) values ($1,'Disposable autonomous café','America/Los_Angeles',false)",[b]);
        await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')",[b,o]);
      }
      expect((await admin.query("select count(*)::int n from public.ai_threads where business_id=any($1::uuid[])",[[business,foreignBusiness]])).rows[0].n).toBe(0);
      expect((await admin.query("select count(*)::int n from public.alerts where business_id=any($1::uuid[])",[[business,foreignBusiness]])).rows[0].n).toBe(0);
      worker=await connect("service");
      owner=await connect("owner",ownerId);
      await expect(call(owner,"u4_ensure_watch_thread",[business,ownerId]))
        .rejects.toThrow();
      await expect(call(worker,"u4_ensure_watch_thread",[foreignBusiness,ownerId]))
        .rejects.toThrow();
      const threadId=await call(worker,"u4_ensure_watch_thread",[business,ownerId]);
      const foreignThread=await call(worker,"u4_ensure_watch_thread",[foreignBusiness,foreignOwner]);
      expect(typeof threadId).toBe("string");
      expect(threadId).not.toBe(foreignThread);
      expect(await call(worker,"u4_ensure_watch_thread",[business,ownerId])).toBe(threadId);
      expect((await admin.query("select count(*)::int n from public.ai_threads where business_id=$1",[business])).rows[0].n).toBe(1);
      const first=await call(worker,"u4_ensure_watch_routine",
        [business,ownerId,threadId,"09:00"]);
      const again=await call(worker,"u4_ensure_watch_routine",
        [business,ownerId,threadId,"09:00"]);
      expect(again).toBe(first);
      const watch=await admin.query("select execution_mode,objective_source_message_id from public.supervisor_routines where business_id=$1 and id=$2",[business,first]);
      expect(watch.rows).toEqual([{execution_mode:"watch",objective_source_message_id:null}]);
      const scheduled=(await admin.query(
        "select to_char(((now() at time zone 'America/Los_Angeles')::date - 1),'YYYY-MM-DD') local_date,"+
        "(((now() at time zone 'America/Los_Angeles')::date - 1 + time '09:00') at time zone 'America/Los_Angeles') due")).rows[0];
      await admin.query("update public.supervisor_routines set updated_at=$3::timestamptz-interval '2 hours' where business_id=$1 and id=$2",
        [business,first,scheduled.due]);
      const claimed=await call(worker,"claim_supervisor_routine_occurrence",
        [business,first,scheduled.local_date,scheduled.due,new Date().toISOString()]);
      expect(claimed?.run_id).toBeTruthy();
      expect((await admin.query("select count(*)::int n from public.supervisor_routine_occurrences where business_id=$1 and routine_id=$2",[business,first])).rows[0].n).toBe(1);
      expect((await admin.query("select count(*)::int n from public.supervisor_routines where business_id=$1 and execution_mode='watch'",[business])).rows[0].n).toBe(1);
    }finally{
      await owner?.end();await worker?.end();
      await admin.query("delete from public.businesses where id=any($1::uuid[])",[[business,foreignBusiness]]);
      await admin.query("delete from auth.users where id=any($1::uuid[])",[[ownerId,foreignOwner]]);
      await admin.end();
    }
  },120_000);

});
