import {describe,it,expect} from "vitest";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {agentToolDefinitions} from "./tools";
import {staffCapabilityId} from "@/lib/ai/supervisor/loop/staffProposals.server";
import {staffProposalInputs} from "./tools/staffProposals";
import {menuPriceChangeCapabilityId} from "@/lib/ai/supervisor/loop/menuPriceChange.server";
import {priceExperimentCapabilityId} from "@/lib/ai/supervisor/loop/priceExperiment.server";
/** Intentional omissions require a safe owner-facing explanation here. */
export const notAgentExposed:Record<string,string>={};
describe("loop capability exposure",()=>{
 it("exposes or explicitly documents every registered capability",()=>{
  const exposed=new Map<string,string>([
   [menuPriceChangeCapabilityId,"propose_price_change"],
   [priceExperimentCapabilityId,"propose_price_experiment"],
   ...Object.keys(staffProposalInputs).map(name=>[staffCapabilityId(name as keyof typeof staffProposalInputs),name] as [string,string]),
  ]);
  const tools=new Set(agentToolDefinitions.map(tool=>tool.name));
  for(const capabilityId of supervisorLoopRegistry.list()){
   expect(exposed.has(capabilityId)||Boolean(notAgentExposed[capabilityId])).toBe(true);
   if(exposed.has(capabilityId))expect(tools.has(exposed.get(capabilityId)!)).toBe(true);
  }
 });
});
