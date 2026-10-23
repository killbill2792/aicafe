/** Pure, canonical-unit (g/ml/each) usage math. Unknown is null, never zero. */
export type UsageIngredient={id:string;name:string;unit:"g"|"ml"|"each"};
export type UsageRecipe={menuItemId:string;ingredientId:string;quantity:number};
export type UsageModifier={posModifierId:string;ingredientId:string|null;quantityDelta:number;replacesIngredientId:string|null};
export type UsageSale={menuItemId:string|null;quantity:number;businessDate:string;closedAt:string;modifiers:Array<{posModifierId:string;name:string}>};
export type UsageStaff={id:string;staffId:string;staff:string;clockIn:string;clockOut:string|null};
export type UsageCount={ingredientId:string;date:string;quantity:number};
export type UsagePurchase={ingredientId:string;date:string;quantity:number};
export type UsageGroupBy="day"|"shift"|"staff"|null;
export type UsageRow={
 ingredientId:string;name:string;unit:UsageIngredient["unit"];
 expected:number|null;actual:number|null;differencePct:number|null;
 status:"on_target"|"watch"|"over"|null;missing:string[];
 groups:Array<{key:string;label:string;staff:string[];expected:number;actual:null;expectedOnly:true}>;
};
export function previousDate(iso:string){const d=new Date(iso+"T12:00:00Z");d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);}
export function usageStatus(pct:number|null):UsageRow["status"] {
 if(pct===null)return null;
 if(pct>10)return "over";
 if(Math.abs(pct)<=5)return "on_target";
 return "watch"; // includes unexpected under-use; do not label it over-use
}
export function calculateUsage(input:{
 ingredients:UsageIngredient[];recipes:UsageRecipe[];modifiers:UsageModifier[];
 sales:UsageSale[];salesCovered:boolean;counts:UsageCount[];purchases:UsagePurchase[];
 from:string;to:string;staff?:UsageStaff[];groupBy?:UsageGroupBy;
}):UsageRow[]{
 const recipes=new Map<string,UsageRecipe[]>();
 for(const r of input.recipes){const v=recipes.get(r.menuItemId)??[];v.push(r);recipes.set(r.menuItemId,v);}
 const mods=new Map(input.modifiers.map(m=>[m.posModifierId,m]));
 const totals=new Map<string,number>(),groups=new Map<string,Map<string,{label:string;staff:string[];expected:number}>>();
 let salesMissing=false;
 const staff=input.staff??[];
 const add=(id:string,amount:number,key:string,label:string,onDuty:string[])=>{
  totals.set(id,(totals.get(id)??0)+amount);
  const byKey=groups.get(id)??new Map();
  const item=byKey.get(key)??{label,staff:onDuty,expected:0};
  item.expected+=amount;byKey.set(key,item);groups.set(id,byKey);
 };
 for(const sale of input.sales){
  if(!Number.isFinite(sale.quantity)||sale.quantity<=0||!sale.menuItemId||!recipes.has(sale.menuItemId)){
   salesMissing=true;continue;
  }
  const lineTotals=new Map<string,number>();
  for(const r of recipes.get(sale.menuItemId)!)lineTotals.set(r.ingredientId,(lineTotals.get(r.ingredientId)??0)+r.quantity);
  for(const modifier of sale.modifiers){
   // Unmapped options are not silently treated as zero consumption.
   const m=mods.get(modifier.posModifierId);
   if(!m){salesMissing=true;continue;}
   if(m.replacesIngredientId)lineTotals.delete(m.replacesIngredientId);
   if(m.ingredientId)lineTotals.set(m.ingredientId,(lineTotals.get(m.ingredientId)??0)+m.quantityDelta);
  }
  const clocked=staff.filter(s=>Date.parse(s.clockIn)<=Date.parse(sale.closedAt) &&
   (s.clockOut===null||Date.parse(sale.closedAt)<Date.parse(s.clockOut)));
  const crew=clocked.map(s=>s.staff).sort();
  const staffIds=clocked.map(s=>s.staffId).sort();
  for(const [id,qty] of lineTotals){
   if(!Number.isFinite(qty)||qty<0){salesMissing=true;continue;}
   let key="all",label="All";
   if(input.groupBy==="day"){key=sale.businessDate;label=key;}
   if(input.groupBy==="shift"){key=staffIds.join("|")||"unassigned";label=crew.join(", ")||"No matched Toast time entry";}
   if(input.groupBy==="staff"){ // Shared expected usage, not proof who prepared the sale.
    const members=clocked.length?clocked:[{staffId:"unassigned",staff:"No matched Toast time entry"}];
    for(const s of members)add(id,qty*sale.quantity/members.length,s.staffId,s.staff,[s.staff]);
    continue;
   }
   add(id,qty*sale.quantity,key,label,crew);
  }
 }
 const fromPrevious=previousDate(input.from);
 return input.ingredients.map(i=>{
  const missing:string[]=[];
  const start=input.counts.find(c=>c.ingredientId===i.id&&c.date===fromPrevious);
  const end=input.counts.find(c=>c.ingredientId===i.id&&c.date===input.to);
  if(!start)missing.push("startCount:"+fromPrevious);
  if(!end)missing.push("endCount:"+input.to);
  if(!input.salesCovered)missing.push("toastSalesCoverage");
  if(salesMissing)missing.push("unlinkedSalesRecipeOrModifier");
  const expected=input.salesCovered&&!salesMissing?Math.max(0,totals.get(i.id)??0):null;
  const added=input.purchases.filter(p=>p.ingredientId===i.id&&p.date>=input.from&&p.date<=input.to)
   .reduce((sum,p)=>sum+p.quantity,0);
  const actual=start&&end?start.quantity+added-end.quantity:null;
  if(actual!==null&&actual<0)missing.push("negativeStockReconciliation");
  const validActual=actual!==null&&actual>=0?actual:null;
  const differencePct=expected!==null&&expected>0&&validActual!==null
   ?Math.round((validActual-expected)/expected*10000)/100:null;
  return {
   ingredientId:i.id,name:i.name,unit:i.unit,expected,actual:validActual,differencePct,
   status:usageStatus(differencePct),missing,
   groups:[...(groups.get(i.id)??new Map()).entries()].map(([key,g])=>({key,label:g.label,
     staff:g.staff,expected:g.expected,actual:null as null,expectedOnly:true as const}))
     .sort((a,b)=>a.key.localeCompare(b.key)),
  };
 });
}
