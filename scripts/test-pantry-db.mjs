import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";

const db = new pg.Client({ host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432), user: "postgres", password: "postgres", database: "postgres" });
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PARENT = "33333333-3333-4333-8333-333333333333";
const FOREIGN_ING = "44444444-4444-4444-8444-444444444444";
let owned = {};

async function asOwner(client, fn, actor = OWNER) {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [actor]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
async function rejectStatement(client, sql, args, wantedCode) {
  await client.query("savepoint expected_failure");
  let code = null;
  try { await client.query(sql, args); } catch (error) { code = error.code; }
  await client.query("rollback to savepoint expected_failure");
  await client.query("release savepoint expected_failure");
  assert.equal(code, wantedCode);
}
const rpc = (name, args, count) => `select public.${name}(${Array.from({length:count},(_,i)=>"$"+(i+1)).join(",")}) as result`;
const recipe = (itemId, cupId, espressoId, milkId) => ({
  sizeLabel: itemId,
  lines: [
    { ingredientId: espressoId, quantity: 36, displayUnit: "shot", displayQuantity: 2 },
    { ingredientId: milkId, quantity: 295.7353, displayUnit: "fl_oz", displayQuantity: 10 },
    { ingredientId: cupId, quantity: 1, displayUnit: "each", displayQuantity: 1 },
  ],
});
try {
  await db.connect();
  await db.query(`
    create extension if not exists pgcrypto;
    create schema auth;
    create role authenticated nologin;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    create table businesses(id uuid primary key, timezone text not null default 'America/Los_Angeles');
    create table memberships(business_id uuid not null references businesses(id),user_id uuid not null,
      role text not null default 'owner', primary key(business_id,user_id));
    create function public.is_member(target_business_id uuid) returns boolean
      language sql security definer stable set search_path=public as
      $$ select exists(select 1 from memberships where business_id=target_business_id and user_id=auth.uid()) $$;
    create table menu_items (
      id uuid primary key default gen_random_uuid(),
      business_id uuid not null references businesses(id),
      name text not null, base_name text not null, size_label text,
      price_cents bigint, prep_seconds int not null default 60,
      category text, menu_group text, is_active boolean not null default true,
      catalog_source text not null default 'manual'
    );
    create table ingredients (
      id uuid primary key default gen_random_uuid(),
      business_id uuid not null references businesses(id),
      name text not null, base_unit text not null,
      icon text
    );
    create table ingredient_prices (
      id uuid primary key default gen_random_uuid(),
      ingredient_id uuid not null references ingredients(id),
      effective_from date not null, cost_per_base_unit_micros bigint not null,
      source text not null
    );
    create table ingredient_unit_conversions (
      id uuid primary key default gen_random_uuid(),
      ingredient_id uuid not null references ingredients(id),
      unit text not null,
      base_units_per_unit numeric(12,6) not null,
      unique(ingredient_id,unit)
    );
    create table recipe_lines (
      menu_item_id uuid not null references menu_items(id),
      ingredient_id uuid not null references ingredients(id),
      quantity numeric(12,4) not null,
      display_unit text,
      display_quantity numeric(12,4),
      primary key(menu_item_id, ingredient_id)
    );
    grant usage on schema public,auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    grant execute on function public.is_member(uuid) to authenticated;
    grant all on all tables in schema public to authenticated;
  `);
  for(const table of ["menu_items", "ingredients"]) {
    await db.query(`alter table public.${table} enable row level security`);
    if(table==="ingredients"){
      await db.query(`create policy "members read" on public.ingredients for select using (public.is_member(business_id))`);
      await db.query(`create policy "members write" on public.ingredients for all
        using (public.is_member(business_id)) with check (public.is_member(business_id))`);
    }else{
      await db.query(`create policy members on public.${table} for all
        using (public.is_member(business_id)) with check (public.is_member(business_id))`);
    }
  }
  for(const [table,parent,col] of [
    ["recipe_lines","menu_items","menu_item_id"],
    ["ingredient_prices","ingredients","ingredient_id"],
    ["ingredient_unit_conversions","ingredients","ingredient_id"],
  ]) {
    await db.query(`alter table public.${table} enable row level security`);
    await db.query(`create policy members on public.${table} for all
      using (exists (select 1 from public.${parent} p where p.id=${col} and public.is_member(p.business_id)))
      with check (exists (select 1 from public.${parent} p where p.id=${col} and public.is_member(p.business_id)))`);
  }
  await db.query(readFileSync(new URL("../supabase/migrations/20261022000079_pantry_packs.sql", import.meta.url), "utf8"));
  await db.query(readFileSync(new URL("../supabase/migrations/20261022000080_menu_options_combos.sql", import.meta.url), "utf8"));
  await db.query(readFileSync(new URL("../supabase/migrations/20261031000134_pantry_persistence.sql", import.meta.url), "utf8"));
  await db.query("grant all on public.menu_product_addons, public.menu_combo_components to authenticated");
  await db.query("grant execute on function public.save_menu_product_addons(uuid,uuid,jsonb) to authenticated");
  await db.query("insert into businesses(id) values($1),($2)",[A,B]);
  await db.query("insert into memberships(business_id,user_id) values($1,$2),($3,$4)",[A,OWNER,B,OTHER]);
  await db.query("insert into menu_items(id,business_id,name,base_name,price_cents) values($1,$2,'Latte','Latte',550)",[PARENT,A]);
  await db.query("insert into ingredients(id,business_id,name,base_unit) values($1,$2,'Other business milk','ml')",[FOREIGN_ING,B]);

  const starterKeys = ["espresso-beans","milk-whole","cup-hot-8","cup-hot-12","cup-hot-16","cup-hot-20"];
  const starters = starterKeys.map(key=>({
    starterKey:key, name:key, baseUnit:key==="espresso-beans"?"g":key==="milk-whole"?"ml":"each",
    category:key==="espresso-beans"?"coffee":key==="milk-whole"?"milk":"packaging",
    operationalUnit:key==="espresso-beans"?"shot":null,
    baseUnitsPerOperationalUnit:key==="espresso-beans"?18:null,
  }));
  await asOwner(db, async (c) => {
    const first = await c.query(rpc("pantry_add_starters", [], 2),[A,JSON.stringify(starters)]);
    assert.deepEqual(first.rows[0].result.addedKeys.sort(), starterKeys.slice().sort());
    const second = await c.query(rpc("pantry_add_starters", [], 2),[A,JSON.stringify(starters)]);
    assert.deepEqual(second.rows[0].result.addedKeys, [], "retry must be idempotent");
    const rows = await c.query("select starter_key,id from ingredients where business_id=$1",[A]);
    owned = Object.fromEntries(rows.rows.map(row=>[row.starter_key,row.id]));
    const conversion = await c.query("select base_units_per_unit from ingredient_unit_conversions where ingredient_id=$1",[owned["espresso-beans"]]);
    assert.equal(Number(conversion.rows[0].base_units_per_unit),18);
    await rejectStatement(c,rpc("pantry_add_starters",[],2),[B,JSON.stringify(starters)],"42501");
  });
  await asOwner(db, async c => {
    const sizes=[8,12,16,20].map(n => recipe(`${n} oz`,owned[`cup-hot-${n}`],owned["espresso-beans"],owned["milk-whole"]));
    await c.query(rpc("pantry_apply_sized_recipes",[],3),[A,PARENT,JSON.stringify(sizes)]);
    const family=await c.query("select id,size_label,is_active,price_cents,name from menu_items where business_id=$1 and base_name='Latte'",[A]);
    assert.equal(family.rowCount,4);
    assert.equal(family.rows.find(row=>row.id===PARENT).size_label,"12 oz");
    assert.equal(family.rows.find(row=>row.id===PARENT).price_cents,"550");
    assert.equal(family.rows.find(row=>row.id===PARENT).name,"Latte");
    for(const row of family.rows.filter(row=>row.id!==PARENT)) {
      assert.equal(row.is_active,false);
      assert.equal(row.price_cents,null);
    }
    const recipeCount=await c.query("select count(*) from recipe_lines");
    assert.equal(Number(recipeCount.rows[0].count),12);
    const anchor=family.rows.find(row=>row.size_label==="16 oz").id;
    await c.query(rpc("pantry_apply_sized_recipes",[],3),[A,anchor,JSON.stringify(sizes)]);
    assert.equal(Number((await c.query("select count(*) from menu_items where business_id=$1",[A])).rows[0].count),4);
    // Mixed-tenant replacement must fail BEFORE deletion, including if valid edits precede it.
    const wrong = [{menuItemId:PARENT,lines:[...sizes[1].lines,{ingredientId:FOREIGN_ING,quantity:1,displayUnit:"ml",displayQuantity:1}]}];
    await rejectStatement(c,rpc("pantry_replace_recipes",[],3),[A,PARENT,JSON.stringify(wrong)],"P0001");
    assert.equal(Number((await c.query("select count(*) from recipe_lines where menu_item_id=$1",[PARENT])).rows[0].count),3);
    const oldLines= (await c.query("select ingredient_id, quantity, display_unit, display_quantity from recipe_lines where menu_item_id=$1 order by ingredient_id",[PARENT])).rows
      .map(row=>({ingredientId:row.ingredient_id,quantity:Number(row.quantity),displayUnit:row.display_unit,displayQuantity:Number(row.display_quantity)}));
    const changed = [{menuItemId:PARENT,expectedLines:oldLines,lines:[...sizes[1].lines]}];
    await c.query(rpc("pantry_replace_recipes",[],3),[A,PARENT,JSON.stringify(changed)]);
    const stale = [{...changed[0],expectedLines:[...oldLines,{ingredientId:FOREIGN_ING,quantity:1,displayUnit:"ml",displayQuantity:1}]}];
    await rejectStatement(c,rpc("pantry_replace_recipes",[],3),[A,PARENT,JSON.stringify(stale)],"40001");
    const untouched = family.rows.find(row => row.size_label === "20 oz");
    const rowsFor = async id => (await c.query(
      "select ingredient_id,quantity,display_unit,display_quantity from recipe_lines where menu_item_id=$1 order by ingredient_id",[id]
    )).rows.map(row=>({ingredientId:row.ingredient_id,quantity:Number(row.quantity),
      displayUnit:row.display_unit,displayQuantity:Number(row.display_quantity)}));
    const beforeUntouched = await rowsFor(untouched.id);
    const allSiblingIds = family.rows.map(row=>row.id).sort();
    const completeCAS = [
      {menuItemId:PARENT,lines:sizes[1].lines,expectedLines:oldLines,expectedSourceLines:oldLines,expectedSiblingIds:allSiblingIds},
      {menuItemId:untouched.id,lines:[],expectedLines:beforeUntouched,checkOnly:true},
    ];
    await c.query(rpc("pantry_replace_recipes",[],3),[A,PARENT,JSON.stringify(completeCAS)]);
    assert.deepEqual(await rowsFor(untouched.id),beforeUntouched,
      "the check-only sibling must never be rewritten");
    // Simulate a concurrent scaling operation adding/changing an ingredient in a
    // previously unmodified size: the stale swap now must fail closed.
    await c.query("update recipe_lines set quantity=quantity+1 where menu_item_id=$1 and ingredient_id=$2",
      [untouched.id,owned["milk-whole"]]);
    await rejectStatement(c,rpc("pantry_replace_recipes",[],3),
      [A,PARENT,JSON.stringify(completeCAS)],"40001");
    await rejectStatement(c,rpc("pantry_replace_recipes",[],3),
      [A,PARENT,JSON.stringify([{...completeCAS[0],expectedSiblingIds:[PARENT]}])],"40001");

  });
  // New Add-ons Save commits a default milk replacement and recipe CAS in
  // one PostgreSQL transaction. No split state may survive a stale conflict.
  await asOwner(db,async c=>{
    const alt=(await c.query("insert into ingredients(business_id,name,base_unit) values($1,'Oat Milk','ml') returning id",[A])).rows[0].id;
    const family=(await c.query("select id from menu_items where business_id=$1 and base_name='Latte' order by id",[A])).rows.map(x=>x.id);
    const target=family.find(id=>id!==PARENT);assert.ok(target);
    const original=(await c.query("select ingredient_id,quantity,display_unit,display_quantity from recipe_lines where menu_item_id=$1 order by ingredient_id",[target])).rows.map(row=>({
      ingredientId:row.ingredient_id,quantity:Number(row.quantity),displayUnit:row.display_unit,
      displayQuantity:row.display_quantity===null?null:Number(row.display_quantity),
    }));
    const updated=original.map(line=>line.ingredientId===owned["milk-whole"]?{...line,ingredientId:alt}:line);
    const changes=[{menuItemId:target,expectedLines:original,expectedSourceLines:original,
      expectedSiblingIds:family,lines:updated}];
    const option=ingredientId=>({ingredientId,kind:"milk",enabled:true,isDefault:true,
      upchargeCents:0,displayUnit:"ml",displayQuantity:1});
    await c.query("select public.save_menu_product_addons($1,$2,$3)",[A,target,
      JSON.stringify({options:[option(alt)],recipeChanges:changes})]);
    assert.equal((await c.query("select ingredient_id from recipe_lines where menu_item_id=$1 and ingredient_id=$2",[target,alt])).rowCount,1);
    assert.equal((await c.query("select ingredient_id from menu_product_addons where menu_item_id=$1 and is_default=true",[target])).rows[0].ingredient_id,alt);
    await rejectStatement(c,"select public.save_menu_product_addons($1,$2,$3)",[A,target,
      JSON.stringify({options:[option(owned["milk-whole"])],recipeChanges:changes})],"40001");
    assert.equal((await c.query("select ingredient_id from menu_product_addons where menu_item_id=$1 and is_default=true",[target])).rows[0].ingredient_id,alt,
      "failed concurrent recipe change must never change saved default milk");
    assert.equal((await c.query("select ingredient_id from recipe_lines where menu_item_id=$1 and ingredient_id=$2",[target,alt])).rowCount,1);
  });
  // A legacy editor updates an unrelated line in an open transaction. The
  // bulk RPC must wait for its ROW EXCLUSIVE lock, then detect the stale
  // source snapshot instead of losing that committed owner edit.
  const snapshot = await asOwner(db, async c => (await c.query(
    "select ingredient_id, quantity, display_unit, display_quantity from recipe_lines where menu_item_id=$1 order by ingredient_id",
    [PARENT])).rows.map(r => ({ingredientId:r.ingredient_id,quantity:Number(r.quantity),
      displayUnit:r.display_unit,displayQuantity:Number(r.display_quantity)})));
  const writer = new pg.Client({host:process.env.PGHOST||"127.0.0.1",
    port:Number(process.env.PGPORT||5432), user:"postgres",password:"postgres",database:"postgres"});
  await writer.connect();
  try {
    await writer.query("begin");
    await writer.query("set local role authenticated");
    await writer.query("select set_config('request.jwt.claim.sub',$1,true)",[OWNER]);
    await writer.query("update recipe_lines set quantity=quantity+1 where menu_item_id=$1 and ingredient_id=$2",
      [PARENT,owned["milk-whole"]]);
    const blockedBulk=asOwner(db,async c => rejectStatement(c,
      rpc("pantry_replace_recipes",[],3), [A,PARENT,JSON.stringify([{
        menuItemId:PARENT,expectedLines:snapshot,lines:[],
      }])],"40001"));
    // Give the bulk operation an opportunity to reach its table lock while
    // the legacy edit still holds its transaction open.
    await new Promise(resolve=>setTimeout(resolve,100));
    await writer.query("commit");
    await blockedBulk;
    const updated=await db.query("select quantity from recipe_lines where menu_item_id=$1 and ingredient_id=$2",
      [PARENT,owned["milk-whole"]]);
    assert.equal(Number(updated.rows[0].quantity),Number(snapshot.find(r=>r.ingredientId===owned["milk-whole"]).quantity)+1);
  } finally { await writer.end(); }
  // PR #319: real PostgreSQL save -> reload, case factor history and safe archive.
  await asOwner(db, async c=>{
    const milk=owned["milk-whole"],espresso=owned["espresso-beans"];
    const saved=(await c.query(`select ingredient_id,quantity,display_unit,display_quantity,sort_order
      from recipe_lines where menu_item_id=$1 order by sort_order nulls last,ingredient_id`,[PARENT])).rows;
    const before=new Map(saved.map(row=>[row.ingredient_id,Number(row.quantity)]));
    const newId=(await c.query(`insert into ingredients(business_id,name,base_unit)
      values($1,'Cinnamon','ml') returning id`,[A])).rows[0].id;
    const normalized=rows=>rows.map(x=>({ingredientId:x.ingredient_id,quantity:Number(x.quantity),
      displayUnit:x.display_unit,displayQuantity:Number(x.display_quantity)}));
    const order=saved.map(row=>row.ingredient_id);
    const insert={ingredientId:newId,quantity:5,displayUnit:"ml",displayQuantity:5};
    const first=normalized(saved);
    const next=[first[0],insert,...first.slice(1)];
    await c.query(rpc("pantry_replace_recipes",[],3),[A,PARENT,JSON.stringify([{
      menuItemId:PARENT,expectedOrder:order,lines:next,
    }])]);
    const reopened=(await c.query(`select ingredient_id,quantity,sort_order from recipe_lines
      where menu_item_id=$1 order by sort_order nulls last,ingredient_id`,[PARENT])).rows;
    assert.deepEqual(reopened.map(r=>r.ingredient_id),next.map(x=>x.ingredientId),
      "insert-after persists on saved reader after reload");
    assert.deepEqual(reopened.map(r=>Number(r.sort_order)),[1,2,3,4]);
    for(const [id,quantity] of before)
      assert.equal(Number(reopened.find(r=>r.ingredient_id===id).quantity),quantity,
        "reordering does not change the saved base quantity");
    await rejectStatement(c,rpc("pantry_replace_recipes",[],3),[A,PARENT,JSON.stringify([{
      menuItemId:PARENT,expectedOrder:order,lines:next,
    }])],"40001");
    const moved=[next[3],next[0],next[1],next[2]];
    await c.query(rpc("pantry_replace_recipes",[],3),[A,PARENT,JSON.stringify([{
      menuItemId:PARENT,expectedOrder:next.map(x=>x.ingredientId),lines:moved,
    }])]);
    assert.deepEqual((await c.query(`select ingredient_id from recipe_lines where menu_item_id=$1
      order by sort_order nulls last,ingredient_id`,[PARENT])).rows.map(r=>r.ingredient_id),
      moved.map(r=>r.ingredientId),"moved order must persist");
    const siblings=await c.query(`select menu_item_id,count(*) from recipe_lines
      where menu_item_id<>$1 group by menu_item_id`,[PARENT]);
    assert.equal(siblings.rows.length,3,"other sizes remain intact");
    // Store original factors only as metadata on the existing price-history row.
    await c.query(`insert into ingredient_prices(ingredient_id,effective_from,source,
      cost_per_base_unit_micros,pack_quantity,pack_unit,pack_cost_cents,original_pack)
      values($1,'2026-10-31','manual',1000,384,'fl_oz',1234,
      '{"count":12,"unitQuantity":32,"unit":"fl_oz"}'::jsonb)`,[milk]);
    let prices=await c.query(`select pack_quantity,pack_unit,pack_cost_cents,
      cost_per_base_unit_micros,original_pack from ingredient_prices where ingredient_id=$1`,[milk]);
    assert.equal(Number(prices.rows[0].pack_quantity),384);
    assert.deepEqual(prices.rows[0].original_pack,{count:12,unitQuantity:32,unit:"fl_oz"});
    assert.equal(Number(prices.rows[0].cost_per_base_unit_micros),1000);
    await c.query(`insert into ingredient_prices(ingredient_id,effective_from,source,
      cost_per_base_unit_micros,pack_quantity,pack_unit,pack_cost_cents,original_pack)
      values($1,'2026-11-01','manual',1000,384,'fl_oz',1500,
      '{"count":12,"unitQuantity":32,"unit":"fl_oz"}'::jsonb)`,[milk]);
    assert.equal((await c.query(`select count(*) from ingredient_prices where ingredient_id=$1`,[milk])).rows[0].count,"2");
    await rejectStatement(c,`insert into ingredient_prices(ingredient_id,effective_from,source,
      cost_per_base_unit_micros,pack_quantity,pack_unit,pack_cost_cents,original_pack)
      values($1,'2026-11-02','manual',1000,384,'fl_oz',1500,
      '{"count":12,"unitQuantity":31,"unit":"fl_oz"}'::jsonb)`,[milk],"23514");
    // Any old price lacking original_pack remains a valid null-metadata row.
    await c.query(`insert into ingredient_prices(ingredient_id,effective_from,source,
      cost_per_base_unit_micros,pack_quantity,pack_unit,pack_cost_cents)
      values($1,'2026-10-01','manual',1000,1,'case(1000)',450)`,[owned["cup-hot-12"]]);
    assert.equal((await c.query(`select original_pack from ingredient_prices
      where ingredient_id=$1`,[owned["cup-hot-12"]])).rows[0].original_pack,null);
    // Archive preserves every dependent row and blocks fresh recipe selections.
    const beforeArchiveRecipeCount=(await c.query("select count(*) from recipe_lines where ingredient_id=$1",[milk])).rows[0].count;
    await c.query(rpc("pantry_set_archived",[],3),[A,milk,true]);
    assert.equal((await c.query("select archived_at from ingredients where id=$1",[milk])).rows[0].archived_at!==null,true);
    assert.equal((await c.query("select count(*) from recipe_lines where ingredient_id=$1",[milk])).rows[0].count,beforeArchiveRecipeCount);
    assert.equal((await c.query("select count(*) from ingredient_prices where ingredient_id=$1",[milk])).rows[0].count,"2");
    const separate=(await c.query(`insert into menu_items(business_id,name,base_name,price_cents)
      values($1,'Archived test','Archived test',250) returning id`,[A])).rows[0].id;
    await rejectStatement(c,rpc("pantry_replace_recipes",[],3),[A,separate,JSON.stringify([{
      menuItemId:separate,lines:[{ingredientId:milk,quantity:10,displayUnit:"ml",displayQuantity:10}],
    }])],"P0001");
    // Existing products can still edit a referenced archived ingredient's quantities.
    await c.query(rpc("pantry_replace_recipes",[],3),[A,PARENT,JSON.stringify([{
      menuItemId:PARENT,expectedOrder:moved.map(r=>r.ingredientId),lines:moved,
    }])]);
    await c.query(rpc("pantry_set_archived",[],3),[A,milk,false]);
    assert.equal((await c.query("select archived_at from ingredients where id=$1",[milk])).rows[0].archived_at,null);
    assert.equal((await c.query("select count(*) from ingredient_prices where ingredient_id=$1",[milk])).rows[0].count,"2");
    assert.equal((await c.query("delete from ingredients where id=$1 returning id",[milk])).rowCount,0,
      "RLS must prohibit direct destructive deletion");
    assert.equal((await c.query("select count(*) from ingredients where id=$1",[milk])).rows[0].count,"1");
  });
  await asOwner(db,async c=>{
    await rejectStatement(c,rpc("pantry_set_archived",[],3),[A,owned["milk-whole"],true],"42501");
  },OTHER);
  console.log("PR #319 PostgreSQL: ordered save/reopen, packs, archive/restore, history, RLS and tenant isolation passed");
  console.log("P1 PostgreSQL: migration parses; RLS, idempotency, size identity, draft safety, rollback and recipe CAS passed");
} finally {
  await db.end();
}
