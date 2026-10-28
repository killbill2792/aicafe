// Generate Markdown from the TypeScript dictionary, without maintaining two copies.
import ts from "typescript";
import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
const source=readFileSync(resolve("lib/data/canonical/dictionary.ts"),"utf8");
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,
 target:ts.ScriptTarget.ES2022}}).outputText;
const url="data:text/javascript;base64,"+Buffer.from(js).toString("base64");
const {canonicalViewNames,canonicalDictionary}=await import(url);
const out=["# Canonical café data dictionary","","Each row is café-scoped and source-tagged. The view uses invoker RLS; no raw card, guest or credential payload is exposed.",""];
for(const view of canonicalViewNames){
 const def=canonicalDictionary[view];
 out.push("## "+view,"",def.meaning,"","| Column | Meaning | Unit | Source | Example owner question |","|---|---|---|---|---|");
 for(const [name,col] of Object.entries(def.columns))
  out.push("| "+[name,col.meaning,col.unit,col.source,col.example].map(v=>String(v).replaceAll("|","/")).join(" | ")+" |");
 out.push("");
}
writeFileSync(resolve("docs/data-dictionary.md"),out.join("\n")+"\n");
