import { describe,expect,it } from "vitest";
import { evaluateExpression,EXPRESSION_ID } from "./scenarioExpression";

const scope=(ownerMessage:string)=>({
  businessId:"cafe-a",locationId:null,ownerMessage,currency:"USD" as const,
  bindings:[],operands:[],
});
const plan=(quotedNumber:string,value:number,unit:string)=>({
  capabilityId:EXPRESSION_ID,version:1,purpose:"no_external_sources",
  description:"Owner-stated conditional quantity",nodes:[{
    op:"hypothetical",label:"untrusted model label",quotedNumber,value,unit,
  }],
});
describe("canonical pure scenario arithmetic and locale-safe owner attribution",()=>{
  it("uses Arabic-Indic digits only when the owner stated them",()=>{
    expect(evaluateExpression(plan("٢٥",25,"item"),scope("ماذا لو بعنا ٢٥ كوبًا؟")))
      .toMatchObject({status:"conditional",value:25,unit:"item",executedEffects:0});
    expect(evaluateExpression(plan("٢٥",25,"item"),scope("ماذا لو بعنا ٣٥ كوبًا؟")))
      .toMatchObject({status:"unavailable",reason:"invented_hypothetical"});
  });
  it("accepts Spanish comma decimals while retaining cents",()=>{
    expect(evaluateExpression(plan("12,5",1250,"USD_cents_per_item"),
      scope("¿Y si el precio por bebida es 12,5 dólares?")))
      .toMatchObject({status:"conditional",value:1250,unit:"USD_cents_per_item"});
  });
  it("rejects model unit swaps for the same owner-quoted number",()=>{
    expect(evaluateExpression(plan("45",45,"hour"),
      scope("Sophie works 45 more minutes")))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    expect(evaluateExpression(plan("45",4500,"USD_cents"),
      scope("Sophie works 45 more minutes")))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    expect(evaluateExpression(plan("45",45,"minute"),
      scope("Sophie works 45 more minutes")))
      .toMatchObject({status:"conditional",unit:"minute",value:45});
    expect(evaluateExpression(plan("25",25,"item"),
      scope("Sell 25 more lattes")))
      .toMatchObject({status:"conditional",value:25,unit:"item"});
  });
  it("never upgrades a dollar total to an hourly or per-item rate",()=>{
    expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),
      scope("A total of $20"))).toMatchObject({
        status:"unavailable",reason:"hypothetical_unit_mismatch",
      });
    expect(evaluateExpression(plan("20",2000,"USD_cents_per_item"),
      scope("The total is $20"))).toMatchObject({
        status:"unavailable",reason:"hypothetical_unit_mismatch",
      });
    expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),
      scope("Pay rate $20 per hour"))).toMatchObject({
        status:"conditional",value:2000,unit:"USD_cents_per_hour",
      });
    expect(evaluateExpression(plan("20",2000,"USD_cents_per_item"),
      scope("Price $20 per drink"))).toMatchObject({
        status:"conditional",value:2000,unit:"USD_cents_per_item",
      });
  });
  it("does not borrow a previous amount's rate across a conjunction or comma",()=>{
    for(const words of [
      "Pay rate $20 per hour and a $30 total",
      "Pay rate $20 per hour, a $30 total",
    ]){
      expect(evaluateExpression(plan("30",3000,"USD_cents_per_hour"),scope(words)))
        .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
      expect(evaluateExpression(plan("30",3000,"USD_cents"),scope(words)))
        .toMatchObject({status:"conditional",value:3000,unit:"USD_cents"});
      expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),scope(words)))
        .toMatchObject({status:"conditional",value:2000,unit:"USD_cents_per_hour"});
    }
  });
  it("keeps Arabic attached و$ conjunction rate/total scopes separate",()=>{
    const phrase="الأجر $20 لكل ساعة و$30 إجمالي";
    expect(evaluateExpression(plan("30",3000,"USD_cents_per_hour"),scope(phrase)))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    expect(evaluateExpression(plan("30",3000,"USD_cents"),scope(phrase)))
      .toMatchObject({status:"conditional",value:3000});
    expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),scope(phrase)))
      .toMatchObject({status:"conditional",value:2000});
  });
  it("accepts explicit spelled USD money rates in all supported languages",()=>{
    for(const phrase of [
      "Pay 20 dollars per hour",
      "Pagar 20 dólares por hora",
      "الأجر 20 دولار لكل ساعة",
    ]){
      expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),scope(phrase)))
        .toMatchObject({status:"conditional",value:2000,unit:"USD_cents_per_hour"});
      expect(evaluateExpression(plan("20",2000,"USD_cents"),scope(phrase)))
        .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    }
  });
  it("recognizes explicit scalar multipliers without reinterpreting money or time",()=>{
    expect(evaluateExpression(plan("2",2,"scalar"),
      scope("Multiply the recorded cost by 2")))
      .toMatchObject({status:"conditional",value:2,unit:"scalar"});
    expect(evaluateExpression(plan("2",2,"scalar"),
      scope("Use 2 times the current amount")))
      .toMatchObject({status:"conditional",value:2,unit:"scalar"});
    expect(evaluateExpression(plan("2",2,"scalar"),
      scope("Sophie works 2 hours")))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    expect(evaluateExpression(plan("2",2,"scalar"),
      scope("We sold 2 lattes")))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
  });
  it("rejects euro and pound hypotheticals instead of assuming dollars",()=>{
    expect(evaluateExpression(plan("20",2000,"USD_cents"),
      scope("What is 10% of €20?"))).toMatchObject({
        status:"unavailable",reason:"hypothetical_unit_mismatch",
      });
    expect(evaluateExpression(plan("20",2000,"USD_cents"),
      scope("What is 10% of £20?"))).toMatchObject({
        status:"unavailable",reason:"hypothetical_unit_mismatch",
      });
  });
  it("rejects postfix euro and pound notation without currency conversion",()=>{
    for(const text of ["20€","20 €","20£","20 £"]){
      expect(evaluateExpression(plan("20",2000,"USD_cents"),
        scope("Price is "+text))).toMatchObject({
          status:"unavailable",reason:"hypothetical_unit_mismatch",
        });
      expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),
        scope("Pay rate "+text+" per hour"))).toMatchObject({
          status:"unavailable",reason:"hypothetical_unit_mismatch",
        });
    }
    expect(evaluateExpression(plan("20",2000,"USD_cents"),
      scope("Price is $20"))).toMatchObject({status:"conditional",value:2000});
  });
  it("does not borrow prior hourly qualifiers across Arabic conjunctions",()=>{
    const text="الأجر $20 لكل ساعة و $30 إجمالي";
    expect(evaluateExpression(plan("30",3000,"USD_cents_per_hour"),scope(text)))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    expect(evaluateExpression(plan("30",3000,"USD_cents"),scope(text)))
      .toMatchObject({status:"conditional",value:3000,unit:"USD_cents"});
    expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),scope(text)))
      .toMatchObject({status:"conditional",value:2000,unit:"USD_cents_per_hour"});
  });
  it("denies Canadian and Australian dollar hypotheticals as USD",()=>{
    for(const words of ["Pay CA$20 per hour","Pay A$20 per hour",
      "Pay 20 Canadian dollars per hour","Pay 20 Australian dollars per hour",
      "Pay 20 dólares canadienses por hora"]){
      expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),scope(words)))
        .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    }
    expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),
      scope("Pay $20 per hour"))).toMatchObject({status:"conditional",value:2000});
  });
  it("rejects foreign dollar prefixes and ISO currency codes instead of assuming USD",()=>{
    for(const text of [
      "Pay MX$20 per hour","Pay AR$20 per hour","Pay $20 MXN per hour",
      "Pay $20 ARS per hour","Pay $20 BRL per hour","Pay $20 (CAD) per hour",
      "Pay 20 Mexican pesos per hour","Paga $20 MXN por hora",
      "ادفع $20 MXN لكل ساعة",
    ]){
      expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),
        scope(text))).toMatchObject({status:"unavailable",
          reason:"hypothetical_unit_mismatch"});
    }
    expect(evaluateExpression(plan("20",2000,"USD_cents_per_hour"),
      scope("Pay US$20 per hour"))).toMatchObject({
        status:"conditional",value:2000,unit:"USD_cents_per_hour"});
  });
  it("attributes explicit scalar division in English, Spanish and Arabic",()=>{
    for(const words of ["Divide the recorded cost by 2",
      "Dividir el costo entre 2"]){
      expect(evaluateExpression(plan("2",2,"scalar"),scope(words)))
        .toMatchObject({status:"conditional",value:2,unit:"scalar"});
    }
    expect(evaluateExpression(plan("٢",2,"scalar"),
      scope("اقسم تكلفة المقهى على ٢")))
      .toMatchObject({status:"conditional",value:2,unit:"scalar"});
    expect(evaluateExpression(plan("2",2,"scalar"),
      scope("Two employees each worked 2 hours")))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
  });
  it("disambiguates repeated identical numbers with typed occurrence positions",()=>{
    const message="Sophie works 10 hours at 10 dollars per hour";
    const hours={...plan("10",10,"hour"),nodes:[{
      op:"hypothetical",label:"paid hours",quotedNumber:"10",value:10,
      unit:"hour",occurrence:0,
    }]};
    const rate={...plan("10",1000,"USD_cents_per_hour"),nodes:[{
      op:"hypothetical",label:"hourly pay",quotedNumber:"10",value:1000,
      unit:"USD_cents_per_hour",occurrence:1,
    }]};
    expect(evaluateExpression(hours,scope(message)))
      .toMatchObject({status:"conditional",value:10,unit:"hour"});
    expect(evaluateExpression(rate,scope(message)))
      .toMatchObject({status:"conditional",value:1000,unit:"USD_cents_per_hour"});
    expect(evaluateExpression({...rate,nodes:[{...rate.nodes[0],occurrence:0}]},scope(message)))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    expect(evaluateExpression({...hours,nodes:[{...hours.nodes[0],occurrence:1}]},scope(message)))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    expect(evaluateExpression(plan("10",10,"hour"),scope(message)))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    expect(evaluateExpression({...hours,nodes:[{...hours.nodes[0],occurrence:4}]},scope(message)))
      .toMatchObject({status:"unavailable",reason:"hypothetical_unit_mismatch"});
    const payroll={...hours,nodes:[...hours.nodes,...rate.nodes,{op:"multiply"}]};
    expect(evaluateExpression(payroll,scope(message)))
      .toMatchObject({status:"conditional",value:10000,unit:"USD_cents"});
  });
  it("never attributes partial fragments of Arabic or repeated grouped numbers",()=>{
    const quoted=plan("١",1,"item");
    expect(evaluateExpression(quoted,scope("ماذا عن ١٬٠٠٠ مشروب؟")))
      .toMatchObject({status:"unavailable",reason:"invented_hypothetical"});
    expect(evaluateExpression(plan("٠٠٠",0,"item"),scope("كمية ١٬٠٠٠٬٠٠٠")))
      .toMatchObject({status:"unavailable",reason:"invented_hypothetical"});
    expect(evaluateExpression(plan("١",1,"item"),scope("لو بعت ١ مشروب")))
      .toMatchObject({status:"conditional",value:1});
  });
  it("scales $1.15, 0.29 gallon and 1.15 hours from exact decimal digits",()=>{
    expect(evaluateExpression(plan("1.15",115,"USD_cents"),
      scope("Increase price by $1.15"))).toMatchObject({
        status:"conditional",value:115,unit:"USD_cents",
      });
    const gallon={...plan("0.29",29,"US_gallon"),nodes:[{
      op:"hypothetical",label:"gallons",quotedNumber:"0.29",value:29,
      unit:"US_gallon",quantityScale:"hundredth",
    }]};
    expect(evaluateExpression(gallon,scope("Use 0.29 gallons")))
      .toMatchObject({status:"conditional",value:0.29});
    const hours={...plan("1.15",115,"hour"),nodes:[{
      op:"hypothetical",label:"hours",quotedNumber:"1.15",value:115,
      unit:"hour",quantityScale:"hundredth",
    }]};
    expect(evaluateExpression(hours,scope("Use 1.15 paid hours")))
      .toMatchObject({status:"conditional",value:1.15});
  });
  it("interprets explicitly quoted cents as cents, never as dollars",()=>{
    const cents={...plan("50",50,"USD_cents"),nodes:[{
      op:"hypothetical",quotedNumber:"50",value:50,unit:"USD_cents",
      label:"owner cents",quotedDenomination:"cents",
    }]};
    expect(evaluateExpression(cents,scope("Raise price by 50 cents")))
      .toMatchObject({status:"conditional",value:50,unit:"USD_cents"});
    expect(evaluateExpression(cents,scope("Raise price by 50 dollars")))
      .toMatchObject({status:"unavailable",reason:"denomination_mismatch"});
    expect(evaluateExpression(plan("50",5000,"USD_cents"),scope("Raise price by 50 cents")))
      .toMatchObject({status:"unavailable",reason:"denomination_mismatch"});
  });
  it("retains rational hours and permits percentages of nonmoney quantities",()=>{
    const hours={...plan("1.5",150,"hour"),nodes:[{
      op:"hypothetical",quotedNumber:"1.5",value:150,unit:"hour",
      label:"owner paid hours",quantityScale:"hundredth",
    }]};
    expect(evaluateExpression(hours,scope("Use 1.5 extra hours")))
      .toMatchObject({status:"conditional",value:1.5,unit:"hour"});
    const percent={...plan("40",40,"hour"),nodes:[
      {op:"hypothetical",label:"work hours",quotedNumber:"40",value:40,unit:"hour"},
      {op:"hypothetical",label:"percent reduction",quotedNumber:"10",
        value:1000,unit:"ratio_bps"},{op:"multiply"},
    ]};
    expect(evaluateExpression(percent,scope("Reduce 40 labor hours by 10%")))
      .toMatchObject({status:"conditional",value:4,unit:"hour"});
    const items={...plan("25",25,"item"),nodes:[
      {op:"hypothetical",label:"items",quotedNumber:"25",value:25,unit:"item"},
      {op:"hypothetical",label:"percent",quotedNumber:"10",
        value:1000,unit:"ratio_bps"},{op:"multiply"},
    ]};
    expect(evaluateExpression(items,scope("What is 10% of 25 items?")))
      .toMatchObject({status:"conditional",value:2.5,unit:"item"});
  });
  it("reuses the canonical payroll engine for explicitly quoted loaded labor",()=>{
    const source="Pay $13.50 in wages and 12% employer payroll tax";
    const nodes=[
      {op:"hypothetical",label:"cash wages",quotedNumber:"13.50",
        value:1350,unit:"USD_cents"},
      {op:"hypothetical",label:"stated burden",quotedNumber:"12",
        value:1200,unit:"ratio_bps"},
      {op:"loaded_labor"},
    ];
    expect(evaluateExpression({capabilityId:EXPRESSION_ID,version:1,
      purpose:"no_external_sources",description:"Loaded labor",nodes},scope(source)))
      .toMatchObject({status:"conditional",value:1512,unit:"USD_cents",
        executedEffects:0});
    const falseRate={...nodes[1],value:2000};
    expect(evaluateExpression({capabilityId:EXPRESSION_ID,version:1,
      purpose:"no_external_sources",description:"Forged tax",
      nodes:[nodes[0],falseRate,nodes[2]]},scope(source)))
      .toMatchObject({status:"unavailable",reason:"hypothetical_mismatch"});
    const missingTax="Pay $13.50 in wages";
    expect(evaluateExpression({capabilityId:EXPRESSION_ID,version:1,
      purpose:"no_external_sources",description:"Missing employer rate",nodes},
      scope(missingTax))).toMatchObject({status:"unavailable"});
    expect(evaluateExpression({capabilityId:EXPRESSION_ID,version:1,
      purpose:"no_external_sources",description:"Wrong dimensions",
      nodes:[{...nodes[0],unit:"hour"},nodes[1],nodes[2]]},scope(source)))
      .toMatchObject({status:"unavailable"});
  });
  it("normalizes Arabic decimal separators but rejects ambiguous groupings",()=>{
    expect(evaluateExpression(plan("١٢٫٥",1250,"USD_cents_per_item"),
      scope("سعر الحليب لكل كوب ١٢٫٥ دولار")))
      .toMatchObject({status:"conditional",value:1250});
    expect(evaluateExpression(plan("1,000",100000,"USD_cents_per_item"),
      scope("¿Y si 1,000?"))).toMatchObject({
        status:"unavailable",reason:"invented_hypothetical",
      });
  });
});
