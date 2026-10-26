import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
const path=resolve("supabase/migrations/20261027000100_staff_preferred_language.sql");
const sql=readFileSync(path,"utf8");
describe("PR I additive language migration",()=>{
 it("adds only the nullable, constrained employee language field",()=>{
  expect(sql).toMatch(/ALTER TABLE public\.employees ADD COLUMN IF NOT EXISTS preferred_language text NULL/);
  expect(sql).toMatch(/CHECK \(preferred_language IN \('en','es','ar'\)\)/);
  expect(sql).not.toMatch(/CREATE TABLE|DROP TABLE|DISABLE ROW LEVEL SECURITY|DROP POLICY/i);
 });
 it("keeps the owner and demo security boundary on both writes",()=>{
  expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.staff_write_person/);
  expect(sql).toMatch(/public\.scheduling_is_owner\(p_business_id\)/);
  expect(sql).toMatch(/is_demo=false/);
  expect(sql).toMatch(/WHERE business_id=p_business_id AND id=p_id FOR UPDATE/);
  expect(sql).toMatch(/preferred_language=CASE WHEN p_payload \? 'language'/);
  expect(sql).toMatch(/available_days,preferred_language,active/);
 });
 it("validates request shape and retains original function grants",()=>{
  expect(sql).toMatch(/NOT IN \('en','es','ar'\)/);
  expect(sql).toMatch(/k\.key NOT IN \('name','role','wageCents','phone','language'/);
  expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.staff_write_person\(uuid,uuid,jsonb\) FROM PUBLIC,anon/);
  expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.staff_write_person\(uuid,uuid,jsonb\) TO authenticated/);
 });
});