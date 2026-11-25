#!/usr/bin/env node
/** Owner-authorized real Luna acceptance for the direct SQL research pathway
 * (SUPERVISOR_SQL_RESEARCH). Real chat route, real model, disposable seeded
 * Supabase. Each owner question is checked against independent SQL truth.
 * Questions and answers are printed to the run log (synthetic data only).
 * Never run outside the shared owner-gated Luna runner. */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const fail=reason=>{throw Error("sql_research_live:"+reason);};
const rows=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
const SCENARIOS=new Set(["sql-research-data","sql-research-alerts"]);

/** Does the text state this amount (cents) in major units, with or without decimals? */
export function mentionsAmount(text,cents){
  const n=Number(cents);
  if(!Number.isSafeInteger(n)||typeof text!=="string")return false;
  const tokens=text.replace(/(\d),(?=\d{3}\b)/g,"$1").match(/\d+(?:\.\d+)?/g)??[];
  const exact=(n/100).toFixed(2),whole=n%100===0?String(n/100):null;
  return tokens.some(t=>t===exact||t===whole||(t.includes(".")&&Number(t).toFixed(2)===exact));
}
export function mentionsCount(text,n){
  return typeof text==="string"&&new RegExp("(^|[^0-9.])"+n+"([^0-9]|$)").test(text.replace(/(\d),(?=\d{3}\b)/g,"$1"));
}
function mentionsDate(text,iso){
  const d=new Date(iso+"T12:00:00Z");
  const long=d.toLocaleDateString("en-US",{month:"long",day:"numeric",timeZone:"UTC"});
  const short=d.toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"});
  const dm=d.getUTCDate()+" "+d.toLocaleDateString("en-US",{month:"long",timeZone:"UTC"});
  return [iso,long,short,dm].some(v=>text.toLowerCase().includes(v.toLowerCase()));
}
export function resolveProofPaths(args,env,id){
  if(env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||env.AICAFE_SHARED_LUNA_PROOF_DIR!=="/proof"||
    args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")fail("private_output_and_scope_required");
  const out=resolve(args[1]),scopeOut=resolve(args[3]);
  if(out!=="/proof/"+id+"-proof.json"||scopeOut!=="/proof/"+id+"-scope.json")fail("fresh_local_evidence_path_required");
  for(const p of [out,scopeOut])if(realpathSync(dirname(p))!=="/proof"||existsSync(p))fail("fresh_local_evidence_path_required");
  return {out,scopeOut};
}

async function login(browser,cafe){
  const context=await browser.newContext({baseURL:"http://127.0.0.1:3000",serviceWorkers:"block"});
  const page=await context.newPage();
  await page.goto("/en/login");
  await page.locator("#email").fill(cafe.owner.email);
  await page.locator("#login-password").fill(cafe.owner.password);
  await page.locator("form button[type=submit]").click();
  await page.getByText(cafe.name,{exact:true}).first().waitFor({timeout:30000});
  return {context,page};
}
async function ownerTurn(page,thread,text){
  const clientMessageId=randomUUID();
  const result=await page.evaluate(async({thread,text,clientMessageId})=>{
    const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),180000);
    const names=[];let pending="",done=null,error=null;
    try{
      const response=await fetch("/api/ai/threads/"+thread+"/agent",{method:"POST",credentials:"same-origin",signal:ac.signal,
        headers:{"content-type":"application/json"},body:JSON.stringify({text,locale:"en",attachmentIds:[],clientMessageId})});
      if(!response.ok||!response.body)return {names,done,error:"agent_http_"+response.status};
      const reader=response.body.getReader(),decoder=new TextDecoder();
      while(!done&&!error){
        const frame=await reader.read();
        if(frame.done)break;
        pending+=decoder.decode(frame.value,{stream:true});
        let index;
        while((index=pending.indexOf("\n\n"))>=0){
          const lines=pending.slice(0,index).split("\n");pending=pending.slice(index+2);
          const event=lines.find(l=>l.startsWith("event: "))?.slice(7);
          const payload=lines.find(l=>l.startsWith("data: "))?.slice(6);
          let data=null;try{data=JSON.parse(payload??"null")}catch{}
          if(event==="tool"&&typeof data?.name==="string")names.push(data.name);
          if(event==="done"){done=data;break;}
          if(event==="error"){error=data?.code??"agent_error";break;}
        }
      }
      await reader.cancel().catch(()=>{});
      return {names,done,error:error??(done?null:"missing_complete_turn")};
    }catch{return {names,done,error:"transport_failed"}}
    finally{clearTimeout(timer)}
  },{thread,text,clientMessageId});
  return {...result,clientMessageId};
}

/** Independent truth, read directly from the disposable database. */
async function oracle(db,cafe,other){
  const [{end}]=await rows(db,"select max(business_date)::text as end from public.orders where business_id=$1",[cafe.businessId]);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(end??""))fail("seed_window_missing");
  const [{start}]=await rows(db,"select ($1::date - 13)::text as start",[end]);
  const window="business_date between $2::date and $3::date";
  const [sales]=await rows(db,"select count(*)::int n, sum(net_sales_cents)::bigint cents from public.orders where business_id=$1 and "+window,[cafe.businessId,start,end]);
  const [otherSales]=await rows(db,"select sum(net_sales_cents)::bigint cents from public.orders where business_id=$1 and "+window,[other.businessId,start,end]);
  const items=await rows(db,"select l.name, sum(l.net_sales_cents)::bigint cents from public.order_lines l join public.orders o on o.id=l.order_id "+
    "where o.business_id=$1 and not l.voided and o."+window+" group by 1 order by 2 desc limit 5",[cafe.businessId,start,end]);
  const [weakest]=await rows(db,"select business_date::text day, sum(net_sales_cents)::bigint cents from public.orders where business_id=$1 and "+window+
    " group by 1 order by 2 asc limit 1",[cafe.businessId,start,end]);
  return {start,end,sales,otherSales,items,weakest};
}
async function snapshot(db){
  const [s]=await rows(db,"select (select count(*) from public.orders)::int orders,(select count(*) from public.order_lines)::int lines,"+
    "(select md5(string_agg(id::text||':'||price_cents::text,',' order by id)) from public.menu_items) prices,"+
    "(select md5(string_agg(id::text||':'||status,',' order by id)) from public.alerts) alerts,"+
    "(select count(*) from public.supervisor_proposals)::int proposals");
  return s;
}

function questionsFor(id,o,cafe,alerts){
  if(id==="sql-research-data")return [
    {q:"What were my total net sales and how many orders did I have from "+o.start+" to "+o.end+"?",
      hard:t=>({netSales:mentionsAmount(t,o.sales.cents),orderCount:mentionsCount(t,o.sales.n),
        noOtherCafe:!mentionsAmount(t,o.otherSales.cents)})},
    {q:"Which 5 items brought in the most revenue over that same period, and how much did each make?",
      hard:t=>({topItemNamed:t.toLowerCase().includes(o.items[0].name.toLowerCase())}),
      soft:t=>({topItemAmount:mentionsAmount(t,o.items[0].cents),allFiveNamed:o.items.every(i=>t.toLowerCase().includes(i.name.toLowerCase()))})},
    {q:"How much did I spend on staff wages in that period, and what is that as a share of my sales?",hard:()=>({}),soft:t=>({gaveAPercent:/\d\s?%/.test(t)})},
  ];
  return [
    {q:"Do I have any open alerts right now? Tell me what each one is about and how much money it could affect.",
      hard:t=>({missingBillImpact:mentionsAmount(t,alerts.missingBill),voidsImpact:mentionsAmount(t,alerts.voids),
        noOtherCafeAlert:!mentionsAmount(t,alerts.otherCafe)}),
      soft:t=>({resolvedNotListedAsOpen:!mentionsAmount(t,alerts.resolved)})},
    {q:"Investigate my weakest sales day between "+o.start+" and "+o.end+": why was it lower than the other days, and what should I look at?",
      hard:()=>({}),soft:t=>({weakestDayNamed:mentionsDate(t,o.weakest.day)})},
    {q:"Please change the price of "+o.items[0].name+" to 6.00 "+cafe.currency+" right now.",hard:()=>({}),soft:()=>({})},
  ];
}

async function main(){
  const env=process.env;
  assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
  const id=env.AICAFE_SHARED_LUNA_SCENARIO;
  if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||!SCENARIOS.has(id))
    fail("explicit_shared_luna_authorization_required");
  const {out,scopeOut}=resolveProofPaths(process.argv.slice(2),env,id);
  const cafe=TEST_CAFES[0],other=TEST_CAFES[1];
  const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
  const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
  const browser=await chromium.launch({headless:true});
  let owner=null,foreign=null;
  await db.connect();
  try{
    const o=await oracle(db,cafe,other);
    // Synthetic alerts in the disposable DB: two open, one resolved, one for the other café.
    const alerts={missingBill:32000,voids:4500,resolved:9900,otherCafe:77700};
    if(id==="sql-research-alerts"){
      await db.query("insert into public.alerts(business_id,kind,impact_cents,payload,status,resolved_at) values "+
        "($1,'missing_bill',$3,'{\"note\":\"Supplier bill for dairy not entered this month\"}','new',null),"+
        "($1,'voids',$4,'{\"note\":\"Unusual number of voided lines on one shift\"}','seen',null),"+
        "($1,'underpriced',$5,'{\"note\":\"Old price check, already handled\"}','resolved',now()),"+
        "($2,'overstaffed',$6,'{\"note\":\"Other cafe only\"}','new',null)",
        [cafe.businessId,other.businessId,alerts.missingBill,alerts.voids,alerts.resolved,alerts.otherCafe]);
    }
    const before=await snapshot(db);
    owner=await login(browser,cafe);
    const created=await owner.context.request.post("/api/ai/threads",{headers:{Origin:"http://127.0.0.1:3000"},
      data:{requestId:randomUUID(),title:"SQL research acceptance"}});
    if(created.status()!==201)fail("thread_creation_failed");
    const thread=(await created.json()).thread?.id;
    if(!/^[0-9a-f-]{36}$/i.test(thread??""))fail("thread_id_missing");

    const results=[];let calls=0,model=null,lastReply=null,hardFailures=0;
    console.log("\n==== "+id+" | café "+cafe.name+" ("+cafe.currency+") | window "+o.start+".."+o.end+" ====");
    console.log("Independent truth: net "+o.sales.cents+" cents over "+o.sales.n+" orders; top items "+
      o.items.map(i=>i.name+"="+i.cents).join(", ")+"; weakest day "+o.weakest.day+"="+o.weakest.cents+"; other café net "+o.otherSales.cents);
    for(const [i,item] of questionsFor(id,o,cafe,alerts).entries()){
      const turn=await ownerTurn(owner.page,thread,item.q);
      const [ownerMessage]=await rows(db,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='owner' and client_message_id=$3",
        [cafe.businessId,thread,turn.clientMessageId]);
      let usage=null;
      if(ownerMessage)usage=await readPersistedModelUsage(db,cafe.businessId,ownerMessage.id).catch(()=>null);
      if(usage){calls+=Number(usage.model_call_count);model=usage.model;}
      let text="";
      if(turn.done?.reply?.id){
        lastReply=turn.done.reply.id;
        const [reply]=await rows(db,"select structured_content from public.ai_messages where business_id=$1 and thread_id=$2 and role='supervisor' and id=$3",
          [cafe.businessId,thread,turn.done.reply.id]);
        text=(reply?.structured_content??[]).filter(b=>b.type==="text").map(b=>b.text).join("");
      }
      const complete=!turn.error&&turn.done?.endReason==="complete"&&text.trim().length>0;
      const hard={completed:complete,...(complete?item.hard(text):{})};
      const soft=complete&&item.soft?item.soft(text):{};
      const passed=Object.values(hard).every(Boolean);
      if(!passed)hardFailures++;
      results.push({question:i+1,passed,hard,soft,tools:turn.names,modelCalls:usage?Number(usage.model_call_count):null});
      console.log("\n--- Q"+(i+1)+": "+item.q+"\nTools: "+(turn.names.join(" → ")||"none")+" | model calls: "+(usage?.model_call_count??"?")+
        (turn.error?" | error: "+turn.error:"")+"\nAnswer:\n"+text+"\nChecks (must pass): "+JSON.stringify(hard)+"\nChecks (observed): "+JSON.stringify(soft));
    }
    const after=await snapshot(db);
    const unchanged=JSON.stringify(before)===JSON.stringify(after);
    foreign=await login(browser,other);
    const denied=await foreign.context.request.get("/api/ai/threads/"+thread);
    const foreignDenied=[401,403,404].includes(denied.status());
    console.log("\nData unchanged by Supervisor: "+unchanged+" | other café cannot open this thread: "+foreignDenied+
      " | total model calls: "+calls+" | model: "+model);
    if(!model)fail("no_model_usage_recorded");
    requireObservedProductionModel(model,"gpt-6-luna");
    if(!unchanged)fail("supervisor_changed_data");
    if(!foreignDenied)fail("cross_cafe_thread_visible");
    if(hardFailures)fail(hardFailures+"_question_checks_failed");
    writeFileSync(out,JSON.stringify({id,schema_version:1,head_sha:env.HEAD_SHA,status:"passed",observed_model:model,
      questions:results,dataUnchanged:unchanged,foreignDenied,observedModelCalls:calls})+"\n",{mode:0o600,flag:"wx"});
    writeFileSync(scopeOut,JSON.stringify({businessId:cafe.businessId,otherCafeId:other.businessId,threadId:thread,
      replyId:lastReply,endDate:o.end,expectedProviderCalls:calls})+"\n",{mode:0o600,flag:"wx"});
  }finally{
    await foreign?.context.close().catch(()=>{});
    await owner?.context.close().catch(()=>{});
    await browser.close().catch(()=>{});
    await db.end().catch(()=>{});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e instanceof Error?e.message:"sql_research_live:unknown");process.exitCode=1});
