import type { MetricKey } from "@/lib/calc/metrics/catalog";
export type SuggestedMetric = {
  metricKey:MetricKey; role:"primary"|"guardrail"; params:Record<string,unknown>;
};
export interface InitiativeAdapter {
  id:string;
  suggestMetrics(spec:Record<string,unknown>):SuggestedMetric[];
  apply?:never; // M1 never executes operational changes
  revert?:never;
}
export const initiativeAdapters:Readonly<Record<string,InitiativeAdapter>>={
  price_change:{
    id:"price_change",
    suggestMetrics(spec){
      const itemId=spec.itemId;
      if(typeof itemId!=="string")return [];
      return [
        {metricKey:"item_units",role:"primary",params:{itemId}},
        {metricKey:"item_revenue",role:"primary",params:{itemId}},
        {metricKey:"item_margin",role:"primary",params:{itemId}},
        {metricKey:"orders",role:"guardrail",params:{}},
      ];
    },
  },
};
