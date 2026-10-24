import {describe,expect,it} from "vitest";
import {diffFields,formatCardValue} from "./values";

describe("owner approval value formatting and diffs",()=>{
 it("only displays changed hourly wage as currency per hour",()=>{
  const rows=diffFields([
   {field:"name",label:"Name",value:{kind:"text",text:"Amy"}},
   {field:"wage",label:"Hourly wage",value:{kind:"moneyRate",cents:1800,per:"hour"}}],[
   {field:"name",label:"Name",value:{kind:"text",text:"Amy"}},
   {field:"wage",label:"Hourly wage",value:{kind:"moneyRate",cents:2000,per:"hour"}}]);
  expect(rows).toHaveLength(1);
  expect(rows[0].field).toBe("wage");
  expect(formatCardValue(rows[0].before!,"en","USD")).toBe("$18.00/hour");
  expect(formatCardValue(rows[0].after!,"en","USD")).toBe("$20.00/hour");
 });
 it("has honest unknowns and after-only additions",()=>{
  expect(formatCardValue({kind:"missing",reason:"noWage"},"en","USD")).toBe("No wage");
  const rows=diffFields([],[{field:"name",label:"Name",value:{kind:"text",text:"Carla"}}]);
  expect(rows).toEqual([{field:"name",label:"Name",before:null,after:{kind:"text",text:"Carla"}}]);
 });
 it("formats Spanish and Arabic without displaying cent symbols",()=>{
  for(const locale of ["es","ar"] as const){
   const wage=formatCardValue({kind:"moneyRate",cents:1850,per:"hour"},locale,"USD");
   expect(wage).toContain("18");
   expect(wage).not.toContain("¢");
   expect(formatCardValue({kind:"missing",reason:"noWage"},locale,"USD")).not.toBe("—");
  }
 });
});
