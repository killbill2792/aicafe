/** Resolve provider IDs to the separately priced model family, including snapshots. */
export function modelFamily(id) {
 const model=typeof id==="string"?id.trim().toLowerCase():"";
 const match=/^gpt-6(?:\.\d+)?-(luna|sol|astra)(?:-\d{4}-\d{2}-\d{2})?$/.exec(model);
 return match?"gpt-6-"+match[1]:null;
}
