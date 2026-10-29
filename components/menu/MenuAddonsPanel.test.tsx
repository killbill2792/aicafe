import {describe,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import type {MenuItemForEdit} from "@/lib/data/getMenuItemsForEdit";
import MenuAddonsPanel from "./MenuAddonsPanel";
vi.mock("next-intl",()=>({useTranslations:()=>((key:string)=>key)}));
vi.mock("@/i18n/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock("@/lib/actions/menuAddons",()=>({saveMenuProductAddons:vi.fn()}));
const items=["8oz","12oz","16oz"].map((sizeLabel,index)=>({
  id:"s"+index,name:"Latte "+sizeLabel,baseName:"Latte",sizeLabel,active:true,
  recipe:[{ingredientId:"whole",baseUnit:"ml",quantity:[120,180,240][index],
    displayUnit:"ml",displayQuantity:[120,180,240][index]}],
})) as unknown as MenuItemForEdit[];
describe("MenuAddonsPanel",()=>{
  it("shows every 8/12/16 oz milk delta, suggested upcharge and margin",()=>{
    const html=renderToStaticMarkup(<MenuAddonsPanel itemId="s0" items={items}
      pantry={[
        {id:"whole",name:"Whole milk",category:"milk",baseUnit:"ml",costPerBaseMicros:100000},
        {id:"oat",name:"Oat milk",category:"milk",baseUnit:"ml",costPerBaseMicros:200000},
      ]} saved={[]} conversions={{}}/>);
    for(const size of ["8oz","12oz","16oz"])expect(html).toContain(`data-size-label="${size}"`);
    expect(html).toContain("modifierSuggestedUpcharge");
    expect(html).toContain("modifierMarginKept");
  });
  it("retains each size as unknown when its recipe volume is absent",()=>{
    const missing=items.map((item,i)=>i===2?{...item,recipe:[]}:item) as MenuItemForEdit[];
    const html=renderToStaticMarkup(<MenuAddonsPanel itemId="s0" items={missing}
      pantry={[{id:"whole",name:"Whole milk",category:"milk",baseUnit:"ml",costPerBaseMicros:100000},
        {id:"oat",name:"Oat milk",category:"milk",baseUnit:"ml",costPerBaseMicros:null}]}
      saved={[]} conversions={{}}/>);
    expect(html).toContain("modifierMilkCostMissing");
    expect(html).toContain("modifierMilkVolumeMissing");
    expect(html).not.toContain("milk_cost:oat");
    expect(html).not.toContain("milk_ml:16oz");
  });
});
