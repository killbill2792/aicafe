import type {PantryCategory} from "./pantryStarter";

/** Optional Pantry classification shared by inline creation and editing.
 * Classification is business data: the existing milk add-on reader depends on
 * category === "milk", not an ingredient-name heuristic. */
export const PANTRY_CATEGORY_CHOICES:readonly {value:PantryCategory;labelKey:"other"|"milk"|"coffee"|"syrups"|"sauce"|"powder"|"tea"|"packaging"|"bakery"|"food"}[]=[
 {value:"other",labelKey:"other"},
 {value:"milk",labelKey:"milk"},
 {value:"coffee",labelKey:"coffee"},
 {value:"syrup",labelKey:"syrups"},
 {value:"sauce",labelKey:"sauce"},
 {value:"powder",labelKey:"powder"},
 {value:"tea",labelKey:"tea"},
 {value:"packaging",labelKey:"packaging"},
 {value:"bakery",labelKey:"bakery"},
 {value:"food",labelKey:"food"},
];
export function pantryCategoryOrOther(input:string|null):PantryCategory{
 return PANTRY_CATEGORY_CHOICES.find(c=>c.value===input)?.value??"other";
}
