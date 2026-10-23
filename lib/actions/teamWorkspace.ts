"use server";
import {revalidatePath} from "next/cache";
import * as staffData from "@/lib/data/staffPeople.server";
export async function addPerson(raw:unknown){
  const result=await staffData.addPerson(raw);
  if(result.ok){revalidatePath("/staff");}
  return result;
}
export async function updatePerson(raw:unknown){
  const result=await staffData.updatePerson(raw);
  if(result.ok){revalidatePath("/staff");}
  return result;
}
export async function setPersonActive(raw:unknown){
  const result=await staffData.setPersonActive(raw);
  if(result.ok){revalidatePath("/staff");}
  return result;
}
