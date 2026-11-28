/** One consolidated public-web scenario for the existing trusted disposable capture environment. */
import {randomUUID} from "node:crypto";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {login,ownerTurn} from "./u3-canonical-research.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";

const cases=[
  {name:"supplier",question:"Can you find me a bagel wholesaler? I am trying to find lox bagel!",
    matches:(text,hosts)=>/wholesale|distributor/iu.test(text)&&/bagel/iu.test(text)&&/lox|smoked salmon/iu.test(text)&&hosts.size>=1},
  {name:"official-fact",question:"On what day and where did Apollo 11 land? Verify with NASA’s published mission record.",
    matches:(text,hosts)=>/July\s+20(?:,?\s+1969)?|20\s+July/iu.test(text)&&/Tranquility/iu.test(text)&&hasDomain(hosts,"nasa.gov")},
  {name:"multi-source",question:"Compare the current rules for taking a standard bicycle on BART and San Francisco Muni. Check each agency’s official policy and explain how the rules differ by vehicle type.",
    matches:(text,hosts)=>/train/iu.test(text)&&/bus/iu.test(text)&&hasDomain(hosts,"bart.gov")&&hasDomain(hosts,"sfmta.com")},
];
const hasDomain=(hosts,domain)=>[...hosts].some(host=>host===domain||host.endsWith("."+domain));
const fail=code=>{throw Error("public_web_live:"+code);};
const env=process.env,{appUrl,dbUrl}=assertLocalLiveEnvironment(env);
verifyCheckoutHead(env.HEAD_SHA);
if(env.AICAFE_PUBLIC_WEB_ACCEPTANCE!=="OWNER_AUTHORIZED_ONCE")fail("one_bounded_owner_grant_required");
const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
const db=new pg.Client({connectionString:dbUrl}),browser=await chromium.launch({headless:true});
const cafe=TEST_CAFES[0],other=TEST_CAFES[1];
try{
  await db.connect();
  const owner=await login(browser,cafe),foreign=await login(browser,other);
  const created=await owner.context.request.post("/api/ai/threads",{headers:{Origin:appUrl},
    data:{requestId:randomUUID(),title:"Public web research acceptance"}});
  if(created.status()!==201)fail("thread_creation_failed");
  const {thread:{id}}=await created.json();
  const foreignStatus=(await foreign.context.request.get("/api/ai/threads/"+id)).status();
  if(![403,404].includes(foreignStatus))fail("foreign_thread_was_not_denied");
  async function observe(test){
    const turn=await ownerTurn(owner.page,id,test.question);
    const [message]=(await db.query("select id from public.ai_messages where business_id=$1 and thread_id=$2 and client_message_id=$3 and role='owner'",
      [cafe.businessId,id,turn.clientMessageId])).rows;
    if(!message)fail("owner_message_missing");
    const usage=await readPersistedModelUsage(db,cafe.businessId,message.id);
    requireObservedProductionModel(usage.model,"gpt-6-luna");
    const [reply]=(await db.query("select structured_content from public.ai_messages where id=$1 and business_id=$2 and thread_id=$3 and role='supervisor'",
      [turn.done.reply.id,cafe.businessId,id])).rows;
    const [row]=(await db.query("select execution_metrics from public.ai_usage_events where id=$1",[usage.id])).rows;
    if(!reply||!Array.isArray(row?.execution_metrics))fail("saved_reply_or_provider_usage_missing");
    const hosted=row.execution_metrics.flatMap(receipt=>receipt.requests??[]).filter(receipt=>receipt.kind==="hosted_web");
    const text=reply.structured_content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
    const urls=[...text.matchAll(/\[[^\]]+\]\(<?(https?:\/\/[^)>\s]+)>?\)/gu)].map(match=>new URL(match[1]));
    return {text,hosted,urls};
  }
  for(const test of cases){
    const {text,hosted,urls}=await observe(test);
    if(!hosted.some(r=>r.model==="gpt-6-luna"&&r.outcome==="completed"&&r.inputTokens>0&&r.outputTokens>0)
      ||!test.matches(text,new Set(urls.map(url=>url.hostname))))fail(test.name+"_evidence_missing");
    await owner.page.goto("/en/?thread="+id);
    await owner.page.locator("a[href="+JSON.stringify(urls[0].href)+"]").first().waitFor({timeout:15000});
    console.log(JSON.stringify({case:test.name,hosted,citations:urls.map(url=>url.href)}));
  }
  const [grant]=(await db.query("select allowed,revision from public.supervisor_external_access where business_id=$1 and kind='public_web' and resource_key='public'",[cafe.businessId])).rows;
  if(grant?.allowed===false)fail("expected_initial_web_access");
  const revoked=await owner.context.request.post("/api/supervisor/access",{headers:{Origin:appUrl},
    data:{kind:"public_web",enabled:false,revision:Number(grant?.revision??0)}});
  if(revoked.status()!==200||(await revoked.json()).allowed!==false)fail("permission_revocation_failed");
  const denied=await observe({question:"Look up today's public news from multiple reliable sources. If public web is unavailable, explain that."});
  if(denied.hosted.length||denied.urls.length||!/permission|access|disabled|unavailable/iu.test(denied.text))fail("revoked_web_executed");
  console.log(JSON.stringify({head:env.HEAD_SHA,revocation:"passed",tenantIsolation:"passed"}));
}finally{await browser.close();await db.end();}
