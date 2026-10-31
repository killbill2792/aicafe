import {describe,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import type {MenuItemForEdit} from "@/lib/data/getMenuItemsForEdit";
import {toBaseUnitQuantity} from "@/lib/calc/recipeUnits";
import AllSizesRecipe from "./AllSizesRecipe";

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
