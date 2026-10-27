import {describe,it,expect} from "vitest";
import {matchCatalogItem,type CanonicalMenuCandidate} from "./catalogMatching";
import type {PosCatalogItem} from "./types";

const café="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const id=(guid:string)=>"toast:"+café+":"+guid;
const latte=id("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const item=(over:Partial<PosCatalogItem>={}):PosCatalogItem=>({
 posItemId:latte,name:"Latte",baseName:"Latte",sizeLabel:null,
 priceCents:450,category:"Coffee",...over
}) as PosCatalogItem;
const candidate=(over:Partial<CanonicalMenuCandidate>={}):CanonicalMenuCandidate=>({
 id:"row-1",name:"Latte",baseName:"Latte",sizeLabel:null,
 priceCents:450,category:"Coffee",posItemId:null,catalogSource:"manual",
 ...over
});
describe("provider catalog matching identities",()=>{
 it("prefers exact immutable variation/GUID over conflicting display fields",()=>{
  const a=candidate({posItemId:latte,name:"Owner rename",priceCents:650});
  const result=matchCatalogItem(item(),[a,candidate({id:"row-2"})]);
  expect(result).toMatchObject({status:"matched",candidateId:"row-1",score:1});
 });
 it("links unique owner item only when name, size and price agree",()=>{
  expect(matchCatalogItem(item(),[candidate()])).toMatchObject({status:"matched",candidateId:"row-1"});
  expect(matchCatalogItem(item(),[candidate({priceCents:500})])).toMatchObject({
   status:"needs_review",candidateId:"row-1"});
 });
 it("two same-name owner candidates always need review, never a duplicate",()=>{
  expect(matchCatalogItem(item(),[candidate(),candidate({id:"row-2"})])).toMatchObject({
   status:"needs_review",candidateId:null});
 });
 it("links CSV median-priced rows even when the published provider price changed",()=>{
  expect(matchCatalogItem(item({priceCents:550}),[
   candidate({posItemId:"csv-item-latte",catalogSource:"csv",priceCents:500})
  ])).toMatchObject({status:"matched",candidateId:"row-1"});
 });
 it("refuses to steal the same name from an existing different POS",()=>{
  expect(matchCatalogItem(item(),[candidate({
   posItemId:"square:variation-7",catalogSource:"square"
  })])).toMatchObject({status:"needs_review",candidateId:"row-1"});
 });
 it("treats each size as a distinct canonical row",()=>{
  const medium=id("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")+":size:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const choice=item({posItemId:medium,name:"Latte - Medium",sizeLabel:"Medium",priceCents:500});
  expect(matchCatalogItem(choice,[
   candidate({sizeLabel:"Small",priceCents:400}),
   candidate({id:"medium-row",sizeLabel:"Medium",priceCents:500})
  ])).toMatchObject({status:"matched",candidateId:"medium-row"});
 });
 it("open-price items do not automatically claim unknown-priced manual items",()=>{
  expect(matchCatalogItem(item({priceCents:null}),[
   candidate({priceCents:null})
  ])).toMatchObject({status:"needs_review"});
 });
 it("brand new menu silently returns new when no candidates",()=>{
  expect(matchCatalogItem(item(),[])).toMatchObject({status:"new",candidateId:null});
 });
});
