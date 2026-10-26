import {parseOwnerDecimal} from "@/lib/calc/localeDecimal";
import {toCents} from "@/lib/pos/csv/csvUtils";

type Locale="en"|"es"|"ar";
export function parseOwnerPurchaseNumbers(raw:{quantity:string;cost:string},locale:Locale):
 {numbers:{quantity:number;costCents:number|null}|null;error:"invalid_quantity"|"invalid_cost"|null}{
 const quantity=parseOwnerDecimal(raw.quantity,locale);
 if(quantity===null||quantity<=0)return {numbers:null,error:"invalid_quantity"};
 const costText=raw.cost.trim();
 const costValue=costText?parseOwnerDecimal(costText,locale):null;
 const costCents=costValue===null?null:toCents(String(costValue));
 if(costText&&(costValue===null||!Number.isSafeInteger(costCents)))
  return {numbers:null,error:"invalid_cost"};
 return {numbers:{quantity,costCents},error:null};
}
