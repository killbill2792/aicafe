import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {configuredSupervisorModel} from "@/lib/ai/conversations/modelConfig";
import {responseOutputText} from "@/lib/events/nearbyEvents";
import {readMenuCatalogRows} from "@/lib/data/menuCatalog.server";
import {readMenuCategoryLabels,saveAiMenuCategoryLabels} from "@/lib/data/menuCategoryLabels.server";
import {APP_MENU_DRINK_CATEGORIES,APP_MENU_OTHER_CATEGORIES} from "@/lib/whatsapp/morningBrief";

/** Each café names its own menu categories in Toast ("Traditional", "FALL DRINKS",
 * "Food" …) and Toast has no drink flag. The model labels each new category once
 * from its name and a few item names; the label is saved and reused. */
const MAX_CATEGORIES=40,ITEMS_PER_CATEGORY=6,TIMEOUT_MS=15_000,MAX_OUTPUT_TOKENS=1200;
const schema={type:"object",additionalProperties:false,required:["labels"],properties:{
 labels:{type:"array",items:{type:"object",additionalProperties:false,
  required:["category","is_drink"],
  properties:{category:{type:"string"},is_drink:{type:"boolean"}}}}}} as const;
const answer=z.object({labels:z.array(z.object({category:z.string(),is_drink:z.boolean()}))});
const SYSTEM="You label a café's own menu categories. For each category, decide whether "+
 "its items are drinks (any beverage: coffee, tea, matcha, juice, smoothie, soda, "+
 "refresher, seasonal or specialty drink) or not (food, pastry, snacks, retail, "+
 "merchandise, add-ons). Use the category name and its example items. Return every "+
 "category exactly as written.";

export type CategoryInput={category:string;items:string[]};
export type DrinkClassifier=(categories:readonly CategoryInput[])=>
 Promise<{category:string;isDrink:boolean}[]>;

/** One strict-JSON call to the main Supervisor model. */
export const classifyWithOpenAi:DrinkClassifier=async categories=>{
 const apiKey=process.env.OPENAI_API_KEY;
 if(!apiKey)throw new Error("openai_unavailable");
 const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",
  signal:AbortSignal.timeout(TIMEOUT_MS),
  headers:{Authorization:"Bearer "+apiKey,"Content-Type":"application/json"},
  body:JSON.stringify({model:configuredSupervisorModel(),max_output_tokens:MAX_OUTPUT_TOKENS,
   store:false,input:[{role:"system",content:SYSTEM},
    {role:"user",content:JSON.stringify({categories})}],
   text:{format:{type:"json_schema",name:"drink_labels",strict:true,schema}}})});
 if(!response.ok)throw new Error("openai_http_"+response.status);
 const text=responseOutputText(await response.json());
 if(!text)throw new Error("openai_empty");
 const parsed=answer.parse(JSON.parse(text));
 return parsed.labels.map(l=>({category:l.category,isDrink:l.is_drink}));
};

/** Labels the café's not-yet-labeled categories and saves them. Never throws:
 * a failure only means those items are left out of today's top drink. */
export async function labelNewMenuCategories(db:SupabaseClient,businessId:string,
 classify:DrinkClassifier=classifyWithOpenAi):Promise<number>{
 const started=Date.now();
 let asked=0,saved=0,outcome="none";
 try{
  const [menu,known]=await Promise.all([readMenuCatalogRows(db,businessId),
   readMenuCategoryLabels(db,businessId)]);
  const byCategory=new Map<string,string[]>();
  for(const item of menu){
   const category=item.category?.trim();
   if(!category||known.has(category)||APP_MENU_DRINK_CATEGORIES.has(category)||
    APP_MENU_OTHER_CATEGORIES.has(category))continue;
   const items=byCategory.get(category)??[];
   const name=(item.base_name?.trim()||item.name).slice(0,80);
   if(items.length<ITEMS_PER_CATEGORY&&!items.includes(name))items.push(name);
   byCategory.set(category,items);
  }
  const input=[...byCategory].slice(0,MAX_CATEGORIES).map(([category,items])=>({category,items}));
  asked=input.length;
  if(!asked)return 0;
  const wanted=new Set(input.map(c=>c.category));
  // Keep only answers for categories we asked about; ignore anything else.
  const labels=(await classify(input)).filter(l=>wanted.has(l.category));
  await saveAiMenuCategoryLabels(db,businessId,labels);
  saved=labels.length;outcome="saved";
  return saved;
 }catch{
  outcome="failed";
  return 0;
 }finally{
  // Counts only: never category names, items or prompt text.
  if(asked||outcome==="failed")console.info("menu_category_labels",
   {asked,saved,outcome,durationMs:Date.now()-started});
 }
}
