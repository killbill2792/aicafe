import pg from "pg";
import assert from "node:assert/strict";
if(process.env.P1_DISPOSABLE_DB!=="1")throw Error("Disposable database opt-in required");
const cfg={host:"127.0.0.1",port:54322,database:"postgres",user:"postgres",password:"postgres"};
const connections=await Promise.all(Array.from({length:4},async()=>{
  const client=new pg.Client(cfg);await client.connect();return client;
}));
const [admin,owner,other,concurrent]=connections;
const cafeA="11221221-1111-4111-8111-112211221122";
const cafeB="11221221-2222-4222-8222-112211221122";
const ownerA="11221221-3333-4333-8333-112211221122";
const ownerB="11221221-4444-4444-8444-112211221122";
const product="11221221-5555-4555-8555-112211221122";
const product2="11221221-6666-4666-8666-112211221122";
const ingredient="11221221-7777-4777-8777-112211221122";
const ingredient2="11221221-8888-4888-8888-112211221122";
const revision=async()=>String((await admin.query(
  "select revision::text from public.p1_business_source_epochs where business_id=$1",[cafeA])).rows[0].revision);
const activeDay=async()=>String((await admin.query(
  "select to_char((now() at time zone timezone)::date,'YYYY-MM-DD') as day from public.businesses where id=$1",[cafeA])).rows[0].day)
  .slice(0,10);
const params=(item,ing,epoch,day)=>[cafeA,item,ing,epoch,day,450,946];
const call=async(client,parameters)=>{
  const result=await client.query(
    "select public.menu_add_manual_ingredient_price_if_revision($1,$2,$3,$4,$5,$6,$7) as result",
    parameters);
  return result.rows[0].result;
};
const asOwner=async(client,user)=>{
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE authenticated");
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user]);
};
let checks=0;
const check=(predicate,reason)=>{assert.ok(predicate,reason);checks++;};
try{
  await admin.query(
    "insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) "+
    "values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','cas-owner-a@example.invalid','',now(),now()),"+
    "($2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','cas-owner-b@example.invalid','',now(),now())",
    [ownerA,ownerB]);
  await admin.query("insert into public.businesses(id,name,is_demo) values($1,'CAS A',false),($2,'CAS B',false)",[cafeA,cafeB]);
  await admin.query("insert into public.memberships(business_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",[cafeA,ownerA,cafeB,ownerB]);
  await admin.query("insert into public.menu_items(id,business_id,name,base_name,price_cents,category) values($1,$2,'Oat Latte','Oat Latte',700,'ESPRESSO_DRINK'),($3,$2,'Cappuccino','Cappuccino',600,'ESPRESSO_DRINK')",
    [product,cafeA,product2]);
  await admin.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,'Oat milk','ml'),($3,$2,'Whole milk','ml')",
    [ingredient,cafeA,ingredient2]);
  await admin.query("insert into public.recipe_lines(menu_item_id,ingredient_id,quantity) values($1,$2,250),($3,$4,180)",
    [product,ingredient,product2,ingredient2]);

  const day=await activeDay(),epoch=await revision();
  check(!(await admin.query("select has_function_privilege('anon','public.menu_add_manual_ingredient_price_if_revision(uuid,uuid,uuid,text,date,bigint,numeric)','EXECUTE') as allowed")).rows[0].allowed,
    "anonymous caller cannot execute privileged write");
  await asOwner(other,ownerB);
  const unauthorized=await call(other,params(product,ingredient,epoch,day));
  await other.query("COMMIT");
  check(unauthorized.ok===false&&unauthorized.reason==="unauthorized",
    "different café owner cannot save ingredient price");

  await asOwner(owner,ownerA);
  const result=await call(owner,params(product,ingredient,epoch,day));
  check(result.ok===true&&result.effectiveDate===day,
    "authenticated owner successfully saves one source-bound price");
  await owner.query("COMMIT");
  check(BigInt(await revision())>BigInt(epoch),"same transaction advances P1 revision");
  const saved=(await admin.query(
    "select effective_from::text,cost_per_base_unit_micros,source from public.ingredient_prices where ingredient_id=$1",
    [ingredient])).rows;
  check(saved.length===1&&saved[0].effective_from===day&&
    Number(saved[0].cost_per_base_unit_micros)===Math.round(450/946*1000000)&&
    saved[0].source==="manual","persisted price dated and sourced correctly");

  await asOwner(owner,ownerA);
  const replay=await call(owner,params(product,ingredient,epoch,day));
  await owner.query("COMMIT");
  check(replay.ok===false&&replay.reason==="source_changed",
    "duplicate stale confirmation makes no second write");

  const stale=await revision();
  await admin.query("update public.menu_items set price_cents=price_cents+1 where id=$1",[product2]);
  await asOwner(owner,ownerA);
  const rejected=await call(owner,params(product2,ingredient2,stale,day));
  await owner.query("COMMIT");
  check(rejected.ok===false&&rejected.reason==="source_changed",
    "intervening canonical mutation rejects stale write before insertion");
  check((await admin.query("select count(*)::int as n from public.ingredient_prices where ingredient_id=$1",
    [ingredient2])).rows[0].n===0,"stale write inserted zero rows");

  // Two independent owner confirmations for the SAME previously-missing
  // ingredient must serialize on the epoch row (not a global table lock).
  const current=await revision();
  await asOwner(owner,ownerA);
  const first=await call(owner,params(product2,ingredient2,current,day));
  check(first.ok===true,"first CAS transaction inserts new ingredient price");
  await asOwner(concurrent,ownerA);
  let secondFinished=false;
  const secondPromise=call(concurrent,params(product2,ingredient2,current,day)).then(x=>{
    secondFinished=true;return x;
  });
  await new Promise(resolve=>setTimeout(resolve,180));
  check(!secondFinished,"second confirmation blocks until first epoch commit");
  await owner.query("COMMIT");
  const second=await secondPromise;
  await concurrent.query("COMMIT");
  check(second.ok===false&&second.reason==="source_changed",
    "second confirmation fails CAS after first commit");
  check((await admin.query("select count(*)::int as n from public.ingredient_prices where ingredient_id=$1",
    [ingredient2])).rows[0].n===1,"race results in exactly one price");

  // PostgreSQL NUMERIC rounds exact half-microcent ties away from zero.
  // The application must verify the same 504688 value without float drift.
  const tieIngredient="11221221-9999-4999-8999-112211221122";
  await admin.query("insert into public.ingredients(id,business_id,name,base_unit) values($1,$2,'Half-up test','ml')",
    [tieIngredient,cafeA]);
  await admin.query("insert into public.recipe_lines(menu_item_id,ingredient_id,quantity) values($1,$2,10)",
    [product2,tieIngredient]);
  const tieEpoch=await revision();
  await asOwner(owner,ownerA);
  const tie=await call(owner,[cafeA,product2,tieIngredient,tieEpoch,day,323,640]);
  await owner.query("COMMIT");
  check(tie.ok===true,"valid half-microcent package price accepted");
  const tieSaved=(await admin.query(
    "select cost_per_base_unit_micros from public.ingredient_prices where ingredient_id=$1",
    [tieIngredient])).rows;
  check(tieSaved.length===1&&Number(tieSaved[0].cost_per_base_unit_micros)===504688,
    "database stores exact NUMERIC 504688 for 3.23 / 640");

  // Two different tenants have different epoch locks. No table-wide lock.
  check((await admin.query("select revision from public.p1_business_source_epochs where business_id=$1",
    [cafeB])).rows.length===1,"unrelated café epoch remains independently accessible");
  console.log("PASS "+checks+" PostgreSQL owner-input CAS, authentication, source epochs and concurrency assertions");
}finally{
  for(const client of connections){
    try{await client.query("ROLLBACK");}catch{}await client.end();
  }
}
