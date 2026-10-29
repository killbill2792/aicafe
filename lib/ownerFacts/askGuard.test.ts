import {describe,it,expect} from "vitest";
import {withoutSavedFactFields} from "./askGuard";
const ownerFacts=[{fact_key:"monthly_payroll_cents",value_json:1400000,
 created_at:"2026-10-28T00:00:00Z",unit:"cents",period_scope:"month"}];
const question={kind:"facts",question:"What is missing?",options:[],allowOther:false,
 fields:[{key:"payroll",label:"Monthly payroll",inputType:"money",units:[],defaultUnit:""},
  {key:"supplier",label:"Supplier",inputType:"text",units:[],defaultUnit:""}]};
describe("model ask guard across new chats",()=>{
 it("removes saved numbers from a new mixed question",()=>{
  expect(withoutSavedFactFields(question,ownerFacts)).toMatchObject({
   fields:[expect.objectContaining({key:"supplier"})]
  });
 });
 it("never repeats a fully saved fact",()=>{
  expect(withoutSavedFactFields({...question,fields:question.fields.slice(0,1)},ownerFacts)).toBeNull();
 });
 it("keeps verified choice requests intact",()=>{
  expect(withoutSavedFactFields({...question,kind:"choice"},ownerFacts)).toMatchObject({kind:"choice"});
 });
});
