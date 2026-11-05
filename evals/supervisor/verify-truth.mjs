/** Recompute the independent golden answers with SQL, not agent arithmetic.
 * Uses Node 22's built-in in-memory SQLite, no production connection. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const seed=JSON.parse(readFileSync(new URL("./seed.json",import.meta.url),"utf8"));
const db=new DatabaseSync(":memory:");
try {
  db.exec("CREATE TABLE daily (date TEXT PRIMARY KEY, net_sales_cents INTEGER, wages_cents INTEGER, staff_tax_cents INTEGER, wage_status TEXT)");
  db.exec("CREATE TABLE menu (id TEXT PRIMARY KEY, name TEXT, active INTEGER, price_cents INTEGER, recipe_cost_cents INTEGER, units_oct19 INTEGER)");
  const insertDay=db.prepare("INSERT INTO daily VALUES(?,?,?,?,?)");
  for(const d of seed.days)insertDay.run(d.date,d.netSalesCents,d.wagesCents,d.staffTaxCents,d.wageStatus);
  const insertMenu=db.prepare("INSERT INTO menu VALUES(?,?,?,?,?,?)");
  for(const m of seed.menu)insertMenu.run(m.id,m.name,m.active?1:0,m.priceCents,m.recipeCostCents,m.unitsOct19);

  const numeric=(key,sql,tolerance=0)=>{
    const actual=Number(db.prepare(sql).get().value);
    const expected=seed.sqlTruth[key];
    assert.ok(Number.isFinite(actual)&&Math.abs(actual-expected)<=tolerance,
      key+": SQL "+actual+" != fixture "+expected);
  };
  numeric("day19LaborRate","SELECT 1.0*(wages_cents+staff_tax_cents)/net_sales_cents AS value FROM daily WHERE date='2026-10-19'");
  numeric("day19LaborCents","SELECT (wages_cents+staff_tax_cents) AS value FROM daily WHERE date='2026-10-19'");
  numeric("day20LaborRate","SELECT 1.0*(wages_cents+staff_tax_cents)/net_sales_cents AS value FROM daily WHERE date='2026-10-20'");
  numeric("twoDayLaborRate","SELECT 1.0*SUM(wages_cents+staff_tax_cents)/SUM(net_sales_cents) AS value FROM daily WHERE date BETWEEN '2026-10-19' AND '2026-10-20'",1e-12);
  assert.equal(db.prepare("SELECT 1.0*(wages_cents+staff_tax_cents)/net_sales_cents AS value FROM daily WHERE date='2026-10-21'").get().value,
    seed.sqlTruth.day21LaborRate,"missing wage must remain SQL NULL");
  numeric("lattePriceCents","SELECT price_cents AS value FROM menu WHERE name='House Latte'");
  numeric("teaPriceCents","SELECT price_cents AS value FROM menu WHERE name='Spiced Tea'");
  numeric("cocoaCostCents","SELECT recipe_cost_cents AS value FROM menu WHERE name='Cocoa'");
  numeric("latteUnits","SELECT units_oct19 AS value FROM menu WHERE name='House Latte'");
  const named=(key,sql)=>assert.equal(db.prepare(sql).get().value,seed.sqlTruth[key],key);
  named("lowestPriceName","SELECT name AS value FROM menu WHERE active=1 ORDER BY price_cents ASC LIMIT 1");
  named("highestPriceName","SELECT name AS value FROM menu WHERE active=1 ORDER BY price_cents DESC LIMIT 1");
  named("highestUnitMarginName","SELECT name AS value FROM menu WHERE active=1 ORDER BY (price_cents-recipe_cost_cents) DESC LIMIT 1");
  numeric("highestUnitMarginCents","SELECT MAX(price_cents-recipe_cost_cents) AS value FROM menu WHERE active=1");
  console.log("Supervisor SQL truth: verified 13 golden values from seeded café rows");
} finally {db.close();}
