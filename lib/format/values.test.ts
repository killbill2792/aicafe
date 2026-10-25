import {describe,expect,it} from "vitest";
import {diffFields,formatCardValue,formatCardField} from "./values";
describe("approval card values",()=>{
 it("retains target context and localizes specific rule and weekday labels",()=>{
  expect(formatCardField("shift","Amy","en")).toBe("Amy");
  expect(formatCardField("rule:weekly_ot_enabled","Overtime","en")).not.toBe("Rule");
  expect(formatCardField("rule:weekly_ot_enabled","Overtime","es")).not.toBe("Regla");
  expect(formatCardField("availability:1","Monday","ar")).not.toBe("1");
  expect(formatCardField("schedule:2026-11-02","Week","en")).toContain("2026-11-02");
 });
 it("uses the café currency instead of a hardcoded US dollar",()=>{
  expect(formatCardValue({kind:"moneyRate",cents:1800,per:"hour"},"en","EUR")).toBe("€18.00/hour");
 });
 it("only emits changed wages with correct per-hour money",()=>{
  const rows=diffFields([{field:"name",label:"Name",value:{kind:"text",text:"Amy"}},
    {field:"wage",label:"Hourly wage",value:{kind:"moneyRate",cents:1800,per:"hour"}}],
    [{field:"name",label:"Name",value:{kind:"text",text:"Amy"}},
    {field:"wage",label:"Hourly wage",value:{kind:"moneyRate",cents:2000,per:"hour"}}]);
  expect(rows).toHaveLength(1);
  expect(rows[0].field).toBe("wage");
  expect(formatCardValue(rows[0].before!,"en","USD")).toBe("$18.00/hour");
  expect(formatCardValue(rows[0].after!,"en","USD")).toBe("$20.00/hour");
 });
 it("shows unknown wage, after-only additions and Arabic / Spanish labels",()=>{
  expect(formatCardValue({kind:"missing",reason:"noWage"},"en","USD")).toBe("No wage");
  expect(diffFields([],[{field:"name",label:"Name",value:{kind:"text",text:"Carla"}}])[0].before).toBeNull();
  for(const l of ["es","ar"] as const){
   expect(formatCardValue({kind:"moneyRate",cents:1850,per:"hour"},l,"USD")).not.toContain("¢");
   expect(formatCardValue({kind:"missing",reason:"noWage"},l,"USD")).not.toBe("—");
  }
 });
});
