import "server-only";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
/** Only controlled topic keys arrive here; idempotent suggestion, never publishes. */
export async function createHomeCardSuggestion(topic:string,userId:string){
 const {error}=await createAdminSupabaseClient().from("admin_home_card_suggestions")
  .upsert({topic,requested_by:userId,status:"suggested"},
    {onConflict:"topic",ignoreDuplicates:true});
 if(error)throw error;
}
