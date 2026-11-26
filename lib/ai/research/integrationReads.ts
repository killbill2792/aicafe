// Non-SQL integration reads allowed in the SQL research runtime.
export const researchStaffReadTools=["get_schedule","get_week_schedule","get_staff_messages"] as const;
export const isResearchIntegrationReadTool=(name:string)=>
  name==="get_events"||(researchStaffReadTools as readonly string[]).includes(name);
