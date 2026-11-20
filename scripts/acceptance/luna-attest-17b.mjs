/** Trusted coordinator-only readback. Never execute candidate-supplied SQL or code. */
import {spawnSync} from "node:child_process";
import assert from "node:assert/strict";
const uuid=v=>{assert.match(v??"",/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);return "'"+v+"'";};
const day=v=>{assert.match(v??"",/^\d{4}-\d{2}-\d{2}$/);return "'"+v+"'";};
const integer=v=>{assert.ok(v!==null&&v!==undefined&&Number.isSafeInteger(Number(v)));return Number(v);};
const one=rows=>{assert.equal(rows.length,1,"Exact scoped source row required");return rows[0];};
function read(query){
 const r=spawnSync("psql",["-X","-q","-t","-A","-h","127.0.0.1","-p","54322","-U","postgres","-d","postgres","-v","ON_ERROR_STOP=1","-c","SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM ("+query+") t"],{encoding:"utf8",env:{...process.env,PGPASSWORD:"postgres",PGOPTIONS:"-c default_transaction_read_only=on"},timeout:15000,maxBuffer:200000});
 if(r.status!==0)throw Error("Independent Task17B SQL readback failed");
 const rows=JSON.parse(r.stdout);assert.ok(Array.isArray(rows));return rows;
}
const prose=blocks=>{assert.ok(Array.isArray(blocks));const t=blocks.filter(b=>b.type==="text").map(b=>b.text).join("\n");assert.ok(t.trim());return t;};
function number(answer,label,expected){
 const lines=answer.replace(/[*_`]/g,"").split("\n").filter(l=>l.replace(/^\s*(?:[-•]\s*)?/,"").toLowerCase().startsWith(label.toLowerCase()+":"));
 assert.equal(lines.length,1,"Missing or repeated numeric label: "+label);
 const raw=lines[0].slice(lines[0].indexOf(":")+1).trim();
 assert.match(raw,/^-?\d[\d,]*\s*(?:cents|minor units|orders|%)?\.?$/i);
 assert.equal(integer(raw.match(/^-?\d[\d,]*/)[0].replaceAll(",","")),expected,"Independent saved answer: "+label);
}
// Accept ordinary currency wording (prose, table cells or Markdown); do not
// prescribe chart/card layout, numeric labels, or formatting in owner prompts.
const currencyCodes=new Set(Intl.supportedValuesOf("currency"));
const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
// Exact signed monetary tokens; value presence is not semantic or human comprehension proof.
export function hasMoney(answer,currency,cents){
 if(!currencyCodes.has(currency)||!Number.isSafeInteger(cents))return false;
 const symbol=new Intl.NumberFormat("en-US",{style:"currency",currency}).formatToParts(1).find(p=>p.type==="currency")?.value;
 const units=[currency,symbol].filter(Boolean).map(escapeRegex).join("|");
 const amount=String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?`;
 const before=String.raw`(?<![\p{L}\p{N}.,+$€£¥-])`,after=String.raw`(?![\p{L}\p{N}]|[.,]\d)`;
 const pattern=new RegExp(before+String.raw`(?:(?:(?<prefixSign>[+-])[ \t]*)?(?<prefixUnit>`+units+String.raw`)[ \t]*(?:(?<amountSign>[+-])[ \t]*)?(?<prefixAmount>`+amount+String.raw`)|(?:(?<suffixSign>[+-])[ \t]*)?(?<suffixAmount>`+amount+String.raw`)[ \t]*(?<suffixUnit>`+units+"))"+after,"giu");
 const clean=String(answer).replace(/[\u2212\u2012\u2013]/g,"-").replace(/[\u00a0\u202f]/g," ").replace(/[*_`]/g,"");
 for(const match of clean.matchAll(pattern)){
  const g=match.groups,raw=g.prefixAmount??g.suffixAmount;
  const sign=g.prefixSign||g.amountSign||g.suffixSign||"";
  if(g.prefixSign&&g.amountSign)continue;
  const left=clean.slice(0,match.index),right=clean.slice(match.index+match[0].length);
  const adjacent=[left.match(/\b([A-Z]{3})[ \t]*$/)?.[1],right.match(/^[ \t]*([A-Z]{3})\b/)?.[1]].filter(Boolean);
  if(adjacent.some(code=>currencyCodes.has(code)&&code!==currency))continue;
  const accounting=/\([ \t]*$/.test(left)&&/^[ \t]*\)/.test(right);
  if(accounting&&sign)continue;
  if(/[+-][ \t]*$/.test(left))continue;
  const [whole,fraction=""]=raw.replace(/,/g,"").split(".");
  const absolute=Number(whole)*100+Number(fraction.padEnd(2,"0"));
  if(Number.isSafeInteger(absolute)&&(accounting||sign==="-"?-absolute:absolute)===cents)return true;
 }
 return false;
}

// The legacy fixture and all 18 original questions are retained. The shared
// app scenarios split only for the broker's separate 18-call reservation.
const historicalPosIds=Object.freeze(["17b-pos-discounts","17b-pos-sales","17b-pos-identity","17b-pos-operations"]);
export const isHistoricalPosScenario=id=>historicalPosIds.includes(id);
const historicalBusiness="eeeeeeee-3333-4eee-8eee-eeeeeeeeee00";
const firstOrderGuid="eeeeeeee-3333-4eee-8eee-eeeeeeee0001",staffGuid="eeeeeeee-3333-4eee-8eee-eeeeeeee00a1",stockGuid="eeeeeeee-3333-4eee-8eee-eeeeeeee00b1";
const scalarQuestions=[
 {scope:"today",question:"How many applied student discount uses did we record today? The day is still incomplete.",
  truth:`select count(*)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type in ('item_discount','check_discount') and data->>'name' ilike '%student%'`},
 {scope:"today",question:"How many different orders received a student discount today? Do not count checks as orders.",
  truth:`select count(distinct order_ref)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type in ('item_discount','check_discount') and data->>'name' ilike '%student%'`},
 {scope:"today",question:"How many distinct checks had student discounts today?",
  truth:`select count(distinct check_ref)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type in ('item_discount','check_discount') and data->>'name' ilike '%student%'`},
 {scope:"today",question:"How many valid item and check discount uses of any name are recorded today?",
  truth:`select count(*)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type in ('item_discount','check_discount')`},
 {scope:"span",question:"How many different applied discount names are there across yesterday and today?",
  truth:`select count(distinct data->>'name')::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type in ('item_discount','check_discount')`},
 {scope:"span",question:"How many individual item selections across these two days had quantity at least two?",
  truth:`select count(*)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type='item' and (data->>'quantity')::numeric>=2`},
 {scope:"prior",question:"How many units of items were sold yesterday? Count units, not selection lines.",
  truth:`select sum((data->>'quantity')::numeric)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type='item'`},
 {scope:"prior",question:"How many guests did Toast record yesterday, using the orders?",
  truth:`select sum((data->>'numberOfGuests')::numeric)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type='order'`},
 {scope:"prior",question:"How many item selection records yesterday are missing their displayName?",
  truth:`select count(*)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type='item' and data->>'displayName' is null`},
 {scope:"span",question:"How many Online orders were recorded across yesterday and today?",
  truth:`select count(distinct record_ref)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type='order' and data->>'source'='Online'`},
 {scope:"today",question:"How many units are there today across all item selections, regardless of their number of lines?",
  truth:`select sum((data->>'quantity')::numeric)::integer n from public.toast_records_for($1,$2,$3) where counts_in_sales=true and record_type='item'`}
];
const namedQuestions=[
   {question:"For current Toast order GUID "+firstOrderGuid+
     ", what is this customer's first name? Answer exactly Name: X.",
    truth:"select data->'customer'->>'firstName' answer\n from public.toast_records_for($1,$2,$3)\n where record_type='order' and record_ref=$4",ref:firstOrderGuid},
   {question:"For current Toast employee GUID "+staffGuid+
     ", what full display name is stored for this employee? Answer exactly Name: X.",
    truth:"select data->>'display_name' answer\n from public.toast_records_for($1,$2,$3)\n where record_type='employee' and record_ref=$4",ref:staffGuid}
  ];
  const familyQuestions=[
   {question:"What is this café's total current Toast cash entries today in integer cents? Answer Cents: N; no diagnostic or other-café amounts.",
    truth:"select sum(amount_cents)::integer n from public.cv_cash\n where business_id=$1 and business_date=$2",label:"Cents",dateScope:"today"},
   {question:"For current Toast stock item GUID "+stockGuid+
     ", what quantity is retained today? Answer Quantity: N; do not treat missing as zero.",
    truth:"select sum(quantity)::numeric n from public.cv_inventory\n where business_id=$1 and business_date=$2 and menu_item_ref=$3 and data->>'evidence_state'='observed_current'",label:"Quantity",dateScope:"today",ref:stockGuid},
   {question:"What is yesterday's canonical screen net sales for this café in integer cents? Use the daily sales rollup, not raw order guesses. Answer Cents: N.",
    truth:"select sum(net_sales_cents)::integer n from public.cv_sales_days\n where business_id=$1 and business_date=$2",label:"Cents",dateScope:"prior"}
  ];
const breakdowns=[
   {scope:"span",question:"Give applied discount USE counts for yesterday and today, one line per date as YYYY-MM-DD: N.",
    truth:`select business_date::text k,count(*)::integer n from public.toast_records_for($1,$2,$3) where record_type in ('item_discount','check_discount') and counts_in_sales=true group by business_date order by business_date`},
   {scope:"prior",question:"Give units sold yesterday by item display name. Call absent names 'Unnamed'. Use Name: N lines.",
    truth:`select coalesce(data->>'displayName','Unnamed') k, sum((data->>'quantity')::numeric)::integer n from public.toast_records_for($1,$2,$3) where record_type='item' and counts_in_sales=true group by coalesce(data->>'displayName','Unnamed') order by 1`}
  ];
export function historicalPosCases(id){
 const scalar=(indices)=>indices.map(i=>({...scalarQuestions[i],id:"scalar-"+(i+1),kind:"number",label:"Number",
  prompt:scalarQuestions[i].question+" Answer with 'Number: N' and a short source/coverage note.",
  incomplete:scalarQuestions[i].question.includes("today")}));
 const grouped=i=>({...breakdowns[i],id:"breakdown-"+(i+1),kind:"groups",prompt:breakdowns[i].question});
 const groups={
  "17b-pos-discounts":[...scalar([0,1,2,3,4]),grouped(0)],
  "17b-pos-sales":[...scalar([5,6,7,8,9,10]),grouped(1)],
  "17b-pos-identity":namedQuestions.map((q,i)=>({...q,id:"named-"+(i+1),kind:"name",scope:"span",label:"Name",prompt:q.question+" Use retained current source facts, not diagnostic snapshots or another café."})),
  "17b-pos-operations":familyQuestions.map((q,i)=>({...q,id:"family-"+(i+1),kind:"number",prompt:q.question}))
 };
 assert.ok(Object.hasOwn(groups,id),"Unknown historical POS scenario");
 return groups[id];
}
export function historicalPosSourceSql(spec,scope){
 // Only trusted static SQL and validated fixture identity/date literals. The
 // candidate never supplies a SQL string, an expected answer, or a predicate.
 assert.equal(scope.businessId,historicalBusiness);
 const b=uuid(scope.businessId),today=day(scope.today),prior=day(scope.prior);
 const args=spec.dateScope?[b,spec.dateScope==="prior"?prior:today,...(spec.ref?[uuid(spec.ref)]:[])]:
 [b,spec.scope==="today"?today:prior,spec.scope==="prior"?prior:today,...(spec.ref?[uuid(spec.ref)]:[])];
 return spec.truth.replace(/\$(\d+)/g,(_,n)=>{assert.ok(args[Number(n)-1]);return args[Number(n)-1];});
}
export function checkHistoricalPosAnswer(spec,rows,answer){
 const clean=answer.replace(/[*_`]/g,"");
 if(spec.kind==="groups"){
  assert.ok(rows.length>0,"Empty breakdown reference");
  const expected=new Map(rows.map(r=>[r.k,Number(r.n)]));
  assert.equal(expected.size,rows.length);
  const matches=clean.split("\n").map(line=>line.match(/^\s*(?:[-•]\s*)?(.+?)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*\.?\s*$/)).filter(Boolean);
  // Compare the complete set of explicitly labelled groups; no cherry-picked
  // rows or silently omitted null-name group.
  const actual=new Map();
  for(const m of matches){assert.ok(!actual.has(m[1]),"Repeated breakdown label");actual.set(m[1],Number(m[2]));}
  assert.deepEqual([...actual].sort(),[...expected].sort(),"Independent complete grouped answer");
 }else if(spec.kind==="name"){
  const value=one(rows).answer;assert.ok(typeof value==="string"&&value.length);
  const lines=clean.split("\n").map(l=>l.match(/^\s*(?:[-•]\s*)?Name\s*[:=]\s*(.+?)\s*\.?\s*$/i)).filter(Boolean);
  assert.equal(lines.length,1);assert.equal(lines[0][1].toLowerCase(),value.toLowerCase());
 }else{
  const value=one(rows).n;assert.ok(value!==undefined&&value!==null&&Number.isFinite(Number(value)));
  const pattern=new RegExp("^\\s*(?:[-•]\\s*)?"+spec.label+"\\s*[:=]\\s*(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*\\.?\\s*$","i");
  const lines=clean.split("\n").map(l=>l.match(pattern)).filter(Boolean);
  assert.equal(lines.length,1,"Exactly one original answer label required");
  assert.ok(Math.abs(Number(lines[0][1].replaceAll(",",""))-Number(value))<0.000001,"Independent POS number mismatch");
  if(spec.incomplete)assert.match(clean,/so far|partial|incomplete|provisional/i);
 }
 assert.doesNotMatch(clean,/PoisonEmployee|9999\.99|poison-stock|other-cafe-cash/i);
}
export function attestHistoricalPos(id,scope,query=read){
 const b=uuid(scope.businessId),o=uuid(scope.ownerUserId),t=uuid(scope.threadId);
 assert.equal(scope.businessId,historicalBusiness);
 assert.equal(one(query("SELECT (now() at time zone timezone)::date::text AS today,((now() at time zone timezone)::date-1)::text AS prior FROM public.businesses WHERE id="+b)).today,scope.today);
 assert.equal(one(query("SELECT ((now() at time zone timezone)::date-1)::text AS prior FROM public.businesses WHERE id="+b)).prior,scope.prior);
 const specs=historicalPosCases(id),seen=new Set(),checks=[];let calls=0;
 const filter=" WHERE business_id="+b+" AND owner_user_id="+o+" AND thread_id="+t;
 // Verify the complete persisted conversation, not merely candidate-selected
 // pairs of IDs. Equal numeric answers must not authorize swapped replies.
 const transcript=query("SELECT id,role FROM public.ai_messages"+filter+" ORDER BY created_at,id");
 assert.equal(transcript.length,specs.length*2,"Unexpected historical conversation turns");
 for(const [i,spec] of specs.entries()){
  const owner=scope["owner"+(i+1)],replyId=scope["reply"+(i+1)];
  for(const value of [owner,replyId]){uuid(value);assert.ok(!seen.has(value));seen.add(value);}
  assert.deepEqual(transcript[i*2],{id:owner,role:"owner"},"Historical owner turn order");
  assert.deepEqual(transcript[i*2+1],{id:replyId,role:"supervisor"},"Historical reply turn order");
  const message=one(query("SELECT text_content,created_at FROM public.ai_messages"+filter+" AND role='owner' AND id="+uuid(owner)));
  assert.equal(message.text_content,spec.prompt);
  const response=one(query("SELECT structured_content AS blocks,created_at FROM public.ai_messages"+filter+" AND role='supervisor' AND id="+uuid(replyId)));
  assert.ok(Date.parse(response.created_at)>=Date.parse(message.created_at));
  const usage=one(query("SELECT model,provider,input_tokens,model_call_count FROM public.ai_usage_events WHERE business_id="+b+" AND owner_message_id="+uuid(owner)+" AND owner_user_id="+o+" AND thread_id="+t+" ORDER BY created_at DESC LIMIT 1"));
  assert.equal(usage.model,"gpt-6-luna");assert.equal(usage.provider,"openai");
  assert.ok(integer(usage.input_tokens)>0&&integer(usage.model_call_count)>=2);
  calls+=integer(usage.model_call_count);
  checkHistoricalPosAnswer(spec,query(historicalPosSourceSql(spec,scope)),prose(response.blocks));
  checks.push({name:id+"-"+spec.id,passed:true});
 }
 assert.equal(calls,scope.expectedProviderCalls);
 return checks;
}

export function attestTask17B(id,scope,query=read){
 if(isHistoricalPosScenario(id))return attestHistoricalPos(id,scope,query);
 if(!["16e","17b-sales-labor","17b-supply-finance","17b-cross-module-brief"].includes(id))return [];
 const b=uuid(scope.businessId),o=uuid(scope.ownerUserId),t=uuid(scope.threadId);
 const reply=value=>one(query("SELECT structured_content AS blocks FROM public.ai_messages WHERE business_id="+b+" AND owner_user_id="+o+" AND thread_id="+t+" AND role='supervisor' AND id="+uuid(value))).blocks;
 const daily=value=>one(query("SELECT net_sales_cents,orders_count,staff_wages_cents,staff_tax_cents FROM public.daily_rollups WHERE business_id="+b+" AND business_date="+day(value)+" AND sales_data_status='actual'"));
 const checks=[];
 if(id==="16e"){
  const a=daily(scope.firstDay),z=daily(scope.lastDay),currency=one(query("SELECT currency FROM public.businesses WHERE id="+b)).currency;
  assert.notEqual(scope.firstDay,scope.lastDay);assert.notEqual(scope.plainReplyId,scope.richReplyId);
  const plain=reply(scope.plainReplyId),rich=reply(scope.richReplyId);
  assert.ok(prose(plain).length<=800);assert.ok(!plain.some(x=>x.type==="rich_presentation"));prose(rich);
  const panels=rich.filter(x=>x.type==="rich_presentation"&&x.version===1).flatMap(x=>x.panels??[]);
  const expected=[{label:scope.firstDay,value:integer(a.net_sales_cents)},{label:scope.lastDay,value:integer(z.net_sales_cents)}];
  assert.ok(panels.some(p=>["line","bar"].includes(p.kind)&&p.unit==="cents"&&p.currency===currency&&p.from===scope.firstDay&&p.to===scope.lastDay&&p.points.length===2&&expected.every(e=>p.points.some(q=>q.label===e.label&&q.value===e.value))),"Saved visual must independently agree with source");
  checks.push("16e_saved_visual_exact_source","16e_plain_and_rich_saved_prose");
 }else if(id==="17b-cross-module-brief"){
  const currency=one(query("SELECT currency FROM public.businesses WHERE id="+b)).currency;
  const a=daily(scope.salesDay),z=daily(scope.correctedDay);
  assert.notEqual(scope.salesDay,scope.correctedDay);assert.notEqual(scope.reply1,scope.reply2);
  const amounts=d=>{const net=integer(d.net_sales_cents),labor=integer(d.staff_wages_cents)+integer(d.staff_tax_cents);return [net,labor,net-labor];};
  const [first,last]=[amounts(a),amounts(z)];
  const plain1=prose(reply(scope.reply1)),plain2=prose(reply(scope.reply2));
  for(const [answer,values] of [[plain1,first],[plain2,[...last,Math.abs(last[2]-first[2])]]]){
   for(const cents of values)assert.ok(hasMoney(answer,currency,cents),"Saved natural answer omitted exact source-backed money");
   // Structural language check, not an AI judge or proof of human comprehension.
   assert.match(answer,/profit/i);
   assert.match(answer,/not|isn't|before|other cost|remaining expense/i);
  }
  checks.push("17b_unprescribed_text_source_values_and_context_correction");
 }else if(id==="17b-sales-labor"){
  assert.notEqual(scope.salesDay,scope.correctedDay);
  for(const [date,key] of [[scope.salesDay,"reply1"],[scope.correctedDay,"reply2"]]){
   const d=daily(date),raw=one(query("SELECT count(*) AS orders,sum(net_sales_cents) AS net FROM public.orders WHERE business_id="+b+" AND business_date="+day(date)));
   assert.equal(integer(raw.net),integer(d.net_sales_cents));assert.equal(integer(raw.orders),integer(d.orders_count));
   const answer=prose(reply(scope[key])),w=integer(d.staff_wages_cents),tax=integer(d.staff_tax_cents),net=integer(d.net_sales_cents);
   for(const [label,value] of Object.entries({"Net sales":net,Wages:w,"Payroll tax":tax,"Loaded labor":w+tax}))number(answer,label,value);
  }
  const d=daily(scope.correctedDay),net=integer(d.net_sales_cents),orders=integer(d.orders_count),loaded=integer(d.staff_wages_cents)+integer(d.staff_tax_cents);
  const answer=prose(reply(scope.reply3));assert.ok(net>0&&orders>0);
  for(const [label,value] of Object.entries({Orders:orders,"Net sales":net,"Average ticket":Math.round(net/orders),"Labor basis points":Math.round(10000*loaded/net)}))number(answer,label,value);
  checks.push("17b_sales_labor_saved_answers_and_order_arithmetic");
 }else{
  const item=uuid(scope.menuItemId);
  const p=one(query("SELECT price_cents FROM public.menu_items WHERE business_id="+b+" AND id="+item+" AND is_active")),price=integer(p.price_cents);
  const recipe=one(query("SELECT round(sum(r.quantity*p.cost_per_base_unit_micros)/1000000) AS cost,count(*) AS lines,count(p.cost_per_base_unit_micros) AS priced FROM public.recipe_lines r JOIN public.menu_items m ON m.id=r.menu_item_id JOIN public.businesses b ON b.id=m.business_id LEFT JOIN LATERAL (SELECT cost_per_base_unit_micros FROM public.ingredient_prices WHERE ingredient_id=r.ingredient_id AND effective_from<=((now() at time zone b.timezone)::date) ORDER BY effective_from DESC LIMIT 1) p ON true WHERE m.business_id="+b+" AND r.menu_item_id="+item));
  assert.ok(integer(recipe.lines)>0&&integer(recipe.lines)===integer(recipe.priced));
  const cost=integer(recipe.cost),sold=one(query("SELECT sum(l.quantity) AS units,sum(l.net_sales_cents) AS revenue FROM public.order_lines l JOIN public.orders o ON o.id=l.order_id WHERE o.business_id="+b+" AND l.menu_item_id="+item+" AND l.voided IS NOT TRUE AND o.toast_excluded IS NOT TRUE AND o.superseded_by IS NULL AND o.business_date="+day(scope.itemSalesDay)));
  const a=prose(reply(scope.reply1));for(const [label,value] of Object.entries({Price:price,"Recipe cost":cost,"Unit contribution":price-cost,"Net revenue":integer(sold.revenue),Units:integer(sold.units)}))number(a,label,value);
  const e=one(query("SELECT sum(amount_cents) AS total FROM public.expenses WHERE business_id="+b+" AND status='actual' AND spent_on="+day(scope.expenseDay)));
  number(prose(reply(scope.reply2)),"Actual expenses",integer(e.total));prose(reply(scope.reply3));
  checks.push("17b_supply_finance_saved_numeric_answers");
 }
 return checks.map(name=>({name,passed:true}));
}
