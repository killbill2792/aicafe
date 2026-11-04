import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";

/** Migration 152 on an isolated local PostgreSQL (same service as ownerFacts.db.test.ts).
 * Never connect this fixture to production or any non-loopback host. */
const url=process.env.OWNER_FACTS_DB_URL;
const local=(()=>{
 if(!url)return false;
 try{const parsed=new URL(url);
  return ["localhost","127.0.0.1","::1","[::1]"].includes(parsed.hostname)&&parsed.pathname==="/ownerfacts_test";}
 catch{return false;}
})();
const databaseTest=url?it:it.skip;
describe("migration 152: the owner forgets a saved fact",()=>{
 databaseTest("closes the fact with who did it, refuses screen facts and other cafés",()=>{
  expect(local,"OWNER_FACTS_DB_URL must target local /ownerfacts_test only").toBe(true);
  const from=(name:string)=>readFileSync(new URL(name,import.meta.url),"utf8");
  const migration=(name:string)=>readFileSync(new URL("../../supabase/migrations/"+name,import.meta.url),"utf8");
  // Its own throwaway database on the same local server, so it never collides with
  // the migration 110 test running at the same time.
  const own=new URL(url!);own.pathname="/ownerfacts_forget_test";
  for(const statement of ["drop database if exists ownerfacts_forget_test","create database ownerfacts_forget_test"])
   execFileSync("psql",["-X","-q","-v","ON_ERROR_STOP=1","-d",url!,"-c",statement],{encoding:"utf8",timeout:30000});
  const sql=[from("dbFixture.schema.sql"),migration("20261028000110_owner_facts.sql"),
   migration("20261104000152_forget_owner_fact.sql"),from("dbFixture.forget.sql")].join("\n\n");
  const result=execFileSync("psql",["-X","-q","-t","-A","-v","ON_ERROR_STOP=1","-d",own.toString()],
   {input:sql,encoding:"utf8",timeout:30000,maxBuffer:1024*1024*4});
  expect(result).toContain("FORGET_OK");
 });
});
