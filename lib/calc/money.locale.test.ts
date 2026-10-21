import {it,expect} from "vitest";
import {formatCents} from "./money";
it("formats both prices in Spanish and Arabic",()=>{
 for(const locale of ["es","ar"]){
  for(const cents of [525,535]){
   expect(formatCents(cents,locale)).toBe(new Intl.NumberFormat(locale,{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:2}).format(cents/100));
  }
 }
});
