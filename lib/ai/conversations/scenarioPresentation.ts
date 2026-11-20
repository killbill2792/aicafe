import {z} from "zod";
import {figure,simulateEconomics,type Economics,type ScenarioDelta} from "@/lib/calc/supervisorEconomics";

const cents=z.number().int().min(0).max(100_000_000_000);
const signedMoney=z.number().int().min(-100_000_000).max(100_000_000);
const rate=z.number().finite().min(0).max(1);
const units=z.number().finite().min(0).max(1_000_000);
const deltaSchema=z.discriminatedUnion("kind",[
 z.strictObject({kind:z.literal("bill"),monthlyChangeCents:signedMoney}),
 z.strictObject({kind:z.literal("price"),oldPriceCents:cents,newPriceCents:cents.min(1),weeklyUnits:units,unitCostCents:cents.nullable()}),
 z.strictObject({kind:z.literal("item_cost"),oldCostCents:cents,newCostCents:cents,weeklyUnits:units,currentPriceCents:cents}),
 z.strictObject({kind:z.literal("shift"),hoursChange:z.number().min(-24).max(24),wageCents:cents,payrollTaxRate:rate,shiftsPerWeek:z.number().int().min(1).max(7)}),
 z.strictObject({kind:z.literal("wage"),weeklyHours:z.number().min(0).max(168),oldWageCents:cents,newWageCents:cents,payrollTaxRate:rate}),
 z.strictObject({kind:z.literal("drinks"),changePercent:z.number().min(-100).max(1000)}),
 z.strictObject({kind:z.literal("margin"),targetMargin:z.number().min(0).max(.8)}),
]);
const basisSchema=z.strictObject({monthlyBillsCents:cents,monthlyStaffCents:cents,monthlyRevenueCents:cents,
 ingredientRate:rate,feeRate:rate,daysInMonth:z.number().int().min(1).max(31),targetMargin:rate});
const seedSchema=z.strictObject({basis:basisSchema,delta:deltaSchema});
export type ScenarioEditorSeed=z.infer<typeof seedSchema>;
export const scenarioEditorSchema=seedSchema.extend({
 metric:z.enum(["monthlyProfitCents","monthlyTargetSalesCents","itemMarginCents"]),
});
export type ScenarioEditor=z.infer<typeof scenarioEditorSchema>;

/** Only aggregate inputs required by the selected model are retained. No
 * staff/item IDs, raw labor, orders, customer records or payment plans. The
 * exact observed-day break-even engine is deliberately not approximated here. */
export function captureScenarioBasis(e:Economics,delta:ScenarioDelta):ScenarioEditorSeed|null{
 const safeDelta=delta.kind==="price"||delta.kind==="item_cost"?Object.fromEntries(Object.entries(delta).filter(([k])=>k!=="itemId")):delta;
 const parsed=seedSchema.safeParse({basis:{monthlyBillsCents:e.monthlyBills.valueCents,monthlyStaffCents:e.monthlyStaff.valueCents,
  monthlyRevenueCents:e.monthlyRevenue.valueCents,ingredientRate:e.ingredientRate,feeRate:e.feeRate,daysInMonth:e.daysInMonth,targetMargin:e.targetMargin},delta:safeDelta});
 return parsed.success?parsed.data:null;
}
type EditField={key:string;label:string;value:number;money?:boolean;percent?:boolean};
export function scenarioEditFields(editor:ScenarioEditor):EditField[]{
 const d=editor.delta;
 switch(d.kind){
  case "bill":return [{key:"monthlyChangeCents",label:"Monthly bill change",value:d.monthlyChangeCents/100,money:true}];
  case "price":return [{key:"newPriceCents",label:"New selling price",value:d.newPriceCents/100,money:true},{key:"weeklyUnits",label:"Assumed units per week",value:d.weeklyUnits}];
  case "item_cost":return [{key:"newCostCents",label:"New ingredient cost",value:d.newCostCents/100,money:true},{key:"weeklyUnits",label:"Assumed units per week",value:d.weeklyUnits}];
  case "shift":return [{key:"hoursChange",label:"Hours change per shift",value:d.hoursChange},{key:"shiftsPerWeek",label:"Shifts per week",value:d.shiftsPerWeek}];
  case "wage":return [{key:"newWageCents",label:"New hourly wage",value:d.newWageCents/100,money:true}];
  case "drinks":return [{key:"changePercent",label:"Sales volume change",value:d.changePercent,percent:true}];
  case "margin":return [{key:"targetMargin",label:"Target margin",value:d.targetMargin*100,percent:true}];
 }
}
export function evaluateScenarioEditor(editor:ScenarioEditor,changes:Readonly<Record<string,string>>={}):{beforeCents:number;afterCents:number}|null{
 const basis=editor.basis;
 const next:Record<string,unknown>={...editor.delta};
 for(const f of scenarioEditFields(editor)){
  if(!Object.hasOwn(changes,f.key))continue;
  const v=changes[f.key];
  if(!/^-?\d{1,9}(?:\.\d{1,4})?$/.test(v))return null;
  const n=Number(v);
  if(f.money&&Math.abs(n*100-Math.round(n*100))>1e-7)return null;
  next[f.key]=f.money?Math.round(n*100):f.key==="targetMargin"?n/100:n;
 }
 const parsed=deltaSchema.safeParse(next);
 if(!parsed.success)return null;
 const d=parsed.data;
 const delta:ScenarioDelta=d.kind==="price"||d.kind==="item_cost"?{...d,itemId:""}:d;
 const e:Economics={monthlyBills:figure(basis.monthlyBillsCents,"estimate","Saved scenario"),monthlyStaff:figure(basis.monthlyStaffCents,"estimate","Saved scenario"),
  monthlyRevenue:figure(basis.monthlyRevenueCents,"estimate","Saved scenario"),ingredientRate:basis.ingredientRate,feeRate:basis.feeRate,
  ingredientStatus:"estimate",feeStatus:"estimate",averagePriceCents:null,monthlyUnits:null,daysInMonth:basis.daysInMonth,targetMargin:basis.targetMargin,missingDays:[]};
 try{
  const result=simulateEconomics(e,delta);
  const before=result.before[editor.metric],after=result.after[editor.metric];
  return before!==null&&after!==null&&Number.isSafeInteger(before)&&Number.isSafeInteger(after)?{beforeCents:before,afterCents:after}:null;
 }catch{return null}
}
