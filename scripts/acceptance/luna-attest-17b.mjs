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
export function attestTask17B(id,scope,query=read){
 if(!["16e","17b-sales-labor","17b-supply-finance"].includes(id))return [];
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
