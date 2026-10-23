/**
 * Pure copy-only preview. This module has no delivery transport and never
 * reports a message as sent. Sort and bound data deterministically.
 */
export type ScheduleCopyPerson={id:string;name:string;phone:string|null};
export type ScheduleCopyShift={employeeId:string;date:string;start:string;end:string};
export function prepareScheduleCopy(
  people:readonly ScheduleCopyPerson[],
  shifts:readonly ScheduleCopyShift[]
):Array<{name:string;phone:string|null;text:string}>{
  return people.flatMap(person=>{
    const rows=shifts.filter(s=>s.employeeId===person.id)
      .sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
    if(!rows.length)return [];
    return [{name:person.name,phone:person.phone,
      text:person.name+" — "+rows.map(s=>s.date+" "+s.start+"–"+s.end).join("; ")}];
  });
}
