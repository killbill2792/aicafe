import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {normalizeToastOrder} from "./toast/adapter";
import {rajCafeDates} from "../../scripts/raj-cafe-rollup-dry-run";
const id="00000000-0000-4000-8000-000000000011";
describe("POS fact enrichment",()=>{
 it("preserves only provider-supplied identifiers and metadata",()=>{
 const row={guid:id,closedDate:"2026-08-22T20:00:00Z",server:{guid:id},source:"ONLINE",diningOption:{name:"Takeout"},numberOfGuests:3,checks:[{amount:1,taxAmount:0,paymentStatus:"CLOSED",closedDate:"2026-08-22T20:00:00Z",selections:[{displayName:"Tea",salesCategory:{name:"Drinks"},quantity:1,price:1}],payments:[]}]};
 const normalized=normalizeToastOrder(row,id);
 expect(normalized).toMatchObject({posEmployeeId:id,sourceChannel:"ONLINE",diningOption:"Takeout",guestCount:3,lines:[{category:"Drinks"}]});
 expect(normalizeToastOrder({...row,server:null,source:null,diningOption:null,numberOfGuests:null,checks:[{...row.checks[0],selections:[{displayName:"Tea",quantity:1,price:1}]}]},id))
  .toMatchObject({posEmployeeId:null,sourceChannel:null,diningOption:null,guestCount:null,lines:[{category:null}]});
 });
 it("covers Raj Cafe August 22 through September 4 inclusive",()=>{
 expect(rajCafeDates).toHaveLength(14);
 expect(rajCafeDates[0]).toBe("2026-08-22");
 expect(rajCafeDates.at(-1)).toBe("2026-09-04");
 });
});
