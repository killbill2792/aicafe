"use server";
import {revalidatePath} from "next/cache";
import * as staffData from "@/lib/data/staffAlertActions.server";
export async function dismissStaffRuleAlert(raw:unknown){
  const result=await staffData.dismissStaffRuleAlert(raw);
  if(result.ok){revalidatePath("/staff");}
  return result;
}
