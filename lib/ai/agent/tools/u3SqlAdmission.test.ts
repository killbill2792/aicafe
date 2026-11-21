import {describe,expect,it} from "vitest";
import {admitU3Sql} from "./u3SqlAdmission";

const admitted=["orders","order_lines","daily_rollups","menu_items","ingredients",
 "recipe_lines","ingredient_prices","expenses","expense_lines","employees","toast_records"];

describe("U3 governed PostgreSQL AST admission",()=>{
 it.each([
  "SELECT count(*) AS n FROM u3_research.orders",
  "SELECT business_date,sum(net_sales_cents) AS total FROM u3_research.daily_rollups GROUP BY business_date ORDER BY business_date",
  "SELECT o.business_date,sum(i.net_sales_cents) AS item_total FROM u3_research.orders o JOIN u3_research.order_lines i ON i.order_id=o.id GROUP BY o.business_date",
  "WITH daily AS (SELECT business_date,sum(net_sales_cents) AS sales FROM u3_research.daily_rollups GROUP BY business_date) SELECT business_date,sales,LAG(sales) OVER(ORDER BY business_date) AS previous FROM daily",
  "SELECT count(*) FROM orders WHERE business_date BETWEEN DATE '2026-11-01' AND DATE '2026-11-20'",
  "SELECT count(*) FROM orders WHERE net_sales_cents > $1",
  "SELECT count(*) FROM orders WHERE EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id=orders.id)",
  "SELECT record_type, data #>> '{customer,firstName}' AS observed_field FROM toast_records",
 ])("accepts model-composed valid analytical SQL: %s",async sql=>{
  const meta=await admitU3Sql(sql,admitted,sql.includes("$1")?1:0);
  expect(meta.relations.length).toBeGreaterThan(0);
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
  await expect(admitU3Sql("SELECT * FROM orders",
   admitted,0,true,["business_date","net_sales_cents"]))
   .rejects.toThrow("unattended_aggregate_required");
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
 });
 it("cannot change café or role from a query parameter",async()=>{
  await expect(admitU3Sql("SELECT count(*) FROM orders WHERE id=$1",admitted,0))
   .rejects.toThrow("invalid_query");
  await expect(admitU3Sql("SELECT count(*) FROM orders WHERE id=$1",admitted,1))
   .resolves.toMatchObject({relations:["orders"]});
 });
});
