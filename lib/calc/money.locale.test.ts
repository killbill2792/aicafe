import {it,expect} from "vitest";
import {formatCents} from "./money";
it("formats both prices in Spanish and Arabic",()=>{
 for(const locale of ["es","ar"]){
  for(const cents of [525,535]){
   expect(formatCents(cents,locale,"USD")).toBe(new Intl.NumberFormat(locale,{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:2}).format(cents/100));
  }
 }
 expect(formatCents(525,"en-US","EUR")).toBe(new Intl.NumberFormat("en-US",{style:"currency",currency:"EUR"}).format(5.25));
 expect(formatCents(525,"en-US")).toBe("5.25");
});
