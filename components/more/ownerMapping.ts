import {z} from "zod";
const GUID=z.uuid();
const employee=z.object({
 action:z.literal("link_employee"),businessId:GUID,restaurantGuid:GUID,
 employeeGuid:GUID,canonicalEmployeeId:GUID,confirmLink:z.literal(true)
}).strict();
const catalog=z.object({
 action:z.literal("link_catalog"),businessId:GUID,restaurantGuid:GUID,
 kind:z.enum(["item","modifier"]),providerGuid:GUID,
 canonicalId:GUID,confirmLink:z.literal(true)
}).strict();
export type OwnerToastLinkRequest=z.infer<typeof employee>|z.infer<typeof catalog>;
/** Only an explicit selection AND reviewed confirmation can form a link request.
 * No match by name, default choice, unknown wage, or provider price auto-promotion. */
export function approvedToastLink(
 scope:{businessId:string;restaurantGuid:string},
 source:{kind:"employee"|"item"|"modifier";guid:string},
 selectedCanonicalId:string,confirmed:boolean
):OwnerToastLinkRequest {
 if(!confirmed||!selectedCanonicalId)throw new Error("Explicit owner mapping approval required");
 if(source.kind==="employee")return employee.parse({
  action:"link_employee",...scope,employeeGuid:source.guid,
  canonicalEmployeeId:selectedCanonicalId,confirmLink:true
 });
 return catalog.parse({
  action:"link_catalog",...scope,kind:source.kind,
  providerGuid:source.guid,canonicalId:selectedCanonicalId,confirmLink:true
 });
}
