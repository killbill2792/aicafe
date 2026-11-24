import {describe,expect,it} from "vitest";
import {admitU3Sql} from "./u3SqlAdmission";

const admitted=["orders","order_lines","daily_rollups","menu_items","ingredients",
 "recipe_lines","ingredient_prices","expenses","expense_lines","employees","toast_records"];

describe("U3 governed PostgreSQL AST admission",()=>{
 it.each([
  "SELECT count(*) AS n FROM u3_research.orders",
  "SELECT * FROM u3_research.orders",
  "SELECT o.* FROM orders o",
  "WITH selected AS (SELECT * FROM orders) SELECT * FROM selected",
  "SELECT business_date,sum(net_sales_cents) AS total FROM u3_research.daily_rollups GROUP BY business_date ORDER BY business_date",
  "SELECT o.business_date,sum(i.net_sales_cents) AS item_total FROM u3_research.orders o JOIN u3_research.order_lines i ON i.order_id=o.id GROUP BY o.business_date",
  "WITH daily AS (SELECT business_date,sum(net_sales_cents) AS sales FROM u3_research.daily_rollups GROUP BY business_date) SELECT business_date,sales,LAG(sales) OVER(ORDER BY business_date) AS previous FROM daily",
  "SELECT count(*) FROM orders WHERE business_date BETWEEN DATE '2026-11-01' AND DATE '2026-11-20'",
  "SELECT count(*) FROM orders WHERE net_sales_cents > $1",
  "SELECT count(*) FROM orders WHERE EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id=orders.id)",
  "SELECT date_bin(interval '30 minutes',closed_at,timestamp with time zone '2026-01-01 00:00+00') AS bucket,count(*) FROM orders GROUP BY bucket",
  "SELECT timezone('America/Los_Angeles',closed_at)::date AS local_day,count(*) FROM orders GROUP BY local_day",
  "SELECT split_part(pos_order_id,'-',1) AS part,count(*) FROM orders GROUP BY part",
  "SELECT record_type, data #>> '{customer,firstName}' AS observed_field FROM toast_records",
 ])("accepts model-composed valid analytical SQL: %s",async sql=>{
  const meta=await admitU3Sql(sql,admitted,sql.includes("$1")?1:0);
  expect(meta.relations.length).toBeGreaterThan(0);
 });
 it("accepts a valid analytical statement beyond the former character limit while bounding parser resources",async()=>{
  const long="SELECT "+(" ".repeat(13000))+"count(*) AS n FROM orders";
  expect((await admitU3Sql(long,admitted)).relations).toContain("orders");
  await expect(admitU3Sql("SELECT "+" ".repeat(256*1024)+"count(*) FROM orders",admitted))
   .rejects.toMatchObject({reason:"parser_resource_bound"});
 });
 it("does not impose arbitrary 18-relation or 12-CTE research ceilings",async()=>{
  const relations=Array.from({length:21},(_,i)=>"orders o"+i);
  const joined=relations.reduce((q,table,i)=>
    q+(i===0?" FROM ":" JOIN ")+table+(i?" ON o0.id=o"+i+".id":""),"SELECT count(*) AS n");
  const meta=await admitU3Sql(joined,admitted);
  expect(meta.relations).toContain("orders");
  const ctes=Array.from({length:15},(_,i)=>
    "c"+i+" AS (SELECT count(*) AS n FROM orders)").join(",");
  const result=await admitU3Sql("WITH "+ctes+" SELECT n FROM c0",admitted);
  expect(result.cteCount).toBe(15);
 });
 it("accepts a wide analytical query without the former flat AST node ceiling",async()=>{
  const sql="SELECT count(*) FROM orders WHERE net_sales_cents IN ("+Array.from({length:1900},(_,i)=>String(i)).join(",")+")";
  expect((await admitU3Sql(sql,admitted)).nodeCount).toBeGreaterThan(1800);
 });
 it("requires a top-level order rather than a nested/window order for result paging",async()=>{
  const ordered=await admitU3Sql("SELECT id FROM orders ORDER BY id",admitted);
  expect(ordered.hasTopLevelOrder).toBe(true);
  const bare=await admitU3Sql("SELECT id FROM orders",admitted);
  expect(bare.hasTopLevelOrder).toBe(false);
  const nested=await admitU3Sql(
   "WITH x AS (SELECT id FROM orders ORDER BY id) SELECT id FROM x",admitted);
  expect(nested.hasTopLevelOrder).toBe(false);
 });
 it.each([
  "SELECT * FROM public.orders",
  "SELECT * FROM pg_catalog.pg_roles",
  "SELECT * FROM u3_research.connector_credentials",
  "SELECT * FROM orders; DROP TABLE orders;",
  "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x",
  "WITH RECURSIVE x AS (SELECT * FROM orders UNION ALL SELECT * FROM x) SELECT * FROM x",
  "SELECT pg_sleep(5) FROM orders",
  "SELECT set_config('aicafe.u3_research_scope','foreign',true) FROM orders",
  "SELECT pg_read_file('/etc/passwd') FROM orders",
  "SELECT * INTO temp_new FROM orders",
  "SELECT * FROM orders FOR UPDATE",
  "SELECT * FROM unnest(ARRAY[1,2]) AS raw",
  "SELECT * FROM orders WHERE id::regclass IS NOT NULL",
  "SELECT data FROM toast_records",
  "SELECT * FROM toast_records",
  "SELECT r.* FROM toast_records r",
  "SELECT r FROM toast_records r",
  "SELECT r::text FROM toast_records r",
  "SELECT data #>> '{apiKey}' FROM toast_records",
  "SELECT data #>> '{customer}' FROM toast_records",
  "SELECT data ->> 'customer' FROM toast_records",
  "SELECT (data #>> '{customer}') || ' suffix' FROM toast_records",
  "SELECT left(data #>> '{customer}',24) FROM toast_records",
  "SELECT data #>> '{unknownUnreviewed,private}' FROM toast_records",
  "SELECT data #>> '{customer,cardNumber}' FROM toast_records",
  "SELECT data ->> 'refreshToken' FROM toast_records",
  "SELECT data #>> '{customer,api_key}' FROM toast_records",
  "SELECT data #>> '{customer,firstName}; DROP TABLE orders;' FROM toast_records",
  "SELECT t.data AS innocent FROM toast_records t",
  "SELECT min(net_sales_cents::text) AS result FROM orders AS o(a,b,net_sales_cents)",
  "SELECT count(*) FROM orders AS o(net_sales_cents)",
  "WITH x(net_sales_cents) AS (SELECT pos_order_id FROM orders) SELECT min(net_sales_cents) FROM x",
  "SELECT data FROM toast_records AS r(source,source_ref,status,business_date,record_type,record_ref,order_ref,check_ref,counts_in_sales,data)",
  "SELECT SUM(net_sales_cents) AS result, 999 AS result FROM orders",
  "SELECT MIN(orders::text) AS exposed FROM orders",
  "SELECT MIN(o::text) AS exposed FROM orders o",
  "SELECT MIN(orders_count::text) AS result FROM orders AS orders_count",
  "SELECT MIN(o::text) AS exposed FROM orders AS o",
  "SELECT MIN(x::text) AS exposed FROM (SELECT net_sales_cents FROM orders) AS x",
  "WITH cte AS (SELECT net_sales_cents FROM orders) SELECT MIN(cte::text) FROM cte",
  "SELECT MIN(data::text) FROM toast_records",
  "SELECT * FROM orders WHERE net_sales_cents > $2",
  "SELECT 1",
 ])("rejects unsafe, unauthorized, or unbounded SQL: %s",async sql=>{
  await expect(admitU3Sql(sql,admitted,1)).rejects.toThrow("invalid_query");
 });
 it("requires actual aggregate evidence and denies personal source reads off-turn",async()=>{
  await expect(admitU3Sql("SELECT id FROM orders",admitted,0,true))
   .rejects.toThrow("unattended_aggregate_required");
  await expect(admitU3Sql("SELECT sum(gross_cents) FROM employee_pay_period_facts",
    [...admitted,"employee_pay_period_facts"],0,true,["gross_cents"]))
   .rejects.toThrow("unattended_aggregate_required");
  await expect(admitU3Sql("SELECT count(*) FROM staff_availability_rules",
    [...admitted,"staff_availability_rules"],0,true))
   .rejects.toThrow("unattended_aggregate_required");
  await expect(admitU3Sql("SELECT count(*) FROM employees",admitted,0,true))
   .rejects.toThrow("unattended_aggregate_required");
  await expect(admitU3Sql("SELECT count(*) FROM orders",admitted,0,true))
   .resolves.toMatchObject({relations:["orders"]});
  await expect(admitU3Sql("SELECT MIN(pos_order_id) AS innocent FROM orders",
   admitted,0,true,["business_date","net_sales_cents"]))
   .rejects.toThrow("unattended_aggregate_required");
  await expect(admitU3Sql("SELECT SUM(net_sales_cents) AS n FROM orders",
   admitted,0,true,["business_date","net_sales_cents"]))
   .resolves.toMatchObject({relations:["orders"]});
  await expect(admitU3Sql(
   "SELECT MIN(orders_count::text) AS result FROM orders AS orders_count",
   admitted,0,true,["orders_count","net_sales_cents"]))
   .rejects.toThrow("invalid_query");
  await expect(admitU3Sql("SELECT SUM(o.net_sales_cents) AS result FROM orders o",
   admitted,0,true,["net_sales_cents"]))
   .resolves.toMatchObject({relations:["orders"]});
  await expect(admitU3Sql("SELECT * FROM orders",
   admitted,0,true,["business_date","net_sales_cents"]))
   .rejects.toThrow("unattended_aggregate_required");
 });
 it("requires reducing aggregation in the returned grain rather than an unrelated subquery or window",async()=>{
  const columns=["net_sales_cents"];
  for(const sql of [
   "SELECT net_sales_cents FROM orders WHERE EXISTS(SELECT count(*) FROM orders)",
   "SELECT sum(net_sales_cents) OVER() AS total FROM orders",
   "SELECT net_sales_cents,(SELECT count(*) FROM orders) AS n FROM orders",
   "WITH x AS (SELECT count(*) AS n FROM orders) SELECT net_sales_cents FROM orders",
   "WITH x AS (SELECT count(*) AS n FROM orders) SELECT net_sales_cents FROM orders CROSS JOIN x"
  ]){
   await expect(admitU3Sql(sql,admitted,0,true,columns)).rejects.toThrow("unattended_aggregate_required");
   await expect(admitU3Sql(sql,admitted)).resolves.toMatchObject({relations:["orders"]});
  }
  for(const sql of [
   "SELECT count(*) AS customer_count FROM orders",
   "WITH x AS (SELECT sum(net_sales_cents) AS net_sales_cents FROM orders) SELECT net_sales_cents FROM x",
   "SELECT net_sales_cents FROM (SELECT sum(net_sales_cents) AS net_sales_cents FROM orders) x"
  ])await expect(admitU3Sql(sql,admitted,0,true,columns)).resolves.toMatchObject({relations:["orders"]});
 });
 it("resolves unattended aggregate aliases against actual source-specific privacy",async()=>{
  const units={orders:{business_date:null,net_sales_cents:"cents" as const},expenses:{business_date:null,net_sales_cents:null,amount_cents:"cents" as const}};
  const safe={orders:["business_date","net_sales_cents"],expenses:["business_date","amount_cents"]};
  const admit=(sql:string)=>admitU3Sql(sql,["orders","expenses"],0,true,["business_date","net_sales_cents","amount_cents"],{},units,safe);
  await expect(admit("WITH daily AS (SELECT business_date, sum(net_sales_cents) AS total FROM orders GROUP BY business_date) SELECT business_date,total FROM daily ORDER BY total")).resolves.toMatchObject({outputUnits:{total:"cents"}});
  await expect(admit("SELECT sum(amount_cents) AS revenue FROM expenses ORDER BY revenue")).resolves.toMatchObject({outputUnits:{revenue:"cents"}});
  await expect(admit("SELECT min(e.net_sales_cents) AS value FROM expenses e")).rejects.toThrow("unattended_aggregate_required");
  await expect(admit("WITH x AS (SELECT e.net_sales_cents AS amount_cents FROM expenses e) SELECT sum(amount_cents) FROM x")).rejects.toThrow("unattended_aggregate_required");
  await expect(admit("SELECT sum(o.net_sales_cents) FROM orders o JOIN expenses e ON e.net_sales_cents=o.net_sales_cents")).rejects.toThrow("unattended_aggregate_required");
 });
 it("allows explicit nonpersonal detail but not a cross-source privacy bypass",async()=>{
  const units={menu_items:{id:null,name:null,price_cents:"cents" as const,description:null},orders:{net_sales_cents:"cents" as const}};
  const safe={menu_items:["id","name","price_cents"],orders:["net_sales_cents"]};
  const admit=(sql:string)=>admitU3Sql(sql,["menu_items","orders"],0,true,[],{},units,safe);
  await expect(admit("SELECT name,price_cents FROM menu_items ORDER BY id")).resolves.toMatchObject({relations:["menu_items"],outputUnits:{price_cents:"cents"}});
  await expect(admit("SELECT description FROM menu_items")).rejects.toThrow("unattended_aggregate_required");
  await expect(admit("SELECT name,net_sales_cents FROM menu_items CROSS JOIN orders")).rejects.toThrow("unattended_aggregate_required");
  await expect(admit("SELECT * FROM menu_items")).rejects.toThrow("unattended_aggregate_required");
 });
 it("derives trusted calculator units from source columns and SQL expressions, never aliases",async()=>{
  const units={net_sales_cents:"cents" as const,orders_count:"count" as const};
  const money=await admitU3Sql("SELECT SUM(net_sales_cents) AS result FROM orders",admitted,0,false,[],units);
  expect(money.outputUnits).toEqual({result:"cents"});
  const forgery=await admitU3Sql("SELECT COUNT(*) AS net_sales_cents FROM orders",admitted,0,false,[],units);
  expect(forgery.outputUnits).toEqual({net_sales_cents:"count"});
  const literal=await admitU3Sql("SELECT 12345 AS net_sales_cents FROM orders",admitted,0,false,[],units);
  expect(literal.outputUnits).toEqual({});
  const addition=await admitU3Sql("SELECT net_sales_cents+net_sales_cents AS total FROM orders",admitted,0,false,[],units);
  expect(addition.outputUnits).toEqual({total:"cents"});
  const ambiguous=await admitU3Sql("SELECT net_sales_cents*orders_count AS amount_cents FROM orders",admitted,0,false,[],units);
  expect(ambiguous.outputUnits).toEqual({});
  await expect(admitU3Sql("SELECT SUM(net_sales_cents) AS result, 999 AS result FROM orders",
   admitted,0,false,[],units)).rejects.toThrow("invalid_query");
  await expect(admitU3Sql("SELECT COUNT(*) AS result, COUNT(*) AS result FROM orders",
   admitted,0,false,[],units)).rejects.toThrow("invalid_query");
  const cte=await admitU3Sql(
   "WITH x AS (SELECT COUNT(*) AS net_sales_cents FROM orders) SELECT net_sales_cents FROM x",
   admitted,0,false,[],units);
  expect(cte.outputUnits).toEqual({net_sales_cents:"count"});
  const derived=await admitU3Sql(
   "SELECT net_sales_cents FROM (SELECT COUNT(*) AS net_sales_cents FROM orders) x",
   admitted,0,false,[],units);
  expect(derived.outputUnits).toEqual({net_sales_cents:"count"});
 });
 it("retains the microcent source scale without treating raw ingredient prices as whole cents",async()=>{
  const relations={ingredient_prices:{ingredient_id:null,cost_per_base_unit_micros:"microcents" as const}};
  const r=await admitU3Sql("SELECT cost_per_base_unit_micros AS rate,MAX(cost_per_base_unit_micros) OVER() AS high,COUNT(*) OVER() AS n FROM ingredient_prices",["ingredient_prices"],0,false,[],{},relations);
  expect(r.outputUnits).toEqual({rate:"microcents",high:"microcents",n:"count"});
  const f=await admitU3Sql("SELECT 2000000 AS cost_per_base_unit_micros FROM ingredient_prices",["ingredient_prices"],0,false,[],{},relations);
  expect(f.outputUnits).toEqual({});
 });
 it("attests actual scoped monetary units through CTE, joins and windows without trusting renamed literals",async()=>{
  const rels={orders:{id:null,net_sales_cents:"cents" as const},order_lines:{order_id:null,net_sales_cents:"cents" as const}};
  const result=await admitU3Sql("WITH daily AS (SELECT sum(o.net_sales_cents) AS sales FROM orders o JOIN order_lines l ON l.order_id=o.id) SELECT sales,lag(sales) OVER(ORDER BY sales) AS previous FROM daily",
   admitted,0,false,[],{},rels);
  expect(result.outputUnits).toEqual({sales:"cents",previous:"cents"});
  const forged=await admitU3Sql("WITH x AS (SELECT 12345 AS net_sales_cents FROM orders) SELECT net_sales_cents FROM x",admitted,0,false,[],{},rels);
  expect(forged.outputUnits).toEqual({});
  const ratio=await admitU3Sql("WITH x AS (SELECT sum(net_sales_cents) AS sales FROM orders) SELECT sales/sales AS share FROM x",admitted,0,false,[],{},rels);
  expect(ratio.outputUnits).toEqual({share:"ratio"});
 });
 it("attests direct column identity across aliases but not model computations or unrelated source bindings",async()=>{
  const rels={orders:{id:null,net_sales_cents:"cents" as const,orders_count:"count" as const}};
  const query=(sql:string)=>admitU3Sql(sql,admitted,0,false,[],{},rels);
  const all=await query("SELECT o.* FROM orders o");
  expect(all.outputUnits).toEqual({net_sales_cents:"cents",orders_count:"count"});
  expect(all.outputOrigins.id).toMatchObject({relation:"orders",column:"id"});
  const derived=await query("WITH x AS (SELECT id,net_sales_cents FROM orders) SELECT a.id AS id,a.net_sales_cents AS amount,b.net_sales_cents AS other FROM x a JOIN x b ON a.id=b.id");
  expect(derived.outputOrigins.id.binding).toBe(derived.outputOrigins.amount.binding);
  expect(derived.outputOrigins.other.binding).not.toBe(derived.outputOrigins.amount.binding);
  const computed=await query("SELECT SUM(COALESCE(net_sales_cents,0)) AS total, ROUND(AVG(net_sales_cents),0) AS average, SUM(CASE WHEN orders_count>0 THEN net_sales_cents ELSE 0 END) AS selected, SUM(COALESCE(net_sales_cents,12345)) AS untyped FROM orders");
  expect(computed.outputUnits).toEqual({total:"cents",average:"cents",selected:"cents"});
  expect(computed.outputOrigins).toEqual({});
 });
 it("rejects positional column renames before they can bypass privacy or unit admission",async()=>{
  const rels={orders:{net_sales_cents:"cents" as const,orders_count:"count" as const}};
  for(const sql of [
   "WITH x(net_sales_cents, other) AS (SELECT orders_count,net_sales_cents FROM orders) SELECT net_sales_cents FROM x",
   "SELECT net_sales_cents FROM (SELECT orders_count,net_sales_cents FROM orders) x(net_sales_cents,other)",
   "SELECT x.net_sales_cents FROM orders x(orders_count,net_sales_cents)"
  ]){
   await expect(admitU3Sql(sql,admitted,0,false,[],{},rels)).rejects.toThrow("invalid_query");
  }
 });
 it("classifies rejected SQL without returning raw model or database contents",async()=>{
  await expect(admitU3Sql("SELECT pg_sleep(1) FROM orders",admitted)).rejects.toMatchObject({message:"invalid_query",reason:"unapproved_function"});
  await expect(admitU3Sql("SELECT count(*) FROM public.orders",admitted)).rejects.toMatchObject({message:"invalid_query",reason:"unapproved_relation"});
  await expect(admitU3Sql("SELECT count(*) FROM orders WHERE id=$2",admitted,1)).rejects.toMatchObject({message:"invalid_query",reason:"unbound_parameter"});
 });
 it("cannot change café or role from a query parameter",async()=>{
  await expect(admitU3Sql("SELECT count(*) FROM orders WHERE id=$1",admitted,0))
   .rejects.toThrow("invalid_query");
  await expect(admitU3Sql("SELECT count(*) FROM orders WHERE id=$1",admitted,1))
   .resolves.toMatchObject({relations:["orders"]});
 });
});
