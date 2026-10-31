import {describe,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import type {MenuItemForEdit} from "@/lib/data/getMenuItemsForEdit";
import {toBaseUnitQuantity} from "@/lib/calc/recipeUnits";
import AllSizesRecipe, {safeRecipeDensity,preservedReplacementQuantity,nextReplacementDisplayQuantity} from "./AllSizesRecipe";

vi.mock("next-intl",()=>({
 useLocale:()=> "en",
 useTranslations:()=>((key:string,params?:Record<string,string>)=>
  params?.name ? key+" "+params.name : key),
}));
vi.mock("@/i18n/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock("@/lib/actions/pantry",()=>({
 saveProductRecipes:vi.fn(),createPantryIngredient:vi.fn(),swapIngredient:vi.fn(),
}));
vi.mock("@/lib/actions/ingredientUnitConversions",()=>({setIngredientUnitConversion:vi.fn()}));
vi.mock("@/lib/actions/menuItems",()=>({
 updateMenuItemPrice:vi.fn(),setMenuItemActive:vi.fn(),
}));
vi.mock("./AddSizeDialog",()=>({default:()=>null}));

const items=[{
 id:"12",name:"Vanilla latte 12 oz",baseName:"Vanilla latte",sizeLabel:"12 oz",active:true,
 category:"drink",priceCents:650,
 recipe:[
  {ingredientId:"vanilla",ingredientName:"Vanilla syrup",baseUnit:"ml",
   quantity:22.17,displayQuantity:3,displayUnit:"pump",costCents:42},
  {ingredientId:"milk",ingredientName:"Whole milk",baseUnit:"ml",
   quantity:180,displayQuantity:180,displayUnit:"ml",costCents:30},
 ],
},{
 id:"16",name:"Vanilla latte 16 oz",baseName:"Vanilla latte",sizeLabel:"16 oz",active:true,
 category:"drink",priceCents:750,
 recipe:[{ingredientId:"vanilla",ingredientName:"Vanilla syrup",baseUnit:"ml",
  quantity:29.56,displayQuantity:4,displayUnit:"pump",costCents:56}],
}] as unknown as MenuItemForEdit[];

function render(){
 return renderToStaticMarkup(<AllSizesRecipe items={items}
  ingredients={[{id:"vanilla",name:"Vanilla syrup",baseUnit:"ml"},
   {id:"milk",name:"Whole milk",baseUnit:"ml"}]}
  conversions={{vanilla:[{unit:"pump",baseUnitsPerUnit:7.39}]}}
  pantry={[{id:"vanilla",name:"Vanilla syrup",baseUnit:"ml",category:"syrup",costPerBaseMicros:200000},
   {id:"milk",name:"Whole milk",baseUnit:"ml",category:"milk",costPerBaseMicros:100000}]}
  draftSizes={[]}/>);
}

describe("inline product recipe",()=>{
 it("keeps existing size-specific values editable, with units beside inputs and no steppers",()=>{
  const html=render();
  expect(html).toContain("type=\"number\"");
  expect(html).toContain("value=\"3\"");
  expect(html).not.toContain("value=\"4\""); // Only the focused size is editable.
  expect(html).toContain("recipeUnitPump");
  expect(html).toContain("recipeUnitFlOz");
  expect(html).not.toContain("decreaseQuantity");
  expect(html).not.toContain("increaseQuantity");
  expect(html).not.toContain("showUnitMath");
 });
 it("makes the top recipe-row and new-pantry actions distinct and adds per-row controls",()=>{
  const html=render();
  expect(html).toContain("addRecipeRow");
  expect(html).toContain("addPantryItem");
  expect(html).toContain('aria-label="addRecipeRowAfter Vanilla syrup"');
  expect(html).toContain('aria-label="addRecipeRowAfter Whole milk"');
  expect(html).toContain("saveItem");
  expect(html).toContain("sizesSell");
 });
 it("uses the existing canonical unit conversion rather than a screen-only calculator",()=>{
  expect(toBaseUnitQuantity("pump",3,"ml",[{unit:"pump",baseUnitsPerUnit:7.39}]))
   .toBeCloseTo(22.17,6);
  expect(toBaseUnitQuantity("fl_oz",1,"ml",[])).toBeCloseTo(29.5735,4);
  expect(toBaseUnitQuantity("g",120,"ml",[])).toBeNull();
 });
});

describe("cross-unit ingredient swaps",()=>{
 it("requires density from the selected replacement, not the old recipe ingredient",()=>{
  // A 103 g / 100 ml milk recipe must not become a water recipe with milk's 1.03 density.
  expect(safeRecipeDensity(true,undefined,1.03,1.03)).toBeUndefined();
  expect(safeRecipeDensity(true,"",1.03,1.03)).toBeUndefined();
  expect(safeRecipeDensity(true,"1",1.03,1.03)).toBe(1);
  expect(safeRecipeDensity(true,"0",1.03,1.03)).toBeUndefined();
  expect(safeRecipeDensity(false,undefined,1.03,1)).toBe(1.03);
 });
});

describe("replacement ingredient calibration parity",()=>{
 it("preserves 30 ml when swapping a 10 ml-pump syrup for a 5 ml-pump syrup",()=>{
  const old=[{unit:"pump" as const,baseUnitsPerUnit:10}];
  const replacement=[{unit:"pump" as const,baseUnitsPerUnit:5}];
  const amount=preservedReplacementQuantity("pump",3,"ml",old,replacement);
  expect(amount).toBe(6);
  // The canonical writer now resolves the replacement to 30 ml, not 15 ml.
  expect(toBaseUnitQuantity("pump",amount!,"ml",replacement)).toBe(30);
  // Undoing the replacement must use the current syrup B calibration as source.
  const reverted=preservedReplacementQuantity("pump",amount!,"ml",replacement,old);
  expect(reverted).toBe(3);
  expect(toBaseUnitQuantity("pump",reverted!,"ml",old)).toBe(30);
  // Exercise the picker adapter rather than only the lower-level helper:
  // previousId B and targetId A must still trigger the conversion.
  const first=nextReplacementDisplayQuantity("syrup-a","syrup-b","pump",3,"ml",old,replacement);
  expect(first).toBe(6);
  const back=nextReplacementDisplayQuantity("syrup-b","syrup-a","pump",first!,"ml",replacement,old);
  expect(back).toBe(3);
  expect(nextReplacementDisplayQuantity("syrup-a","syrup-a","pump",3,"ml",old,old)).toBe(3);
  expect(preservedReplacementQuantity("pump",3,"ml",old,[])).toBeNull();
 });
});
