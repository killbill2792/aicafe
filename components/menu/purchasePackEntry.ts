import {packBaseQuantity,type BaseUnit} from "@/lib/calc/recipeUnits";

export type PurchasePack={packQuantity:number;packUnit:string};

/** Accept café purchase labels without adding another persisted quantity system.
 * 12 × 32 fluid ounces is saved as 384 fl_oz by the existing pantry action. */
export function parsePurchasePack(text:string,baseUnit:BaseUnit):PurchasePack|null{
 const cleaned=text.normalize("NFKC").toLowerCase()
  .replace(/[٠-٩۰-۹]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)>=0?"٠١٢٣٤٥٦٧٨٩".indexOf(d):"۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
  .replace(/onzas?\s+l[ií]quidas?|أونص(?:ة|ات)\s+سائلة/g,"fluid ounces")
  .replace(/onzas?\s+de\s+peso/g,"ounces by weight")
  .replace(/libras?|أرطال|رطلاً|رطلًا|رطل/g,"pounds")
  .replace(/unidades?|piezas?|قطع|قطعة|وحدات?|وحدة/g,"pieces")
  .replace(/mililitros?|مليلتر(?:ات)?|ملليلتر(?:ات)?/g,"milliliters")
  .replace(/litros?|لترات?|لتر/g,"liters")
  .replace(/gramos?|غرام(?:ات|ًا)?|جرام(?:ات)?/g,"grams")
  .replace(/kilogramos?|كيلوغرام(?:ات)?/g,"kilograms")
  .replace(/\s+/g," ").replace(/\s+(?:cans?|bottles?|cartons?|jugs?|bags?|boxes?)$/,"");
 const match=/^(?:(\d+(?:\.\d+)?)\s*(?:x|×)\s*)?(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s+ounces?|ounces?\s+by\s+weight|oz\s+weight|oz|ounces?|ml|millilit(?:er|re)s?|g|grams?|kg|kilograms?|lb|lbs|pounds?|l|lit(?:er|re)s?|gal|gallons?|qt|quarts?|each|pieces?|dozen)$/i.exec(cleaned);
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
 else packUnit="each";
 const packQuantity=count*amount;
 return Number.isFinite(packQuantity)&&packBaseQuantity(packQuantity,packUnit,baseUnit)!==null?{packQuantity,packUnit}:null;
}

export function purchasePackLabel(quantity:number|null,unit:string|null,baseUnit:BaseUnit,locale="en"):string{
 if(quantity===null||!unit)return "";
 const unitNames:Record<string,string>={fl_oz:"fluid-ounce",oz_wt:"ounce",ml:"milliliter",g:"gram",
  kg:"kilogram",l:"liter",lb:"pound",gal:"gallon"};
 const resolvedUnit=unit==="oz"?(baseUnit==="ml"?"fl_oz":"oz_wt"):unit;
 if(unitNames[resolvedUnit]){
  return new Intl.NumberFormat(locale,{style:"unit",unit:unitNames[resolvedUnit],unitDisplay:"long"}).format(quantity);
 }
 const other:Record<string,string>={qt:"quarts",each:"pieces",dozen:"dozen"};
 return new Intl.NumberFormat(locale).format(quantity)+" "+(other[resolvedUnit]??resolvedUnit);
}
