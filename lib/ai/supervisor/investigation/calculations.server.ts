import "server-only";
import {createHash} from "node:crypto";
import type {Operand,Binding} from "../p3/expression";
import type {Observation} from "./evidence";
import {DATASET_ID} from "./datasets.server";
import type {TrustedReadScope} from "../p2/registry";
export function datasetOperands(observations:readonly Observation[],scope:TrustedReadScope):{operands:Operand[];bindings:Binding[]}{
  const operands:Operand[]=[];
  const binding:Binding={capabilityId:DATASET_ID,canonicalReaderId:"platform.dataset.analysis",
    sourceIds:["platform.authorized_dataset"],purposes:["dataset_analysis"],sensitivity:"financial"};
  for(const o of observations){
    if(o.capabilityId!==DATASET_ID||o.result.status!=="partial")continue;
    const value=o.result.value as {groups:Array<{value:number}>;unit:Operand["unit"];sourceReadId:string};
    const source=observations.find(r=>r.id===value.sourceReadId);
    const input=source?.input as {period?:{from:string;to:string}}|undefined;
    for(let i=0;i<value.groups.length;i++)operands.push({
      handle:"dataset:"+o.id+":"+i,capabilityId:DATASET_ID,canonicalReaderId:"platform.dataset.analysis",
      sourceId:"platform.authorized_dataset",sourcePurpose:"dataset_analysis",sourceRevision:null,
      observedContentHash:"sha256:"+createHash("sha256").update(JSON.stringify({result:o.result,source:source?.result})).digest("hex"),
      selectorContractId:"platform.dataset.analysis.selector",selectorContractVersion:1,
      businessId:scope.businessId,locationId:null,asOf:scope.identity.asOf,
      period:input?.period?{...input.period,timezone:scope.identity.timezone}:null,
      status:"partial",actuality:source?.result.actuality==="actual"?"actual":source?.result.actuality==="planned"?"planned":"estimated",evidenceStatus:"unverified",
      missingInputs:["unversioned_source","dataset_analysis_is_source_scoped"],staleInputs:[],
      unit:value.unit,currency:value.unit.startsWith("USD_")?"USD":null,value:value.groups[i].value,
    });
  }
  return {operands,bindings:operands.length?[binding]:[]};
}
