import {describe,it,expect} from "vitest";
import {verifiedRecommendedPriceInReply,forcedPricingClarifyText} from "./pricingReply";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
describe("localized trusted pricing reply",()=>{
 it("forces clarification text from localized price and note keys",()=>{
  for(const [locale,copy] of [["en",en.SupervisorChat],["es",es.SupervisorChat],["ar",ar.SupervisorChat]] as const){
   const note=copy.pricingNoteDrinkCost.replace("{percent}","30");
   expect(forcedPricingClarifyText(500,locale,note)).toContain(note);
   expect(forcedPricingClarifyText(500,locale,null)).toContain(copy.pricingNoteIncomplete);
  }
 });
 it("matches Spanish and Arabic prices with or without currency",()=>{
  expect(verifiedRecommendedPriceInReply("Precio recomendado: 5,25 US$",525,"es",[])).toBe(true);
  expect(verifiedRecommendedPriceInReply("Precio: 5,25",525,"es",[])).toBe(true);
  const ar=new Intl.NumberFormat("ar",{minimumFractionDigits:2,maximumFractionDigits:2}).format(5.25);
  expect(verifiedRecommendedPriceInReply("السعر "+ar,525,"ar",[])).toBe(true);
  expect(verifiedRecommendedPriceInReply("New drink: $5.25",525,"en",[])).toBe(true);
 });
 it("never accepts a suffix inside a different price or rejected evidence span",()=>{
  expect(verifiedRecommendedPriceInReply("New drink: $15.25",525,"en",[])).toBe(false);
  expect(verifiedRecommendedPriceInReply("New drink: 5.250",525,"en",[])).toBe(false);
  expect(verifiedRecommendedPriceInReply("Precio 15,25 US$",525,"es",[])).toBe(false);
  expect(verifiedRecommendedPriceInReply("Precio 5,25",525,"es",[{start:7,end:11}])).toBe(false);
 });
});
