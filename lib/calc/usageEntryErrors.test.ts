import {describe,it,expect} from "vitest";
import {usageEntryErrorKey} from "./usageEntryErrors";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
describe("owner-facing Pantry stock errors",()=>{
 it("maps invalid input, wrong units, inaccessible ingredients, and storage errors",()=>{
  expect(usageEntryErrorKey("invalid_quantity")).toBe("usageErrorInvalidQuantity");
  expect(usageEntryErrorKey("invalid_unit")).toBe("usageErrorInvalidUnit");
  expect(usageEntryErrorKey("ingredient_not_found")).toBe("usageErrorIngredientNotFound");
  expect(usageEntryErrorKey("save_failed")).toBe("usageErrorSaveFailed");
  expect(usageEntryErrorKey("new_server_error")).toBe("usageErrorSaveFailed");
 });
 it("renders a translated, actionable message in en, es, and ar instead of raw error codes",()=>{
  const errors=["invalid_quantity","invalid_unit","ingredient_not_found","save_failed","unrecognized_error"];
  for(const dict of [en,es,ar]){
   for(const error of errors){
    const key=usageEntryErrorKey(error);
    const message=Object.entries(dict.MenuBuilder).find(([name])=>name===key)?.[1];
    expect(message).toBeTruthy();
    expect(message).not.toBe(error);
    expect(message).not.toMatch(/(?:invalid_quantity|invalid_unit|save_failed|ingredient_not_found)/);
   }
  }
 });
});
