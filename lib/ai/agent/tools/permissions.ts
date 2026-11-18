import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

/** Read only. This tool never authorizes, approves, grants or revokes an effect. */
export const permissionTools={
  get_supervisor_permissions:{
    agentId:"leo" as const,
    schema:z.strictObject({}),
    description:"Read the authenticated café owner's current standing permissions directly from the Task 10 mandate ledger. Use when the owner asks what Supervisor is allowed to do, what permissions are active/expired/revoked, or what its standing limits are. This read-only tool cannot grant, change, approve or execute anything; only the verified owner controls can do so. Do not invent connector or external-browser permissions.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      z.strictObject({}).parse(raw);
      const base={source:"supervisor_mandates",period:null,agentId:"leo" as const};
      if(!ctx.readPermissions)return {...base,missing:["owner_permission_reader_unavailable"],permissions:[]};
      const rows=await ctx.readPermissions();
      const now=Date.now();
      return {...base,missing:[],permissions:rows.map(row=>({
        capabilityId:row.capability_id,
        capabilityVersion:row.capability_version,
        status:row.revoked_at?"revoked":row.superseded_at?"superseded":
          Date.parse(row.expires_at)<=now?"expired":"active",
        limitKind:row.limit_kind,limitValue:row.limit_value,
        periodKind:row.period_kind,weekStart:row.staff_week_start,
        expiresAt:row.expires_at,revision:row.revision,
      }))};
    },
  },
} as const;
