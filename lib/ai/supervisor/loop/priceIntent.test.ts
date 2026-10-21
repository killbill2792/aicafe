import {describe,it,expect} from "vitest";
import {validatePriceProposalCandidate,ambiguousPriceProposalOptions} from "./priceIntent";
const id="a0000000-0000-4000-8000-000000000001";
const menu=[{id,name:"Latte 12 oz",baseName:"Latte",active:true},{id:"another",name:"Latte 16 oz",baseName:"Latte",active:true}];
const base={productId:id,productReference:"Latte 12 oz",ownerProductQuote:"Latte 12 oz",variantStatus:"unique",amountMode:"increase",increaseCents:10,targetPriceCents:null,ownerAmountQuote:"10 cents",amountStatus:"unique"};
const check=(x:object,text:string)=>validatePriceProposalCandidate({...base,...x},menu,[text]);
describe("structured price candidate",()=>{
 it("accepts a unique explicit increase",()=>expect(check({},"Try Latte 12 oz by 10 cents")).toEqual({productId:id,increaseCents:10}));
 it("rejects alternatives",()=>expect(check({amountStatus:"ambiguous"},"Try Latte 12 oz by 10 or 20 cents")).toBeNull());
 it("rejects target-price confusion",()=>expect(check({amountMode:"target",increaseCents:null,targetPriceCents:700},"Increase Latte 12 oz to 10 cents")).toBeNull());
 it("rejects wrong-size UUID",()=>expect(check({productId:"another"},"Try Latte 12 oz by 10 cents")).toBeNull());
 it("rejects underspecified variants",()=>expect(check({productReference:"Latte",ownerProductQuote:"Latte"},"Increase Latte by 10 cents")).toBeNull());
 it("never authorizes a price amount solely from a generated variant option label",()=>{
   const candidate={...base,productReference:"Latte",ownerProductQuote:"Latte",
     ownerAmountQuote:"12",increaseCents:12};
   // The owner did not request an increase amount; the selected product's
   // generated "12 oz — $5.00" caption is not an owner-authored amount.
   expect(validatePriceProposalCandidate(candidate,menu,["Try raising Latte"],id)).toBeNull();
   expect(validatePriceProposalCandidate({...candidate,ownerAmountQuote:"12 cents"},
     menu,["Try raising Latte by 12 cents"],id))
     .toEqual({productId:id,increaseCents:12});
 });
 it("offers product variants only for unresolved identity with a specified amount",()=>{
   const catalog=menu.map(item=>({...item,priceCents:500}));
   const args={...base,ownerProductQuote:"Latte",productReference:"Latte",
     variantStatus:"ambiguous" as const};
   expect(ambiguousPriceProposalOptions(args,catalog,["Try raising Latte by 10 cents"]))
     .toHaveLength(2);
   expect(ambiguousPriceProposalOptions(args,catalog,["Try raising Latte by 10 cents"],id))
     .toEqual([]);
   expect(ambiguousPriceProposalOptions({...args,variantStatus:"unique",
     amountStatus:"unknown",increaseCents:null},
     catalog,["Try raising Latte"],id)).toEqual([]);
   expect(ambiguousPriceProposalOptions({...args,amountStatus:"unknown",
     increaseCents:null},catalog,["Try raising Latte"])).toEqual([]);
 });
 it("accepts only the owner-selected active variant for an otherwise ambiguous price proposal",()=>{
   const ambiguous={...base,productReference:"Latte",ownerProductQuote:"Latte"};
   expect(validatePriceProposalCandidate(ambiguous,menu,["Raise Latte by 10 cents"],id))
     .toEqual({productId:id,increaseCents:10});
   expect(validatePriceProposalCandidate({...ambiguous,ownerProductQuote:"Latte 12 oz",
     productReference:"Latte 12 oz"},menu,
     ["Raise Latte by 10 cents","Owner clarification: Latte 12 oz"],id))
     .toEqual({productId:id,increaseCents:10});
   expect(validatePriceProposalCandidate({...ambiguous,productId:"another"},menu,
     ["Raise Latte by 10 cents"],id)).toBeNull();
   expect(validatePriceProposalCandidate(ambiguous,menu.map(row=>
     row.id===id?{...row,active:false}:row),["Raise Latte by 10 cents"],id)).toBeNull();
 });
});
