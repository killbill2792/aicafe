/** The only strings displayed to owners come from translations. Wire statuses
 * to localized copy; never render backend enums or raw transport errors. */
export type RedemptionCopy={
 error:string;invalid:string;expiredCode:string;full:string;rateLimited:string;pausedCafe:string;alreadyRedeemed:string;
};
export function redeemFailureMessage(status:unknown,copy:RedemptionCopy):string{
 switch(status){
  case "invalid": case "invalid_code": return copy.invalid;
  case "expired_code": return copy.expiredCode;
  case "full": return copy.full;
  case "rate_limited": return copy.rateLimited;
  case "paused_cafe": return copy.pausedCafe;
  case "already_redeemed": return copy.alreadyRedeemed;
  default: return copy.error;
 }
}
