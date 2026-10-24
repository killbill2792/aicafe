/** Display-only public pricing configuration. No payment or checkout exists. */
export const pricingPlans=[
  {id:"starter",monthlyCents:2900,features:["planStarterFeature1","planStarterFeature2"]},
  {id:"growth",monthlyCents:7900,features:["planGrowthFeature1","planGrowthFeature2"]},
] as const;
/** Price is stored in integer cents, per the project money invariant. Edit here before launch. */
