import {describe,it,expect} from "vitest";
import {formatCafeCurrency} from "./cafeCurrency";

describe("business-currency display",()=>{
 it("uses each café's real currency and owner language",()=>{
  for(const locale of ["en","es","ar"]){
   const euro=formatCafeCurrency(41230,locale,"EUR");
   const yen=formatCafeCurrency(41230,locale,"JPY");
   expect(euro).toEqual({text:new Intl.NumberFormat(locale,{style:"currency",currency:"EUR"}).format(412.30),
    currencyMissing:false});
   expect(yen).toEqual({text:new Intl.NumberFormat(locale,{style:"currency",currency:"JPY"}).format(412.30),
    currencyMissing:false});
   expect(euro.text).not.toContain("US$");
  }
 });
 it("does not mislabel unknown currencies as USD",()=>{
  for(const currency of [null,undefined,"", "BAD-CODE"]){
   const result=formatCafeCurrency(41230,"en",currency);
   expect(result).toEqual({text:"412.30",currencyMissing:true});
   expect(result.text).not.toContain("$");
  }
 });
});
