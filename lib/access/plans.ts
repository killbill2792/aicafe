/** Display-only public pricing configuration. No payment or checkout exists. */
export const pricingPlans=[
  {id:"starter",monthlyUsd:29,features:["planStarterFeature1","planStarterFeature2"]},
  {id:"growth",monthlyUsd:79,features:["planGrowthFeature1","planGrowthFeature2"]},
] as const;
/** Exact USD prices are editable here; they do not trigger charges. */
