import {describe,it,expect} from "vitest";
import {resolveEntity,newResolveState,ownerChoiceGuard,observeToolResult} from "./resolve";
const hot="11111111-1111-4111-8111-111111111111",iced="22222222-2222-4222-8222-222222222222";
const rows=[{id:hot,name:"Latte",category:"Hot"},{id:iced,name:"Latte",category:"Iced"},
{id:"33333333-3333-4333-8333-333333333333",name:"Café",category:"Coffee"}];
const props={nameOf:(r:typeof rows[number])=>r.name,idOf:(r:typeof rows[number])=>r.id,describe:(r:typeof rows[number])=>r.category};
describe("safe entity resolution",()=>{
 it("resolves exact ids before duplicate names",()=>{
   expect(resolveEntity("product",iced,rows,props)).toEqual({status:"resolved",value:rows[1]});
 });
 it("never picks the first duplicate name",()=>{
   const r=resolveEntity("product","Latte",rows,props);
   expect(r.status).toBe("ambiguous");
   if(r.status==="ambiguous"){expect(r.candidates).toHaveLength(2);expect(r.candidates.map(c=>c.id)).toEqual([hot,iced]);}
 });
 it("normalizes accents and Arabic letter variants",()=>{
   expect(resolveEntity("product","cafe",rows,props)).toEqual({status:"resolved",value:rows[2]});
   const people=[{id:"1",name:"أحمد"},{id:"2",name:"Maria"}];
   expect(resolveEntity("staff","احمد",people,{nameOf:p=>p.name,idOf:p=>p.id,describe:()=>""})).toEqual({status:"resolved",value:people[0]});
 });
 it("suggests actual rows without inventing ids",()=>{
   const r=resolveEntity("product","unknown",rows,props);
   expect(r.status).toBe("none");
   if(r.status==="none")expect(r.suggestions.every(c=>rows.some(row=>row.id===c.id))).toBe(true);
 });
 it("rejects ambiguous proposed writes and accepts the chosen previous card",()=>{
   const state=newResolveState("raise latte price to $5.50");
   observeToolResult(state,{source:"menu_items",period:null,missing:[],needsOwnerChoice:true,candidates:[{id:hot,label:"Latte — Hot",detail:"Hot"},{id:iced,label:"Latte — Iced",detail:"Iced"}]});
   expect(ownerChoiceGuard(state,hot)?.missing).toEqual(["ownerChoiceRequired"]);
   const chosen=newResolveState("Latte — Iced",[{role:"assistant",content:"Asked: Which? Options: Latte — Hot ("+hot+"); Latte — Iced ("+iced+")"}]);
   expect(chosen.chosenIds.has(iced)).toBe(true);
 });
});
