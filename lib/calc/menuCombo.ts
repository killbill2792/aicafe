export type ComboComponentCost={quantity:number;priceCents:number;costCents:number|null};
export type ComboTotals={soldSeparatelyCents:number;comboPriceCents:number;savesCustomerCents:number;costCents:number|null;keepCents:number|null;keepPercent:number|null;separateKeepCents:number|null;separateKeepPercent:number|null};
export function calculateComboTotals(parts:readonly ComboComponentCost[],priceCents:number):ComboTotals{
 if(!Number.isSafeInteger(priceCents)||priceCents<=0)throw new RangeError("Invalid combo price");
 let retail=0,cost=0,known=true;
 for(const p of parts){
  if(!Number.isSafeInteger(p.quantity)||p.quantity<1||p.quantity>100||!Number.isSafeInteger(p.priceCents)||p.priceCents<=0)throw new RangeError("Invalid combo component");
  retail+=p.quantity*p.priceCents;
  if(p.costCents===null)known=false;
  else if(!Number.isFinite(p.costCents)||p.costCents<0)throw new RangeError("Invalid cost");
  else cost+=p.quantity*p.costCents;
 }
 const costCents=known?Math.round(cost):null;
 const keepCents=costCents===null?null:priceCents-costCents;
 const separateKeepCents=costCents===null?null:retail-costCents;
 return{soldSeparatelyCents:retail,comboPriceCents:priceCents,savesCustomerCents:retail-priceCents,costCents,keepCents,
  keepPercent:keepCents===null?null:Math.round(keepCents*100/priceCents),
  separateKeepCents,separateKeepPercent:separateKeepCents===null||retail===0?null:Math.round(separateKeepCents*100/retail)};
}
export function suggestComboPrices(retailCents:number):number[]{
 if(!Number.isSafeInteger(retailCents)||retailCents<=0)return[];
 const base=Math.round((retailCents*0.85)/25)*25;
 return[base,base+25,base+50].filter(p=>p>0&&p<=retailCents);
}
