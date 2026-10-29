import {describe,it,expect} from "vitest";
import {verifiedRecommendedPriceInReply} from "./pricingReply";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
describe("localized trusted pricing reply",()=>{
 it("matches Spanish and Arabic prices with or without currency",()=>{
  expect(verifiedRecommendedPriceInReply("Precio recomendado: 5,25 US$",525,"es",[],"USD")).toBe(true);
  expect(verifiedRecommendedPriceInReply("Precio: 5,25",525,"es",[],"USD")).toBe(true);
  const ar=new Intl.NumberFormat("ar",{minimumFractionDigits:2,maximumFractionDigits:2}).format(5.25);
  expect(verifiedRecommendedPriceInReply("السعر "+ar,525,"ar",[],"USD")).toBe(true);
  expect(verifiedRecommendedPriceInReply("New drink: $5.25",525,"en",[],"USD")).toBe(true);
 });
 it("never accepts a suffix inside a different price or rejected evidence span",()=>{
  expect(verifiedRecommendedPriceInReply("New drink: $15.25",525,"en",[],"USD")).toBe(false);
  expect(verifiedRecommendedPriceInReply("New drink: 5.250",525,"en",[],"USD")).toBe(false);
  expect(verifiedRecommendedPriceInReply("Precio 15,25 US$",525,"es",[],"USD")).toBe(false);
  expect(verifiedRecommendedPriceInReply("Precio 5,25",525,"es",[{start:7,end:11}],"USD")).toBe(false);
 });
});
