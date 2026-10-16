import { normalizeScenarioNumber,type Operand } from "@/lib/calc/scenarioExpression";

type Unit=Operand["unit"];
type Locale="en"|"es"|"ar";
const localeId:Record<Locale,string>={en:"en-US",es:"es-ES",ar:"ar"};
const suffix:Record<Locale,Record<Exclude<Unit,
  "USD_cents"|"comparison"|"scalar"|"ratio_bps">,string>>={
  en:{USD_cents_per_item:"per item",USD_cents_per_hour:"per hour",
    USD_cents_per_US_gallon:"per US gallon",USD_cents_per_US_fl_oz:"per US fl oz",
    item:"items",minute:"minutes",hour:"hours",US_gallon:"US gallons",
    US_fl_oz:"US fl oz"},
  es:{USD_cents_per_item:"por unidad",USD_cents_per_hour:"por hora",
    USD_cents_per_US_gallon:"por galón estadounidense",
    USD_cents_per_US_fl_oz:"por onza líquida estadounidense",
    item:"unidades",minute:"minutos",hour:"horas",US_gallon:"galones estadounidenses",
    US_fl_oz:"onzas líquidas estadounidenses"},
  ar:{USD_cents_per_item:"لكل وحدة",USD_cents_per_hour:"لكل ساعة",
    USD_cents_per_US_gallon:"لكل غالون أمريكي",
    USD_cents_per_US_fl_oz:"لكل أونصة سائلة أمريكية",
    item:"وحدات",minute:"دقائق",hour:"ساعات",US_gallon:"غالونات أمريكية",
    US_fl_oz:"أونصات سائلة أمريكية"},
};
export function formatScenarioValue(value:number,unit:Unit,locale:Locale,
  quotedOwnerNumber=false):string{
  const language=localeId[locale];
  const number=(v:number)=>new Intl.NumberFormat(language,{maximumFractionDigits:2}).format(v);
  if(unit==="comparison")return value===0?
    {en:"equal",es:"iguales",ar:"متساويان"}[locale]:
    value>0?{en:"greater",es:"mayor",ar:"أكبر"}[locale]:
    {en:"less",es:"menor",ar:"أصغر"}[locale];
  if(unit==="ratio_bps")return number(quotedOwnerNumber?value:value/100)+"%";
  const monetary=unit.startsWith("USD_");
  const amount=monetary&&!quotedOwnerNumber?value/100:value;
  const shown=monetary?
    new Intl.NumberFormat(language,{style:"currency",currency:"USD",
      minimumFractionDigits:2,maximumFractionDigits:2}).format(amount):number(amount);
  if(unit==="USD_cents"||unit==="scalar")return shown;
  return shown+" "+suffix[locale][unit as Exclude<Unit,
    "USD_cents"|"comparison"|"scalar"|"ratio_bps">];
}
export function formatScenarioAssumption(raw:string,locale:Locale):string{
  const split=raw.lastIndexOf(" ");
  if(split<1)return "";
  const quoted=raw.slice(0,split),unit=raw.slice(split+1) as Unit|"cents";
  const value=Number(normalizeScenarioNumber(quoted));
  if(unit==="cents")
    return Number.isFinite(value)?formatScenarioValue(value,"USD_cents",locale):"";
  const validUnits:readonly string[]=["USD_cents","USD_cents_per_item",
    "USD_cents_per_hour","USD_cents_per_US_gallon","USD_cents_per_US_fl_oz",
    "item","minute","hour","US_gallon","US_fl_oz","scalar","ratio_bps","comparison"];
  return validUnits.includes(unit)&&Number.isFinite(value)?
    formatScenarioValue(value,unit,locale,true):"";
}

/** Display only translated, trusted operation names, never internal RPN tags. */
export function formatScenarioFormula(step:string,locale:"en"|"es"|"ar"):string{
  const operations={
    en:{source:"recorded input",convert:"unit conversion",
      owner_hypothetical:"owner assumption",add:"plus",subtract:"minus",
      scenario_delta:"scenario difference",multiply:"times",divide:"divided by",
      ratio:"percentage comparison",compare:"comparison"},
    es:{source:"dato registrado",convert:"conversión de unidades",
      owner_hypothetical:"supuesto del propietario",add:"más",subtract:"menos",
      scenario_delta:"diferencia entre escenarios",multiply:"multiplicado por",
      divide:"dividido entre",ratio:"comparación porcentual",compare:"comparación"},
    ar:{source:"بيانات مسجلة",convert:"تحويل الوحدات",
      owner_hypothetical:"افتراض المالك",add:"جمع",subtract:"طرح",
      scenario_delta:"فرق السيناريوهات",multiply:"ضرب",divide:"قسمة",
      ratio:"مقارنة النسب",compare:"مقارنة"},
  };
  const id=step.startsWith("source(")?"source":
    step.startsWith("convert(")?"convert":step;
  return operations[locale][id as keyof typeof operations["en"]]??{
    en:"calculation",es:"حساب".replace("حساب","cálculo"),ar:"حساب",
  }[locale];
}
