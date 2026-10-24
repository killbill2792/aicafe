import {z} from "zod";
const connection=z.object({locations:z.array(z.object({
 restaurant_guid:z.string().uuid(),location_id:z.string().uuid().optional(),verified_at:z.string().nullable()
}))});
const subscriptions=z.object({subscriptions:z.array(z.object({
 id:z.string().uuid(),enabled:z.boolean(),webhookUrl:z.string().nullable().optional()
}))});
const preferences=z.object({
 preferences:z.array(z.object({kind:z.string(),restaurant_guid:z.string().uuid(),
  enabled:z.boolean(),interval_minutes:z.number(),last_failure_category:z.string().nullable()})),
 recovery:z.array(z.object({restaurant_guid:z.string(),state:z.string(),kind:z.string(),
  missing_since:z.string().nullable().optional(),missing_until:z.string().nullable().optional()})),
 unresolvedCorrections:z.array(z.object({restaurant_guid:z.string(),business_date:z.string()})),
 schedulerActive:z.boolean().optional()
});
export type ToastOwnerSetupStatus=z.infer<typeof preferences>;
export type ToastWebhookSubscription=z.infer<typeof subscriptions>["subscriptions"][number];
export type ToastOwnerSetupSnapshot={
 restaurantGuids:string[];
 locationMappings:{restaurant_guid:string;location_id:string}[];
 subscriptions:ToastWebhookSubscription[];
 status:ToastOwnerSetupStatus;
};
/** Three independent responses, never positional state guessing. Fail closed on any
 * unsuccessful/malformed response; a stale status may not authorize owner actions. */
export async function loadToastOwnerSetupState(
 businessId:string,request:typeof fetch=fetch
):Promise<ToastOwnerSetupSnapshot>{
 const url="?businessId="+encodeURIComponent(businessId);
 const [connectionResponse,subscriptionsResponse,preferencesResponse]=await Promise.all([
  request("/api/pos/toast"+url,{cache:"no-store"}),
  request("/api/pos/toast/webhook/subscriptions"+url,{cache:"no-store"}),
  request("/api/pos/toast/sync-preferences"+url,{cache:"no-store"})
 ]);
 if(!connectionResponse.ok||!subscriptionsResponse.ok||!preferencesResponse.ok)
  throw new Error("Toast setup status unavailable");
 const [connected,webhooks,settings]=await Promise.all([
  connectionResponse.json(),subscriptionsResponse.json(),preferencesResponse.json()
 ]);
 const connections=connection.parse(connected);
 const subs=subscriptions.parse(webhooks);
 const status=preferences.parse(settings);
 return {locationMappings:connections.locations.filter(l=>l.verified_at!==null&&l.location_id)
   .map(l=>({restaurant_guid:l.restaurant_guid,location_id:l.location_id!})),
  restaurantGuids:[...new Set(connections.locations
   .filter(l=>l.verified_at!==null).map(l=>l.restaurant_guid))],
  subscriptions:subs.subscriptions,status};
}
