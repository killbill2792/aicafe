// Non-SQL integration reads allowed in the SQL research runtime.
export const researchStaffReadTools=["get_schedule","get_week_schedule","get_staff_messages"] as const;
export const isResearchIntegrationReadTool=(name:string)=>
  ["get_events","get_nearby_events","search_maintenance_vendor"].includes(name)||(researchStaffReadTools as readonly string[]).includes(name);
