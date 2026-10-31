import {packBaseQuantity,type BaseUnit} from "@/lib/calc/recipeUnits";

export type PurchasePack={packQuantity:number;packUnit:string};

/** Accept café purchase labels without adding another persisted quantity system.
 * 12 × 32 fluid ounces is saved as 384 fl_oz by the existing pantry action. */
export function parsePurchasePack(text:string,baseUnit:BaseUnit):PurchasePack|null{
 const cleaned=text.normalize("NFKC").toLowerCase()
  .replace(/[٠-٩۰-۹]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)>=0?"٠١٢٣٤٥٦٧٨٩".indexOf(d):"۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
  .replace(/onzas?\s+l[ií]quidas?|أونص(?:ة|ات)\s+سائلة/g,"fluid ounces")
  .replace(/onzas?\s+de\s+peso|أونص(?:ة|ات)\s+بالوزن/g,"ounces by weight")
  .replace(/libras?|أرطال|رطلاً|رطلًا|رطل/g,"pounds")
  .replace(/unidades?|piezas?|قطعة|قطع|وحدات?|وحدة/g,"pieces")
  .replace(/mililitros?|مليلتر(?:ات)?|ملليلتر(?:ات)?/g,"milliliters")
  .replace(/litros?|لترات?|لتر/g,"liters")
  .replace(/gramos?|غرام(?:ات|ًا)?|جرام(?:ات)?/g,"grams")
  .replace(/kilogramos?|كيلوغرام(?:ات)?/g,"kilograms")
  .replace(/\s+/g," ").replace(/\s+(?:cans?|bottles?|cartons?|jugs?|bags?|boxes?)$/,"");
 const match=/^(?:(\d+(?:\.\d+)?)\s*(?:x|×)\s*)?(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s+ounces?|ounces?\s+by\s+weight|oz\s+weight|oz|ounces?|ml|millilit(?:er|re)s?|g|grams?|kg|kilograms?|lb|lbs|pounds?|l|lit(?:er|re)s?|gal|gallons?|qt|quarts?|each|pieces?|dozen|case\([1-9]\d*\))$/i.exec(cleaned);
 if(!match)return null;
 const count=match[1]?Number(match[1]):1,amount=Number(match[2]);
 const unit=match[3].replace(/\s+/g," ");
 let packUnit:string;
 if(/^fl|^fluid/.test(unit))packUnit="fl_oz";
 else if(unit==="oz weight"||unit.includes("by weight"))packUnit="oz_wt";
 else if(unit==="oz"||unit.startsWith("ounce"))packUnit=baseUnit==="ml"?"fl_oz":"oz_wt";
 else if(unit==="ml"||unit.startsWith("millil"))packUnit="ml";
 else if(unit==="g"||unit.startsWith("gram"))packUnit="g";
 else if(unit==="kg"||unit.startsWith("kilo"))packUnit="kg";
 else if(unit==="lb"||unit==="lbs"||unit.startsWith("pound"))packUnit="lb";
 else if(unit==="l"||unit.startsWith("lit"))packUnit="l";
 else if(unit==="gal"||unit.startsWith("gallon"))packUnit="gal";
 else if(unit==="qt"||unit.startsWith("quart"))packUnit="qt";
 else if(unit==="dozen")packUnit="dozen";
 else if(/^case\([1-9]\d*\)$/.test(unit))packUnit=unit;
 else packUnit="each";
 const packQuantity=count*amount;
 return Number.isFinite(packQuantity)&&packBaseQuantity(packQuantity,packUnit,baseUnit)!==null?{packQuantity,packUnit}:null;
}

/** Editable values keep an ungrouped decimal (e.g. 1000.5), while the localized unit is
 * derived from Intl's unit part. Thus changing only a price never invalidates a saved pack. */
export function purchasePackLabel(quantity:number|null,unit:string|null,baseUnit:BaseUnit,locale="en"):string{
 if(quantity===null||!unit)return "";
 const unitNames:Record<string,string>={fl_oz:"fluid-ounce",oz_wt:"ounce",ml:"milliliter",g:"gram",
  kg:"kilogram",l:"liter",lb:"pound",gal:"gallon"};
 const resolvedUnit=unit==="oz"?(baseUnit==="ml"?"fl_oz":"oz_wt"):unit;
 const value=String(quantity);
 if(unitNames[resolvedUnit]){
  const format=new Intl.NumberFormat(locale,{style:"unit",unit:unitNames[resolvedUnit],unitDisplay:"long",maximumFractionDigits:15});
  const unitLabel=format.formatToParts(quantity).find(part=>part.type==="unit")?.value??resolvedUnit;
  const suffix=resolvedUnit==="oz_wt"?(locale.startsWith("es")?" de peso":locale.startsWith("ar")?" بالوزن":" by weight"):"";
  return value+" "+unitLabel+suffix;
 }
 const other:Record<string,string>={qt:"quarts",each:locale.startsWith("es")?"unidades":locale.startsWith("ar")?"قطعة":"pieces",dozen:"dozen"};
 // A pre-existing case(N) quantity remains case(N), not silently converted to each.
 return value+" "+(other[resolvedUnit]??resolvedUnit);
}
