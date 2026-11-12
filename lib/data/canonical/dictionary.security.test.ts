import {describe,expect,it} from "vitest";
import {isDataField} from "./dictionary";

// SQL ai_query_path and this TypeScript gate must both refuse old retained
// Toast credential fields without erasing permitted business/identity data.
describe("Toast reusable-credential named-path boundary",()=>{
 it.each([
  "data.access_token","data.customer.refresh_token",
  "data.payments.0.payment_token","data.customer.API_KEY",
  "data.customer.client_secret","data.customer.session_token",
  "data.customer.authorization_token","data.customer.private_key",
  "data.customer.oauth_token","data.customer.bearer_token",
  "data.customer.accessToken","data.customer.paymentToken",
  "data.customer.card_number","data.customer.card_info",
  "data.token","data.customer.cardNumber",
 ])("rejects reusable secret: %s",field=>{
  expect(isDataField(field)).toBe(false);
 });
 it.each([
  "data.customer.first_name","data.customer.email","data.staff.employee_guid",
  "data.loyalty.membership_id","data.checks.0.amount",
  "data.customer.phone","data.description","data.product_name",
  "data.order_channel","data.customer_card_name",
 ])("preserves permitted path: %s",field=>{
  expect(isDataField(field)).toBe(true);
 });
 it("rejects malformed and insecure container paths",()=>{
  expect(isDataField("data")).toBe(false);
  expect(isDataField("data.customer.")).toBe(false);
  expect(isDataField("data.cardInfo.name")).toBe(false);
  expect(isDataField("data.customer.1000.email")).toBe(false);
 });
});
