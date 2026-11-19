#!/usr/bin/env node
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const ensure=(condition,code)=>{if(!condition)throw Error("task17d_live:"+code);};
async function main(){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 ensure(env.AICAFE_SHARED_LUNA==="1"&&env.AICAFE_SHARED_LUNA_SCENARIO==="17d"&&
    env.AICAFE_SHARED_LUNA_CANDIDATE==="1"&&env.AICAFE_SHARED_LUNA_HEAD===env.HEAD_SHA,"trusted_shared_runner_required");
 const args=process.argv.slice(2);
 ensure(args.length===4&&args[0]==="--output"&&args[2]==="--scope-output","fresh_outputs_required");
 const outputs=[resolve(args[1]),resolve(args[3])],root=realpathSync(process.cwd());
 for(const path of outputs){
   const parent=realpathSync(dirname(path));
   ensure(parent!==root&&!parent.startsWith(root+sep)&&!existsSync(path),"private_output_required");
 }
 ensure(outputs[0]!==outputs[1],"distinct_outputs_required");
 const [{default:pg},{chromium,expect}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 const [cafe,other]=TEST_CAFES;
 ensure(cafe?.owner&&other?.owner&&cafe.businessId!==other.businessId,"two_cafes_required");
 const contexts=[],query=async(sql,args=[])=>(await db.query(sql,args)).rows;
 let calls=0;
 async function login(who,width){
   const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
   contexts.push(context);
   const page=await context.newPage();
   await page.goto("/en/login");
   await page.locator("#email").fill(who.owner.email);
   await page.locator("#login-password").fill(who.owner.password);
   await page.locator("form button[type=submit]").click();
   await expect(page.getByText(who.name,{exact:true}).first()).toBeVisible({timeout:30000});
   await page.setViewportSize({width,height:width===390?844:900});
   return {page,context};
 }
 await db.connect();
 try{
   const {page,context}=await login(cafe,390);
   const created=await context.request.post("/api/ai/threads",{headers:{Origin:"http://127.0.0.1:3000"},
     data:{requestId:randomUUID(),title:"Disposable 17D chat operations"}});
   ensure(created.status()===201,"thread_create_failed");
   const threadId=(await created.json()).thread?.id;
   ensure(/^[a-f0-9-]{36}$/.test(threadId??""),"thread_missing");
   const path="/en?thread="+encodeURIComponent(threadId);
   await page.goto(path);
   const scope={businessId:cafe.businessId,ownerUserId:cafe.owner.userId,threadId,otherCafeId:other.businessId};
   const title="Routine17D-"+randomUUID().slice(0,8);
   const schedule=async()=>query("select id,title,cadence,weekdays,local_time::text,timezone,status,revision from public.supervisor_routines where business_id=$1 and owner_user_id=$2 and thread_id=$3",[scope.businessId,scope.ownerUserId,threadId]);
   // Send through the actual browser composer, not a synthesized agent reply.
   async function turn(text){
     const composer=page.locator("#supervisor-home-composer");
     await expect(composer).toBeEnabled({timeout:30000});
     await composer.fill(text);await composer.press("Enter");
     let found=[];
     await expect.poll(async()=>{
       found=await query("select m.id,j.reply_message_id,j.status from public.ai_messages m join public.ai_agent_jobs j on j.business_id=m.business_id and j.owner_message_id=m.id where m.business_id=$1 and m.thread_id=$2 and m.role='owner' and m.text_content=$3",[scope.businessId,threadId,text]);
       return found.length===1?found[0].status:"missing";
     },{timeout:180000,intervals:[500,1000,2000]}).toBe("done");
     const row=found[0];ensure(row.reply_message_id,"reply_missing");
     const usage=await readPersistedModelUsage(db,scope.businessId,row.id);
     requireObservedProductionModel(usage.model,"gpt-6-luna");
     calls+=Number(usage.model_call_count);
     ensure(calls<=18,"shared_runner_call_ceiling");
     const reply=page.locator('[data-work-message="'+row.reply_message_id+'"]');
     await expect(reply).toBeVisible({timeout:30000});
     const owners=await query("select id from public.ai_messages where business_id=$1 and thread_id=$2 and id=$3 and role='supervisor'",[scope.businessId,threadId,row.reply_message_id]);
     ensure(owners.length===1,"persisted_reply_missing");
     return {id:row.reply_message_id,reply};
   }
   async function visibleRoutine(status,time,width){
     await page.setViewportSize({width,height:width===390?844:900});
     await page.getByRole("button",{name:"Library, routines and permissions"}).click();
     const drawer=page.getByRole("dialog",{name:"Supervisor controls"});
     await drawer.getByRole("button",{name:"Routines",exact:true}).click();
     const card=drawer.locator("article").filter({hasText:title});
     await expect(card).toHaveCount(1);
     await expect(card.getByText(status,{exact:true})).toBeVisible();
     await expect(card).toContainText(time);
     await expect(card).toContainText(cafe.timezone);
     ensure(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"viewport_overflow");
     await page.keyboard.press("Escape");await expect(drawer).toHaveCount(0);
   }
   ensure((await schedule()).length===0,"routine_already_exists");
   const first=await turn("Check my current standing Supervisor permissions and tell me their limits. Then create an internal saved routine named "+title+" every day at 08:15 in this cafe's local time to check recorded cafe evidence and report in app. I explicitly want this routine saved. Do not authorize or perform external actions.");
   let rows=await schedule();
   ensure(rows.length===1&&rows[0].title===title&&rows[0].status==="active"&&rows[0].cadence==="daily"&&
     rows[0].weekdays.length===0&&rows[0].local_time==="08:15:00"&&rows[0].timezone===cafe.timezone&&Number(rows[0].revision)===1,"create_readback_wrong");
   const routineId=rows[0].id;
   await visibleRoutine("active","08:15",390);
   await turn("Pause my saved routine "+title+" now. Keep its identity and schedule.");
   rows=await schedule();
   ensure(rows.length===1&&rows[0].id===routineId&&rows[0].status==="paused"&&Number(rows[0].revision)===2,"pause_readback_wrong");
   await visibleRoutine("paused","08:15",1440);
   await turn("Edit that same saved routine "+title+" to run daily at 09:30 local time, then resume it. Do not create another routine.");
   rows=await schedule();
   ensure(rows.length===1&&rows[0].id===routineId&&rows[0].status==="active"&&rows[0].local_time==="09:30:00"&&Number(rows[0].revision)===4,"edit_resume_readback_wrong");
   await visibleRoutine("active","09:30",390);
   // A unique file-only marker cannot be recovered from the owner prompt.
   const marker="cafe-file-"+randomUUID().replaceAll("-","");
   const bytes=Buffer.from("record,value\nreference,"+marker+"\n");
   const filename="owner-evidence.csv",url="/api/ai/threads/"+threadId+"/attachments";
   const pending=page.waitForResponse(r=>new URL(r.url()).pathname===url&&r.request().method()==="POST");
   await page.locator('input[type=file]').setInputFiles({name:filename,mimeType:"text/csv",buffer:bytes});
   const uploaded=await pending;ensure(uploaded.status()===201,"file_upload_failed");
   const attachment=(await uploaded.json()).attachment;
   const fileRows=await query("select id,original_name,bytes,media_type from public.ai_attachments where business_id=$1 and owner_user_id=$2 and thread_id=$3 and id=$4",[scope.businessId,scope.ownerUserId,threadId,attachment.id]);
   ensure(fileRows.length===1&&fileRows[0].original_name===filename&&fileRows[0].bytes===bytes.length&&fileRows[0].media_type==="text/csv","file_readback_wrong");
   const download=await context.request.get(url+"/"+attachment.id);
   ensure(download.ok()&&(await download.body()).equals(bytes),"file_original_mismatch");
   await expect(page.getByRole("button",{name:"Remove "+filename})).toBeVisible();
   const answer=await turn("Read my attached CSV and tell me the exact value in its reference row. Do not change cafe records or permissions.");
   await expect(answer.reply).toContainText(marker);
   const foreign=await login(other,1440);
   const listing=await foreign.context.request.get("/api/ai/supervisor/routines");
   ensure(listing.ok()&&!(await listing.json()).routines.some(r=>r.id===routineId),"foreign_routine_visible");
   for(const location of [url,url+"/"+attachment.id]){
     const denied=await foreign.context.request.get(location,{maxRedirects:0});
     ensure([401,403,404].includes(denied.status()),"foreign_attachment_visible");
   }
   await turn("Permanently revoke my saved routine "+title+". I confirm I want it stopped permanently. Do not create a replacement.");
   rows=await schedule();
   ensure(rows.length===1&&rows[0].id===routineId&&rows[0].status==="revoked"&&Number(rows[0].revision)===5,"revoke_readback_wrong");
   await page.reload();await visibleRoutine("revoked","09:30",1440);
   ensure((await query("select id from public.supervisor_proposals where business_id=$1 and thread_id=$2",[scope.businessId,threadId])).length===0,"unrequested_proposal");
   const proof={schema_version:1,id:"17d",head_sha:env.HEAD_SHA,status:"passed",observed_model:"gpt-6-luna",
     modelCalls:calls,checks:{actualComposer:true,routineLifecycle:true,uniqueFileContent:true,foreignDenied:true,bothViewports:true,noUnrequestedProposal:true}};
   Object.assign(scope,{routineId,routineTitle:title,attachmentId:attachment.id,createReplyId:first.id,fileReplyId:answer.id,expectedProviderCalls:calls});
   writeFileSync(outputs[0],JSON.stringify(proof)+"\n",{mode:0o600,flag:"wx"});
   writeFileSync(outputs[1],JSON.stringify(scope)+"\n",{mode:0o600,flag:"wx"});
 }finally{
   for(const context of contexts)await context.close().catch(()=>{});
   await browser.close().catch(()=>{});await db.end().catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e instanceof Error&&e.message.startsWith("task17d_live:")?e.message:"task17d_live:assertion_or_transport_failed");process.exitCode=1;});
