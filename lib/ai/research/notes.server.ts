import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {SavedFact} from "@/lib/ownerFacts/inject";
import type {ResearchScope} from "./tools.server";

const day=(iso:string)=>iso.slice(0,10);

/** What Supervisor knows about the café outside the database tables: its own notes and the owner's saved facts,
 * each with where it came from and how old it is, so a stale one gets rechecked. Read with the owner's session (RLS). */
export type CafeNote={topic:string;note:string;basis:string;created_at:string;confirmed_at:string};

/** The one reader of active café notes (oldest first, all of them); chat and the notes screen both use it. */
export async function readCafeNotes(client:SupabaseClient,businessId:string):Promise<{notes:CafeNote[];error:boolean}>{
  const {data,error}=await client.from("cafe_notes").select("topic,note,basis,created_at,confirmed_at")
    .eq("business_id",businessId).is("retired_at",null).order("created_at",{ascending:true});
  return {notes:error||!data?[]:data as CafeNote[],error:Boolean(error)};
}

export async function cafeNotesContext(client:SupabaseClient,businessId:string,facts:readonly SavedFact[],today:string,observePrivate?:(values:unknown[])=>void):Promise<string>{
  const {notes,error}=await readCafeNotes(client,businessId);
  observePrivate?.([...notes.flatMap(n=>[n.note,n.basis]),...facts.map(f=>f.value_json)]);
  const lines=[
    ...notes.map(n=>"- note "+n.topic+": "+n.note+" (learned from: "+n.basis+"; last confirmed "+day(n.confirmed_at)+")"),
    ...facts.map(f=>"- owner fact "+f.fact_key+": "+JSON.stringify(f.value_json)+(f.unit?" "+f.unit:"")+" (the owner saved this on "+day(f.created_at)+")"),
  ];
  return "Café notes and saved facts (today is "+today+"; hints only, live data wins):"+(lines.length?"\n"+lines.join("\n"):" none yet.")+(error?"\n(notes could not be read this turn)":"");
}

/** Saves with the owner's own session, so the database checks membership; nothing is written with the service key. */
export function cafeNotesPort(client:SupabaseClient,businessId:string):NonNullable<ResearchScope["notes"]>{
  return {
    async save(topic,note,basis){
      const {error}=await client.rpc("save_cafe_note",{p_business_id:businessId,p_topic:topic,p_note:note,p_basis:basis});
      if(error)throw new Error(error.message.includes("cafe_notes_full")?"café notes are full; forget an old one first":"note could not be saved");
    },
    async forget(topic){
      const {data,error}=await client.rpc("forget_cafe_note",{p_business_id:businessId,p_topic:topic});
      if(error)throw new Error("note could not be forgotten");
      return data===true;
    },
  };
}
