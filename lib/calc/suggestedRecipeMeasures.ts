import type {BaseUnit,OperationalUnit} from "./recipeUnits";

/** Suggestions, not universal calibrations. Only a saved, owner-confirmed
 * ingredient-specific conversion is authoritative for recipe costing. */
export type MeasureSuggestion={baseUnitsPerUnit:number;reference:"moninPump"|"standardPour"|"espressoDose"};
export function suggestedRecipeMeasure(name:string,baseUnit:BaseUnit,unit:OperationalUnit):MeasureSuggestion|null{
 const n=name.toLocaleLowerCase();
 if(unit==="pump"&&baseUnit==="ml"&&/(syrup|sirop|jarabe|شراب)/i.test(n))
  return {baseUnitsPerUnit:7.393375,reference:"moninPump"}; // 1/4 US fluid ounce
 if(unit==="shot"&&baseUnit==="ml")
  return {baseUnitsPerUnit:44.360294,reference:"standardPour"}; // 1.5 US fluid ounces; not espresso dose
 if(unit==="shot"&&baseUnit==="g"&&/(espresso|coffee beans|café espresso|قهوة)/i.test(n))
  return {baseUnitsPerUnit:18,reference:"espressoDose"}; // typical double espresso basket, varies
 return null;
}

/** Typical density for a specifically named ingredient, in grams per milliliter.
 * This is a suggested assumption, never applied to existing stored recipes. */
export function suggestedIngredientDensity(name:string):number|null{
 const normalized=name.toLocaleLowerCase();
 if(/\b(milk|leche|lait)\b|حليب/i.test(normalized))return 1.03;
 if(/\b(heavy cream|whipping cream|crema espesa)\b|كريمة ثقيلة/i.test(normalized))return 0.994;
 return null;
}
