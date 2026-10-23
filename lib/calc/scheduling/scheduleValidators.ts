import {z} from "zod";
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const availabilityDay=z.strictObject({
 day:z.number().int().min(0).max(6),
 start:time.nullable(),end:time.nullable()
}).refine(d=>(d.start===null)===(d.end===null),"Both times must be specified")
 .refine(d=>d.start===null||d.start!==d.end,"Nonzero window required");
export const personFields=z.strictObject({
 name:z.string().trim().min(1).max(80),
 role:z.string().trim().max(60).nullable(),
 wageCents:z.number().int().positive().nullable(),
 availability:z.array(availabilityDay).max(7).refine(days=>
  new Set(days.map(d=>d.day)).size===days.length,"Repeated day"),
 minWeeklyMinutes:z.number().int().min(0).max(10080).nullable(),
 maxWeeklyMinutes:z.number().int().min(0).max(10080).nullable(),
 phone:z.string().regex(/^\+[1-9]\d{1,14}$/).nullable()
}).refine(p=>p.minWeeklyMinutes===null||p.maxWeeklyMinutes===null||
  p.minWeeklyMinutes<=p.maxWeeklyMinutes,"Invalid weekly range");


export const updatePersonFields=z.strictObject({id:z.string().uuid(),...personFields.shape});
export const restoreShiftInput=z.strictObject({id:z.string().uuid()});
export const setPersonActiveInput=z.strictObject({id:z.string().uuid(),active:z.boolean()});
export const shiftInput=z.strictObject({
 id:z.string().uuid().optional(),employeeId:z.string().uuid(),date:z.iso.date(),
 start:time,end:time,breakMinutes:z.number().int().min(0).max(240).optional(),
 repeatWeekly:z.boolean().optional()
});
