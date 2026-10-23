"use server";
import {revalidatePath} from "next/cache";
import * as staffData from "@/lib/data/staffSchedule.server";
export async function getWeekSchedule(raw:unknown){
  const result=await staffData.getWeekSchedule(raw);
  return result;
}
export async function getCoverageGaps(raw:unknown){
  const result=await staffData.getCoverageGaps(raw);
  return result;
}
export async function getTeam(raw:unknown){
  const result=await staffData.getTeam(raw);
  return result;
}
export async function getShiftCost(raw:unknown){
  const result=await staffData.getShiftCost(raw);
  return result;
}
export async function upsertShift(raw:unknown){
  const result=await staffData.upsertShift(raw);
  if(result.ok){revalidatePath("/staff");}
  return result;
}
export async function removeShift(raw:unknown){
  const result=await staffData.removeShift(raw);
  if(result.ok){revalidatePath("/staff");}
  return result;
}
export async function restoreShift(raw:unknown){
  const result=await staffData.restoreShift(raw);
  if(result.ok){revalidatePath("/staff");}
  return result;
}
export async function copyWeek(raw:unknown){
  const result=await staffData.copyWeek(raw);
  if(result.ok){revalidatePath("/staff");}
  return result;
}
export async function sendSchedule(raw:unknown){
  const result=await staffData.sendSchedule(raw);
  return result;
}
