"use server";
import {revalidatePath} from "next/cache";
import * as staffData from "@/lib/data/staffRules.server";
export async function getTeamRules(){
  const result=await staffData.getTeamRules();
  return result;
}
export async function updateTeamRules(raw:unknown){
  const result=await staffData.updateTeamRules(raw);
  if(result.ok){revalidatePath("/staff");revalidatePath("/staff/rules");}
  return result;
}
export async function addCustomRule(raw:unknown){
  const result=await staffData.addCustomRule(raw);
  if(result.ok){revalidatePath("/staff");revalidatePath("/staff/rules");}
  return result;
}
export async function removeCustomRule(raw:unknown){
  const result=await staffData.removeCustomRule(raw);
  if(result.ok){revalidatePath("/staff");revalidatePath("/staff/rules");}
  return result;
}
