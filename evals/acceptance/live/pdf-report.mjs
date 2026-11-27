#!/usr/bin/env node
/** Real Luna PDF acceptance. Executed only by the existing owner-authorized
 * shared runner on its disposable database; no provider call in ordinary CI. */
import {randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {TEST_CAFES} from "../../../scripts/seed/cafes.mjs";
import {assertLocalLiveEnvironment} from "./preflight.mjs";
import {readPersistedModelUsage,requireObservedProductionModel,verifyCheckoutHead} from "./runner.mjs";
import {login,ownerTurn} from "./u3-canonical-research.mjs";
import {resolveProofPaths,mentionsAmount} from "./sql-research.mjs";
import {PDFParse} from "pdf-parse";

const id="sql-research-pdf";
const fail=reason=>{throw Error(id+":"+reason);};
const rows=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
export async function readPdfContents(bytes){
 if(Buffer.from(bytes).subarray(0,5).toString()!=="%PDF-")fail("not_pdf");
 const parser=new PDFParse({data:Uint8Array.from(bytes)});
 try{
  const info=await parser.getInfo(),text=await parser.getText();
  return {title:info.info?.Title,text:text.text,pages:text.total};
 }finally{await parser.destroy();}
}
export function matchesPdfRows(document,expected,currency){
 if(typeof document!=="string"||!document.includes(currency))return false;
 const lines=document.split(/\r?\n/u);
 return expected.every(row=>lines.some(line=>line.includes(row.day)&&mentionsAmount(line.replace(row.day,""),row.cents)));
}
async function main(){
 const env=process.env;
 assertLocalLiveEnvironment(env);verifyCheckoutHead(env.HEAD_SHA);
 if(env.AICAFE_SHARED_LUNA!=="1"||env.AICAFE_SHARED_LUNA_CANDIDATE!=="1"||env.AICAFE_SHARED_LUNA_SCENARIO!==id)fail("shared_runner_required");
 const {out,scopeOut}=resolveProofPaths(process.argv.slice(2),env,id);
 const cafe=TEST_CAFES[0],other=TEST_CAFES[1];
 if(!cafe?.owner||!other?.owner||cafe.businessId===other.businessId)fail("two_cafes_required");
 const [{default:pg},{chromium}]=await Promise.all([import("pg"),import("@playwright/test")]);
 const db=new pg.Client({connectionString:env.ACCEPTANCE_DATABASE_URL});
 const browser=await chromium.launch({headless:true});
 let owner=null,foreign=null;await db.connect();
 try{
  // Independent totals from existing synthetic orders; no business-data mutation.
  const daily=await rows(db,"select business_date::text day,sum(net_sales_cents)::bigint cents from public.orders where business_id=$1 group by 1 order by 1 desc limit 30",[cafe.businessId]);
  const otherDaily=await rows(db,"select business_date::text day,sum(net_sales_cents)::bigint cents from public.orders where business_id=$1 group by 1 order by 1 desc limit 30",[other.businessId]);
  const pair=daily.slice(0,-1).map((last,i)=>[daily[i+1],last]).find(([first,last])=>Date.parse(last.day)-Date.parse(first.day)===86400000&&Number(first.cents)>0&&Number(last.cents)>0&&first.cents!==last.cents&&otherDaily.some(row=>row.day===last.day&&![first.cents,last.cents].includes(row.cents)&&Number(row.cents)>0));
  if(!pair)fail("distinct_two_cafe_source_totals_missing");
  const [first,last]=pair,foreignValue=otherDaily.find(row=>row.day===last.day).cents;
  const title="Daily net sales "+first.day+" to "+last.day;
  owner=await login(browser,cafe);
  const created=await owner.context.request.post("/api/ai/threads",{headers:{Origin:"http://127.0.0.1:3000"},data:{requestId:randomUUID(),title:"Disposable PDF acceptance"}});
  if(created.status()!==201)fail("thread_creation_failed");
  const thread=(await created.json()).thread?.id;if(!/^[0-9a-f-]{36}$/i.test(thread??""))fail("thread_id_missing");
  const turn=await ownerTurn(owner.page,thread,"Create a downloadable PDF titled "+title+" for my café. Include one table row for each day from "+first.day+" through "+last.day+" inclusive, using ISO dates, recorded net sales in major currency units with two decimal places, and the café currency code. Do not change any business records.");
  if(!turn.names.includes("run_sql"))fail("model_sql_read_missing");
  const [ownerMessage]=await rows(db,"select id from public.ai_messages where business_id=$1 and thread_id=$2 and role='owner' and client_message_id=$3",[cafe.businessId,thread,turn.clientMessageId]);
  if(!ownerMessage)fail("owner_message_missing");
  const usage=await readPersistedModelUsage(db,cafe.businessId,ownerMessage.id,{attempts:240});
  requireObservedProductionModel(usage.model,"gpt-6-luna");
  const calls=Number(usage.model_call_count);
  if(!Number.isSafeInteger(calls)||calls<1||Number(usage.input_tokens)<=0)fail("provider_usage_missing");
  const [reply]=await rows(db,"select id,structured_content from public.ai_messages where business_id=$1 and thread_id=$2 and role='supervisor' and id=$3",[cafe.businessId,thread,turn.done.reply.id]);
  const blocks=reply?.structured_content;
  if(!Array.isArray(blocks))fail("saved_answer_missing");
  const index=blocks.findIndex(block=>block.type==="rich_presentation"&&block.report===true&&block.pdfSpec?.elements?.[block.pdfSpec.root]?.type==="Document");
  if(index<0)fail("model_authored_native_document_missing");
  const spec=blocks[index].pdfSpec;
  if(spec.elements[spec.root].props?.title!==title)fail("native_document_title_missing");
  await owner.page.goto("/en?thread="+encodeURIComponent(thread));
  const answer=owner.page.locator('[data-work-message="'+reply.id+'"]');
  const route="/api/ai/threads/"+thread+"/messages/"+reply.id+"/report?document="+index;
  const link=answer.getByRole("link",{name:"Download PDF",exact:true});
  await link.waitFor({state:"visible",timeout:30000});
  if(await link.getAttribute("href")!==route)fail("wrong_document_download");
  await owner.page.reload();await link.waitFor({state:"visible",timeout:30000});
  const response=await owner.context.request.get(route,{timeout:60000});
  if(response.status()!==200||response.headers()["content-type"]!=="application/pdf"||!response.headers()["cache-control"]?.includes("no-store"))fail("private_pdf_download_failed");
  const document=await readPdfContents(await response.body());
  // A generic saved-answer fallback is not proof that the authored document
  // rendered. Inspect PDF metadata and the actual rendered row values.
  if(document.title!==title||document.pages<1||!matchesPdfRows(document.text,pair,cafe.currency))fail("native_pdf_values_mismatch");
  if(mentionsAmount(document.text.replaceAll(first.day,"").replaceAll(last.day,""),foreignValue))fail("foreign_value_in_pdf");
  foreign=await login(browser,other);
  if(![401,403,404].includes((await foreign.context.request.get(route)).status()))fail("foreign_pdf_not_denied");
  const [effects]=await rows(db,"select count(*)::int n from public.supervisor_proposals where business_id=$1 and thread_id=$2",[cafe.businessId,thread]);
  if(effects.n!==0)fail("unexpected_effect");
  const after=await rows(db,"select business_date::text day,sum(net_sales_cents)::bigint cents from public.orders where business_id=$1 and business_date between $2::date and $3::date group by 1 order by 1",[cafe.businessId,first.day,last.day]);
  if(JSON.stringify(after)!==JSON.stringify(pair))fail("source_records_changed");
  const afterUsage=await readPersistedModelUsage(db,cafe.businessId,ownerMessage.id,{attempts:240});
  if(Number(afterUsage.model_call_count)!==calls)fail("pdf_download_recalled_model");
  writeFileSync(out,JSON.stringify({id,schema_version:1,head_sha:env.HEAD_SHA,status:"passed",observed_model:usage.model,modelCalls:calls,checks:{modelAuthoredDocument:true,exactRenderedValues:true,privateDownload:true,reload:true,foreignDenied:true,noEffect:true,noAdditionalModelCall:true}})+"\n",{mode:0o600,flag:"wx"});
  writeFileSync(scopeOut,JSON.stringify({businessId:cafe.businessId,otherCafeId:other.businessId,threadId:thread,replyId:reply.id,endDate:last.day,expectedProviderCalls:calls})+"\n",{mode:0o600,flag:"wx"});
  console.log("PDF acceptance: native document, exact disposable source values, private download and no additional model call verified.");
 }finally{
  for(const close of [()=>foreign?.context.close(),()=>owner?.context.close(),()=>browser.close(),()=>db.end()])await Promise.resolve().then(close).catch(()=>{});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e instanceof Error?e.message:id+":unknown");process.exitCode=1});
