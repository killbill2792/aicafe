import {describe,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import NewPantryInlineRow from "./NewPantryInlineRow";
import InlinePantryTable from "./InlinePantryTable";
import MenuAddonsPanel from "./MenuAddonsPanel";
import type {MenuItemForEdit} from "@/lib/data/getMenuItemsForEdit";
import {PANTRY_CATEGORY_CHOICES,pantryCategoryOrOther} from "@/lib/menu/pantryCategoryChoices";

vi.mock("next-intl",()=>({useLocale:()=> "en",useTranslations:()=>((key:string)=>key)}));
vi.mock("@/i18n/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock("@/lib/actions/pantry",()=>({createPantryIngredient:vi.fn(),savePackPrice:vi.fn(),updatePantryIngredient:vi.fn(),setPantryArchived:vi.fn()}));
vi.mock("@/lib/actions/menuAddons",()=>({saveMenuProductAddons:vi.fn()}));

const labels=new Proxy({} as Record<string,string>,{get:(_target,key)=>String(key)});
const newMilk={id:"milk-new",name:"New Oat Milk",category:"milk",baseUnit:"ml" as const,
 archivedAt:null,packQuantity:null,packUnit:null,packCostCents:null,
 originalPack:null,costPerBaseMicros:100000};

describe("Pantry category → milk add-ons owner journey",()=>{
 it("provides an optional localized category on both inline creation surfaces",()=>{
  const form=renderToStaticMarkup(<NewPantryInlineRow onCancel={()=>{}}/>);
  expect(form).toContain('value="other"'); // default; category never required
  expect(form).toContain('value="milk"');
  expect(form).toContain("category");
  expect(PANTRY_CATEGORY_CHOICES.map(item=>item.value)).toContain("milk");
  expect(pantryCategoryOrOther("milk")).toBe("milk");
  expect(pantryCategoryOrOther(null)).toBe("other");
  expect(pantryCategoryOrOther("sauce")).toBe("sauce");
 });
 it("allows correcting an existing ingredient's category independently of its price",()=>{
  const old={...newMilk,category:"other"};
  const html=renderToStaticMarkup(<InlinePantryTable items={[old]} t={labels}/>);
  expect(html).toContain('aria-label="category: New Oat Milk"');
  expect(html).toContain('value="milk"');
  expect(html).toContain('value="other"');
  expect(html).toContain('value="other" selected');
  const classified=renderToStaticMarkup(<InlinePantryTable items={[newMilk]} t={labels}/>);
  expect(classified).toContain('value="milk" selected');
 });
 it("a correctly classified new milk remains eligible for default/alternative milk add-ons",()=>{
  const items=[{id:"size-12",name:"Latte 12 oz",baseName:"Latte",active:true,
   recipe:[{ingredientId:newMilk.id,ingredientName:newMilk.name,baseUnit:"ml",
     quantity:180,displayUnit:"ml",displayQuantity:180}]}] as unknown as MenuItemForEdit[];
  const html=renderToStaticMarkup(<MenuAddonsPanel itemId="size-12" items={items}
   pantry={[newMilk,{...newMilk,id:"milk-alt",name:"Almond milk"}]} saved={[]} conversions={{}}/>);
  expect(html).toContain("New Oat Milk");
  expect(html).toContain("Almond milk");
  expect(html).toContain("modifierSuggestedUpcharge");
 });
});
