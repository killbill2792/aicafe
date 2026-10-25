import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe,it,expect } from "vitest";
const forbidden=new RegExp("(?:bg|text|border|ring)-(?:red|blue|amber|gray|green|yellow|slate|stone|zinc|orange|pink|purple|indigo|emerald|teal|rose|violet|lime|cyan|sky)-[0-9]+","g");
describe("chat uses theme colors only",()=>{
 it("disallows raw Tailwind palette colors in home components",()=>{
  const home=join(process.cwd(),"components/home");
  const offending:string[]=[];
  const visit=(directory:string)=>{
   for(const item of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,item.name);
    if(item.isDirectory()){visit(path);continue;}
    if(!/\.(tsx?|jsx?)$/.test(item.name)||item.name.endsWith(".test.ts")||item.name.endsWith(".test.tsx"))continue;
    const matches=readFileSync(path,"utf8").match(forbidden);
    if(matches?.length)offending.push(path+": "+matches.join(","));
   }
  };
  visit(home);
  expect(offending).toEqual([]);
 });
});
