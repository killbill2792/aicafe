import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {promoteSchema} from "./promote";
const guid="00000000-0000-4000-8000-000000000001";
it("promotion requires explicit affirmative confirmation, GUID, date and checksum",()=>{
 const valid={businessId:guid,locationId:guid,restaurantGuid:guid,
 businessDate:"2026-10-10",checksum:"a".repeat(64),confirmPromotion:true};
 expect(promoteSchema.safeParse(valid).success).toBe(true);
 expect(promoteSchema.safeParse({...valid,confirmPromotion:false}).success).toBe(false);
 expect(promoteSchema.safeParse({...valid,checksum:"abc"}).success).toBe(false);
 expect(promoteSchema.safeParse({...valid,businessId:"invalid"}).success).toBe(false);
});
