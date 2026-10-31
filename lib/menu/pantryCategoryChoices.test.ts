import {describe,it,expect} from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import ar from "../../messages/ar.json";
import {PANTRY_CATEGORY_CHOICES,pantryCategoryOrOther} from "./pantryCategoryChoices";

const locales={en,es,ar};
describe("shared Pantry category choices and translations",()=>{
 it("preserves canonical milk classification and every existing category option",()=>{
  expect(PANTRY_CATEGORY_CHOICES.map(c=>c.value).sort()).toEqual([
   "bakery","coffee","food","milk","other","packaging","powder","sauce","syrup","tea"
  ].sort());
  for(const choice of PANTRY_CATEGORY_CHOICES){
   expect(pantryCategoryOrOther(choice.value)).toBe(choice.value);
  }
  expect(pantryCategoryOrOther(null)).toBe("other");
 });
 it.each(Object.entries(locales))("every optional category has owner-facing %s text",(_locale,messages)=>{
  for(const choice of PANTRY_CATEGORY_CHOICES){
   const text=messages.MenuBuilder[choice.labelKey];
   expect(typeof text).toBe("string");
   expect(text.trim().length).toBeGreaterThan(0);
  }
 });
});
