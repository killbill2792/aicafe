import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {canonicalDictionary,canonicalViewNames} from "./dictionary";
const source=[readFileSync(resolve("supabase/migrations/20261028000112_canonical_views.sql"),"utf8"),
 readFileSync(resolve("supabase/migrations/20261028000113_toast_payment_fields_day_check.sql"),"utf8")].join("\n");
const docs=readFileSync(resolve("docs/data-dictionary.md"),"utf8");
describe("canonical view column dictionary contract",()=>{
 it("documents every SQL view column, without phantom columns",()=>{
  const names=[...source.matchAll(/create or replace view public\.(cv_[a-z_]+)\s*\(([^)]+)\)\s*with\s*\(security_invoker=true\)/g)];
  expect(new Set(names.map(m=>m[1]))).toEqual(new Set(canonicalViewNames));
  for(const [,view,columns] of names.filter((m,i)=>names.findLastIndex(x=>x[1]===m[1])===i)){
   const expected=Object.keys(canonicalDictionary[view as keyof typeof canonicalDictionary].columns).sort();
   expect(columns.split(",").map(v=>v.trim()).sort()).toEqual(expected);
  }
 });
 it("generated documentation covers every allowed view and column",()=>{
  for(const view of canonicalViewNames){
   const section=docs.split("## "+view+"\n")[1]?.split("\n## ")[0];
   expect(section,view).toBeDefined();
   for(const col of Object.keys(canonicalDictionary[view].columns))
    expect(section).toContain("| "+col+" |");
  }
 });
 it("does not expose raw provider payloads through a canonical view",()=>{
  expect(source).not.toMatch(/create or replace view public\.cv_[a-z_]+[\s\S]*\bselect\s+\*\s+from\s+public\.toast_raw_records/i);
  expect(source).toContain("security_invoker=true");
 });
});
