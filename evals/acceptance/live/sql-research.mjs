#!/usr/bin/env node
/** Owner-authorized real Luna acceptance of the SQL research pathway: real chat route and model on the
 * disposable seeded stack, each answer checked against independent SQL; Q&A printed (synthetic data). */
import {randomUUID} from "node:crypto";
import {existsSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,dirname} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";
import {login,ownerTurn as completedTurn} from "./u3-canonical-research.mjs";
const CUSTOMERS={loyal:"cust-ana-ruiz",lapsed:"cust-ben-carter"};

const fail=reason=>{throw Error("sql_research_live:"+reason);};
const rows=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
const SCENARIOS=new Set(["business","profit","staffing","attention","pricing","brief","customers","presentation"].map(x=>"sql-research-"+x));

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
  const d=new Date(iso+"T12:00:00Z"),f=o=>d.toLocaleDateString("en-US",{...o,timeZone:"UTC"});
  return [iso,f({month:"long",day:"numeric"}),f({month:"short",day:"numeric"}),d.getUTCDate()+" "+f({month:"long"})]
    .some(v=>text.toLowerCase().includes(v.toLowerCase()));
}
export function resolveProofPaths(args,env,id){
  if(env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||env.AICAFE_SHARED_LUNA_PROOF_DIR!=="/proof"||
    args.length!==4||args[0]!=="--output"||args[2]!=="--scope-output")fail("private_output_and_scope_required");
  const out=resolve(args[1]),scopeOut=resolve(args[3]);
  if(out!=="/proof/"+id+"-proof.json"||scopeOut!=="/proof/"+id+"-scope.json")fail("fresh_local_evidence_path_required");
  for(const p of [out,scopeOut])if(realpathSync(dirname(p))!=="/proof"||existsSync(p))fail("fresh_local_evidence_path_required");
  return {out,scopeOut};
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
  const [weakest]=await rows(db,"select business_date::text as day, sum(net_sales_cents)::bigint cents from public.orders where business_id=$1 and "+window+
    " group by 1 order by 2 asc limit 1",[cafe.businessId,start,end]);
  const [endDay]=await rows(db,"select sum(net_sales_cents)::bigint cents from public.orders where business_id=$1 and business_date=$2::date",[cafe.businessId,end]);
  const daily=await rows(db,"select business_date::text as day,sum(net_sales_cents)::bigint cents from public.orders where business_id=$1 and "+window+" group by 1 order by 1",[cafe.businessId,start,end]);
  return {start,end,sales,otherSales,items,weakest,endDay,daily};
}
/** Synthetic customer IDs on this café's orders (disposable DB): one loyal regular, one regular who
 * stopped coming 8 days before the end of the window, and occasional guests. */
async function seedCustomers(db,cafe,end){
  await db.query("update public.orders o set customer_ref=case when r.rn%25=0 then $3 "+
    "when r.rn%40=7 and r.business_date<=$2::date-8 then $4 when r.rn%6=1 then 'cust-guest-'||(r.rn%50) end "+
    "from (select id,business_date,row_number() over (order by closed_at,id) rn from public.orders where business_id=$1) r where o.id=r.id",
    [cafe.businessId,end,CUSTOMERS.loyal,CUSTOMERS.lapsed]);
  const [top]=await rows(db,"select customer_ref ref from public.orders where business_id=$1 and customer_ref is not null "+
    "group by 1 order by sum(net_sales_cents) desc limit 1",[cafe.businessId]);
  if(top?.ref!==CUSTOMERS.loyal)fail("customer_seed_unexpected");
}
async function snapshot(db){
  const [s]=await rows(db,"select (select count(*) from public.orders)::int orders,(select count(*) from public.order_lines)::int lines,"+
    "(select md5(string_agg(id::text||':'||price_cents::text,',' order by id)) from public.menu_items) prices,"+
    "(select md5(string_agg(id::text||':'||status,',' order by id)) from public.alerts) alerts,"+
    "(select count(*) from public.supervisor_proposals)::int proposals");
  return s;
}
function questionsFor(id,o,alerts,currency){
  // Chief-of-staff questions: Luna chooses its own investigation; checks need facts from independent SQL.
  const deep=t=>({usedSqlMoreThanOnce:true,substantial:t.trim().length>=400});
  const said=(t,name)=>t.toLowerCase().replace(/[\s_]+/g,"-").includes(name.replace("cust-",""));
  const period=o.start+" to "+o.end;
  // Compare genuinely different sources using fixture-derived owner inputs.
  // These are hypothetical statements for the disposable café, not stored bills.
  const rent=Math.max(1,Math.floor(Number(o.sales.cents)/8)),bills=Math.max(1,Math.floor(Number(o.sales.cents)/20));
  const amount=cents=>new Intl.NumberFormat("en",{style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(cents/100);
  const values=blocks=>blocks.filter(b=>b.type==="rich_presentation").flatMap(b=>b.panels??[]);
  const expectedCounts=[1,2,3,4].map(i=>Math.max(1,Math.floor(o.sales.n/(i+5)))+i);
  if(id==="sql-research-presentation")return [
    {q:"Show me the pattern of daily net sales from "+period+" and the total.",
     hard:t=>({total:mentionsAmount(t,o.sales.cents)}),
     visual:blocks=>values(blocks).some(p=>["sql_research","response_evidence"].includes(p.source)&&["line","bar"].includes(p.kind)&&p.unit==="cents"&&p.currency===currency&&p.points.length===o.daily.length&&o.daily.every(d=>p.points.some(v=>v.label===d.day&&v.value===Number(d.cents))))},
    {q:"For that same period ("+period+") I paid "+amount(rent)+" in rent and "+amount(bills)+" in other bills. How do these two costs compare with recorded sales?",
     hard:t=>({total:mentionsAmount(t,o.sales.cents),ownerRent:mentionsAmount(t,rent),ownerBills:mentionsAmount(t,bills)}),
     visual:blocks=>values(blocks).some(p=>p.source==="response_evidence"&&p.currency===currency&&p.unit==="cents"&&p.points.length>=3&&[Number(o.sales.cents),rent,bills].every(n=>p.points.some(v=>v.value===n))&&/owner|historical/i.test(p.sourceDetail??""))},
    {q:"I'm planning a hypothetical four-day tasting event. My expected attendance is "+["Thursday","Friday","Saturday","Sunday"].map((day,i)=>day+" "+expectedCounts[i]).join(", ")+". What pattern do you see?",
     hard:t=>({ownerEstimatesStated:expectedCounts.every(n=>mentionsCount(t,n))}),
     noBusinessRead:true,
     visual:blocks=>values(blocks).some(p=>p.source==="response_evidence"&&p.unit==="count"&&p.points.length===expectedCounts.length&&expectedCounts.every(n=>p.points.some(v=>v.value===n))&&/owner/i.test(p.sourceDetail??""))},
  ];
  const q={
    "sql-research-business":{q:"How is my business doing over the last two weeks ("+period+"), and what should I focus on this week?",
      hard:t=>({...deep(t),netSalesStated:mentionsAmount(t,o.sales.cents),noOtherCafe:!mentionsAmount(t,o.otherSales.cents)})},
    "sql-research-profit":{q:"Am I making money? From "+period+", where is my money going, and which 3 changes are worth the most?",
      hard:t=>({...deep(t),netSalesStated:mentionsAmount(t,o.sales.cents)})},
    "sql-research-staffing":{q:"Plan next week's staffing for me from customer demand and labor cost, with specific shifts by day and hour.",
      hard:t=>({...deep(t),gaveHours:/\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b/i.test(t)})},
    "sql-research-attention":{q:"What needs my attention today (alerts, missing bills, voids, discounts), and what do you recommend I do?",
      hard:t=>({missingBillImpact:mentionsAmount(t,alerts.missingBill),voidsImpact:mentionsAmount(t,alerts.voids),
        noOtherCafeAlert:!mentionsAmount(t,alerts.otherCafe)}),soft:t=>({resolvedNotListedAsOpen:!mentionsAmount(t,alerts.resolved)})},
    "sql-research-pricing":{q:"Should I change any prices? Which items, by how much, and what impact should I expect?",
      hard:t=>({...deep(t),topItemConsidered:t.toLowerCase().includes(o.items[0].name.toLowerCase())})},
    "sql-research-brief":{q:"Give me the end-of-day brief for "+o.end+" and my plan for tomorrow.",
      hard:t=>({...deep(t),daySalesStated:mentionsAmount(t,o.endDay.cents)}),soft:t=>({dayNamed:mentionsDate(t,o.end)})},
    "sql-research-customers":{q:"Who are my best and most loyal customers, who has stopped coming, and how should I win them back?",
      hard:t=>({...deep(t),loyalNamed:said(t,CUSTOMERS.loyal),lapsedNamed:said(t,CUSTOMERS.lapsed)})},
  };
  return [q[id]];
}

async function main(){
  const env=process.env,id=env.AICAFE_SHARED_LUNA_SCENARIO;
  assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
  if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||!SCENARIOS.has(id))
    fail("explicit_shared_luna_authorization_required");
  const {out,scopeOut}=resolveProofPaths(process.argv.slice(2),env,id);
  const cafe=TEST_CAFES[0],other=TEST_CAFES[1];
  const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
  const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
  const browser=await chromium.launch({headless:true});
  let owner=null,foreign=null;await db.connect();
  try{
    const o=await oracle(db,cafe,other);
    // Synthetic alerts in the disposable DB: two open, one resolved, one for the other café.
    const alerts={missingBill:32000,voids:4500,resolved:9900,otherCafe:77700};
    if(id==="sql-research-customers")await seedCustomers(db,cafe,o.end);
    if(id==="sql-research-attention"){
      for(const [cafeId,kind,cents,note,status] of [[cafe.businessId,"missing_bill",alerts.missingBill,"Dairy supplier bill not entered this month","new"],
        [cafe.businessId,"voids",alerts.voids,"Unusual number of voided lines on one shift","seen"],[cafe.businessId,"underpriced",alerts.resolved,"Old price check, handled","resolved"],
        [other.businessId,"overstaffed",alerts.otherCafe,"Other cafe only","new"]])await db.query("insert into public.alerts(business_id,kind,impact_cents,payload,status,resolved_at) "+
        "values ($1,$2,$3,jsonb_build_object('note',$4::text),$5,case when $5='resolved' then now() end)",[cafeId,kind,cents,note,status]);
    }
    const before=await snapshot(db);
    owner=await login(browser,cafe);
    const created=await owner.context.request.post("/api/ai/threads",{headers:{Origin:"http://127.0.0.1:3000"},data:{requestId:randomUUID(),title:"SQL research acceptance"}});
    if(created.status()!==201)fail("thread_creation_failed");
    const thread=(await created.json()).thread?.id;if(!/^[0-9a-f-]{36}$/i.test(thread??""))fail("thread_id_missing");
    const results=[];let calls=0,model=null,lastReply=null,hardFailures=0;
    console.log("\n==== "+id+" | café "+cafe.name+" ("+cafe.currency+") | window "+o.start+".."+o.end+" ====");
    console.log("Independent truth: net "+o.sales.cents+" cents over "+o.sales.n+" orders; top items "+
      o.items.map(i=>i.name+"="+i.cents).join(", ")+"; weakest day "+o.weakest.day+"="+o.weakest.cents+"; other café net "+o.otherSales.cents);
    for(const [i,item] of questionsFor(id,o,alerts,cafe.currency).entries()){
      // The shared u3 helper throws on an incomplete turn; still read what was saved and what it cost.
      const turn=await completedTurn(owner.page,thread,item.q).catch(e=>({names:[],done:null,error:String(e?.message??e)}));
      const [ownerMessage]=await rows(db,"select id,created_at from public.ai_messages where business_id=$1 and thread_id=$2 and role='owner' "+
        "order by created_at desc limit 1",[cafe.businessId,thread]);
      const usage=ownerMessage?await readPersistedModelUsage(db,cafe.businessId,ownerMessage.id,{attempts:240}).catch(()=>null):null;
      if(usage){calls+=Number(usage.model_call_count);model=usage.model;}
      const [reply]=ownerMessage?await rows(db,"select id,structured_content,grounding from public.ai_messages where business_id=$1 and thread_id=$2 "+
        "and role='supervisor' and created_at>=$3 order by created_at desc limit 1",[cafe.businessId,thread,ownerMessage.created_at]):[];
      if(reply)lastReply=reply.id;
      const text=(reply?.structured_content??[]).filter(b=>b.type==="text").map(b=>b.text).join("");
      const complete=!turn.error&&turn.done?.endReason==="complete"&&text.trim().length>0;
      // An honest "the query failed" answer is a failure of the pathway, never a pass.
      const hard={completed:complete,noDataFailure:!/query (?:is )?(?:failing|returning an error)|couldn[’']t retrieve|can[’']t (?:retrieve|verify)|not a function/i.test(text),
        ...(complete?item.hard(text):{})};
      if(item.noBusinessRead)hard.noUnnecessaryRead=!turn.names.some(n=>["run_sql","describe_database"].includes(n));
      if(item.visual){
        const blocks=reply?.structured_content??[];
        const diagnostics=reply?.grounding?.agentMetadata?.presentationDiagnostics;
        hard.exactVisual=item.visual(blocks);
        hard.modelSelectedVisual=diagnostics?.requestedSections>0&&diagnostics?.acceptedViews>0&&diagnostics?.persistedViews>0;
        hard.ownerVisualRendered=false;hard.mobileVisualFits=false;hard.restoredVisual=false;
        if(reply){
          await owner.page.setViewportSize({width:390,height:844});
          await owner.page.goto("/en?thread="+encodeURIComponent(thread));
          // Scope to THIS reply, not a chart from a previous turn.
          const message=owner.page.locator('[data-work-message="'+reply.id+'"]');
          const views=message.getByTestId("supervisor-rich-presentation");
          await views.first().waitFor({state:"visible",timeout:30000}).catch(()=>{});
          hard.ownerVisualRendered=await views.count()>0&&await views.first().isVisible();
          if(hard.ownerVisualRendered){
            hard.mobileVisualFits=await views.evaluateAll(nodes=>nodes.every(n=>{
              const rect=n.getBoundingClientRect();
              return rect.width>0&&rect.left>=-1&&rect.right<=window.innerWidth+1;
            }));
          }
          // A chart must actually draw its SVG, not simply have a data block.
          if(blocks.some(b=>b.type==="rich_presentation"&&b.panels?.some(p=>["bar","line","donut"].includes(p.kind)))){
            const chart=message.getByTestId("supervisor-rich-chart").first();
            await chart.locator("svg").first().waitFor({state:"visible",timeout:30000}).catch(()=>{});
            hard.chartDrawn=await chart.locator("svg").count()>0&&await chart.locator("svg").first().isVisible();
          }
          await owner.page.reload();
          await views.first().waitFor({state:"visible",timeout:30000}).catch(()=>{});
          hard.restoredVisual=await views.count()>0&&await views.first().isVisible();
        }
      }
      if("usedSqlMoreThanOnce" in hard)hard.usedSqlMoreThanOnce=turn.names.filter(n=>n==="run_sql").length>=2;
      const soft=complete&&item.soft?item.soft(text):{};
      const passed=Object.values(hard).every(Boolean);hardFailures+=passed?0:1;
      results.push({question:i+1,passed,hard,soft,tools:turn.names,modelCalls:usage?Number(usage.model_call_count):null,...(item.visual?{presentationDiagnostics:reply?.grounding?.agentMetadata?.presentationDiagnostics??null}:{})});
      console.log("\n--- Q"+(i+1)+": "+item.q+"\nTools: "+(turn.names.join(" → ")||"none")+" | model calls: "+(usage?.model_call_count??"?")+
        (turn.error?" | error: "+turn.error:"")+"\nAnswer:\n"+text+"\nChecks (must pass): "+JSON.stringify(hard)+"\nChecks (observed): "+JSON.stringify(soft));
    }
    const unchanged=JSON.stringify(before)===JSON.stringify(await snapshot(db));
    foreign=await login(browser,other);
    const foreignDenied=[401,403,404].includes((await foreign.context.request.get("/api/ai/threads/"+thread)).status());
    console.log("\nData unchanged by Supervisor: "+unchanged+" | other café cannot open this thread: "+foreignDenied+
      " | total model calls: "+calls+" | model: "+model);
    requireObservedProductionModel(model,"gpt-6-luna");
    if(!unchanged)fail("supervisor_changed_data");if(!foreignDenied)fail("cross_cafe_thread_visible");
    if(hardFailures)fail(hardFailures+"_question_checks_failed");
    writeFileSync(out,JSON.stringify({id,schema_version:1,head_sha:env.HEAD_SHA,status:"passed",observed_model:model,
      questions:results,dataUnchanged:unchanged,foreignDenied,observedModelCalls:calls})+"\n",{mode:0o600,flag:"wx"});
    writeFileSync(scopeOut,JSON.stringify({businessId:cafe.businessId,otherCafeId:other.businessId,threadId:thread,
      replyId:lastReply,endDate:o.end,expectedProviderCalls:calls})+"\n",{mode:0o600,flag:"wx"});
  }finally{
    for(const close of [()=>foreign?.context.close(),()=>owner?.context.close(),()=>browser.close(),()=>db.end()])await Promise.resolve().then(close).catch(()=>{});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e instanceof Error?e.message:"sql_research_live:unknown");process.exitCode=1});
