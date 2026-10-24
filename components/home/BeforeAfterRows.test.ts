import {describe,expect,it} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import BeforeAfterRows from "./BeforeAfterRows";

describe("one shared approval diff renderer",()=>{
 it("renders menu prices through the same before/after rows as staff",()=>{
  const html=renderToStaticMarkup(createElement(BeforeAfterRows,{
   locale:"en",currency:"USD",rows:[{
    field:"price",label:"Price",
    before:{kind:"money",cents:450},after:{kind:"money",cents:500},
   }],
  }));
  expect(html).toContain("$4.50");
  expect(html).toContain("$5.00");
  expect(html).toContain("Price");
  expect(html).toContain("→");
 });
 it("renders historical v1 string previews read-only",()=>{
  const html=renderToStaticMarkup(createElement(BeforeAfterRows,{
   locale:"en",rows:[{label:"Historical shift",before:"Monday 09:00",after:"Monday 10:00"}],
  }));
  expect(html).toContain("Historical shift");
  expect(html).toContain("Monday 09:00");
  expect(html).toContain("Monday 10:00");
 });
 it("reverses the arrow in Arabic RTL",()=>{
  const html=renderToStaticMarkup(createElement(BeforeAfterRows,{
   locale:"ar",rows:[{field:"price",label:"Price",
    before:{kind:"money",cents:1800},after:{kind:"money",cents:2000}}],
  }));
  expect(html).toContain('dir="rtl"');
  expect(html).toContain("←");
  expect(html).not.toContain("→");
 });
});
