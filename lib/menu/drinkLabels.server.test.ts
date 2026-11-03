import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const store=vi.hoisted(()=>({menu:vi.fn(),labels:vi.fn(),save:vi.fn()}));
vi.mock("@/lib/data/menuCatalog.server",()=>({readMenuCatalogRows:store.menu}));
vi.mock("@/lib/data/menuCategoryLabels.server",()=>({
 readMenuCategoryLabels:store.labels,saveAiMenuCategoryLabels:store.save}));
import {labelNewMenuCategories} from "./drinkLabels.server";

const db={} as SupabaseClient;
const item=(name:string,category:string)=>({id:name,name,base_name:null,category});
beforeEach(()=>{
 vi.clearAllMocks();
 store.menu.mockResolvedValue([item("Adeni Tea","Traditional"),item("Jubani","Traditional"),
  item("Samosa","Food"),item("Latte","ESPRESSO_DRINK"),item("Mango Matcha","Matcha")]);
 store.labels.mockResolvedValue(new Map([["Matcha",true]]));
 store.save.mockResolvedValue(undefined);
});
describe("AI labels a café's own menu categories once",()=>{
 it("asks only about new café categories, with example items, and saves the answers",async()=>{
  const classify=vi.fn(async()=>[{category:"Traditional",isDrink:true},{category:"Food",isDrink:false}]);
  expect(await labelNewMenuCategories(db,"cafe-1",classify)).toBe(2);
  expect(classify).toHaveBeenCalledWith([{category:"Traditional",items:["Adeni Tea","Jubani"]},
   {category:"Food",items:["Samosa"]}]);
  expect(store.save).toHaveBeenCalledWith(db,"cafe-1",[{category:"Traditional",isDrink:true},
   {category:"Food",isDrink:false}]);
 });
 it("makes no AI call when every category is already labeled",async()=>{
  store.labels.mockResolvedValue(new Map([["Matcha",true],["Traditional",true],["Food",false]]));
  const classify=vi.fn();
  expect(await labelNewMenuCategories(db,"cafe-1",classify)).toBe(0);
  expect(classify).not.toHaveBeenCalled();
  expect(store.save).not.toHaveBeenCalled();
 });
 it("ignores answers about categories it did not ask about",async()=>{
  const classify=vi.fn(async()=>[{category:"Traditional",isDrink:true},{category:"Invented",isDrink:true}]);
  await labelNewMenuCategories(db,"cafe-1",classify);
  expect(store.save).toHaveBeenCalledWith(db,"cafe-1",[{category:"Traditional",isDrink:true}]);
 });
 it("never throws when the AI call fails, and saves nothing",async()=>{
  const classify=vi.fn(async()=>{throw new Error("timeout");});
  expect(await labelNewMenuCategories(db,"cafe-1",classify)).toBe(0);
  expect(store.save).not.toHaveBeenCalled();
 });
});
