import {describe,it,expect} from "vitest";
import {savedFactCurrent,splitOwnerAnswers} from "./change";
import {ownerAnswerAcknowledgement} from "./resume";
import en from "@/messages/en.json";
const fact=(fact_key:string,value_json:unknown,created_at="2026-11-04T10:00:00Z")=>
 ({fact_key,value_json,created_at,unit:null,period_scope:null});
const facts=[fact("monthly_payroll_cents",1400000),fact("monthly_bills_cents",320000),
 fact("owner_question_913709aa",2.9,"2026-10-30T09:00:00Z"),fact("supplier","Mill Street Dairy")];

describe("a saved fact as a change card shows it",()=>{
 it("shows money as the owner would type it, with the day it was saved",()=>{
  expect(savedFactCurrent(facts,"monthly_payroll_cents","money"))
   .toEqual({value:"14000.00",savedOn:"2026-11-04",canForget:true});
  expect(savedFactCurrent(facts,"owner_question_913709aa","percent"))
   .toEqual({value:"2.9",savedOn:"2026-10-30",canForget:true});
 });
 it("never offers to forget a fact that is also on a screen (bills, card fees)",()=>{
  expect(savedFactCurrent(facts,"monthly_bills_cents","money")?.canForget).toBe(false);
  expect(savedFactCurrent([fact("card_fee_rate_percent",2.9)],"card_fee_rate_percent","percent")?.canForget).toBe(false);
 });
 it("has nothing to show for a fact that is not saved, or a mismatched value",()=>{
  expect(savedFactCurrent(facts,"rent_monthly_cents","money")).toBeNull();
  expect(savedFactCurrent(facts,"supplier","money")).toBeNull();
 });
});

describe("what a card answer keeps",()=>{
 const card={fields:[{key:"supplier"},{key:"student_discounts_nov_3",remember:"this_question" as const}]};
 it("saves lasting answers and never saves this-question answers",()=>{
  expect(splitOwnerAnswers(card,[{fieldKey:"supplier",value:"Mill St"},
   {fieldKey:"student_discounts_nov_3",value:"0"}]))
   .toEqual({keep:[{fieldKey:"supplier",value:"Mill St"}],forget:[],usedOnce:1});
 });
 it("forgets only on a change card that offers it",()=>{
  const change={changeSaved:true as const,fields:[
   {key:"supplier",current:{value:"Mill St",savedOn:"2026-11-04",canForget:true}},
   {key:"monthly_bills_cents",current:{value:"3200.00",savedOn:"2026-11-04",canForget:false}}]};
  expect(splitOwnerAnswers(change,[{fieldKey:"supplier",value:"",forget:true}]))
   .toEqual({keep:[],forget:["supplier"],usedOnce:0});
  expect(()=>splitOwnerAnswers(change,[{fieldKey:"monthly_bills_cents",value:"",forget:true}])).toThrow("forget_not_offered");
  expect(()=>splitOwnerAnswers(card,[{fieldKey:"supplier",value:"",forget:true}])).toThrow("forget_not_offered");
 });
 it("refuses answers to fields the card never asked, and repeats",()=>{
  expect(()=>splitOwnerAnswers(card,[{fieldKey:"rent",value:"1"}])).toThrow();
  expect(()=>splitOwnerAnswers(card,[{fieldKey:"supplier",value:"a"},{fieldKey:"supplier",value:"b"}])).toThrow();
 });
});

describe("what the owner is told after answering",()=>{
 const copy=en.OwnerQuestions;
 it("never says saved when nothing was saved",()=>{
  expect(ownerAnswerAcknowledgement({writeThroughApplied:true,remembered:0,forgotten:0},copy)).toBe(copy.usedOnce);
  expect(ownerAnswerAcknowledgement({writeThroughApplied:true,remembered:0,forgotten:1},copy)).toBe(copy.forgotten);
 });
 it("keeps the existing saved messages",()=>{
  expect(ownerAnswerAcknowledgement({writeThroughApplied:true,remembered:1},copy)).toBe(copy.saved);
  expect(ownerAnswerAcknowledgement({writeThroughApplied:false,remembered:1},copy)).toBe(copy.savedBut);
  expect(ownerAnswerAcknowledgement({writeThroughApplied:true},copy)).toBe(copy.saved);
 });
});
