import {describe,it,expect,vi} from "vitest";
import {canStartToastImport,canRepullToastDay,commitToastOwnerAction,queueToastBackfillChunks,PartialToastQueueError} from "./toastOwnerActionState";
describe("owner sees only actionable Toast import controls",()=>{
 it("setup enabled without auto-import does not allow the owner to launch a dead-end import",()=>{
  expect(canStartToastImport(false,false,"2026-10-01","2026-10-23")).toBe(false);
  expect(canRepullToastDay(false,false,"2026-10-01","2026-10-23",[])).toBe(false);
 });
 it("import activated permits yesterday but rejects today and partial invalid dates",()=>{
  expect(canStartToastImport(true,false,"2026-10-23","2026-10-23")).toBe(true);
  expect(canStartToastImport(true,false,"2026-10-24","2026-10-23")).toBe(false);
  expect(canStartToastImport(true,false,"","2026-10-23")).toBe(false);
  expect(canStartToastImport(true,false,"2015-12-01","2026-10-23")).toBe(false);
  expect(canRepullToastDay(true,false,"2026-10-23","2026-10-23",[])).toBe(true);
  expect(canRepullToastDay(true,false,"2026-10-24","2026-10-23",[])).toBe(false);
 });
 it("disables queued or in-flight submissions without blocking other days",()=>{
  const ranges=[{from:"2026-10-10",to:"2026-10-20"}];
  expect(canRepullToastDay(true,false,"2026-10-16","2026-10-23",ranges)).toBe(false);
  expect(canRepullToastDay(true,false,"2026-10-21","2026-10-23",ranges)).toBe(true);
  expect(canRepullToastDay(true,true,"2026-10-21","2026-10-23",ranges)).toBe(false);
  expect(canStartToastImport(true,true,"2026-10-01","2026-10-23")).toBe(false);
 });
});

describe("a status read cannot turn a committed Toast action into a false failure",()=>{
 it("reports the saved action as committed even if status temporarily fails",async()=>{
  const write=vi.fn().mockResolvedValue(undefined);
  const refresh=vi.fn().mockRejectedValue(new Error("status offline"));
  expect(await commitToastOwnerAction(write,refresh))
   .toEqual({refreshAvailable:false});
  expect(write).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
 });
 it("never claims a failed write was saved or refreshes from it",async()=>{
  const write=vi.fn().mockRejectedValue(new Error("save rejected"));
  const refresh=vi.fn();
  await expect(commitToastOwnerAction(write,refresh)).rejects.toThrow("save rejected");
  expect(refresh).not.toHaveBeenCalled();
 });
});

const addDay=(d:string,n:number)=>new Date(Date.parse(d+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
describe("backfill chunks across real calendar and month boundaries",()=>{
 it("queues at most 400 days in each request, with no date gaps",async()=>{
  const queue=vi.fn().mockResolvedValue(undefined);
  const end=addDay("2024-01-01",800);
  expect(await queueToastBackfillChunks("2024-01-01",end,queue,addDay)).toBe(3);
  expect(queue.mock.calls).toEqual([
   ["2024-01-01",addDay("2024-01-01",399)],
   [addDay("2024-01-01",400),addDay("2024-01-01",799)],
   [end,end]
  ]);
 });
 it("identifies the first unqueued date after a later request fails",async()=>{
  const queue=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"));
  try{
   await queueToastBackfillChunks("2024-01-01",addDay("2024-01-01",800),queue,addDay);
   throw new Error("expected a partial failure");
  }catch(error){
   expect(error).toBeInstanceOf(PartialToastQueueError);
   expect((error as PartialToastQueueError).queuedChunks).toBe(1);
   expect((error as PartialToastQueueError).resumeFrom).toBe(addDay("2024-01-01",400));
  }
 });
});
