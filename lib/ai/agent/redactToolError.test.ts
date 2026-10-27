import {describe,it,expect} from "vitest";
import {redactToolFailure,redactedErrorStack} from "./redactToolError";
describe("tool failure audit redaction",()=>{
 it("preserves a useful code and schema reason within 300 characters",()=>{
  const result=redactToolFailure(new Error("getMenuControlCenter: order_lines column absent"),"internal");
  expect(result).toBe("internal: getMenuControlCenter: order_lines column absent");
  expect(result.length).toBeLessThanOrEqual(300);
 });
 it("removes bearer, secrets, links and long tokens from error evidence",()=>{
  const error=new Error("Bearer abcdefghi987654321 access_token=secret123456789012345678901234 url https://a.example/c?key=abc");
  const msg=redactToolFailure(error,"internal");
  expect(msg).not.toContain("secret123");
  expect(msg).not.toContain("abcdefghi");
  expect(msg).not.toContain("a.example");
  expect(redactedErrorStack(error)??"").not.toContain("secret123");
 });
 it("never logs personal contact information or values from named fields",()=>{
  const error=new Error('order_lines column absent; email=person@example.com phone="+1 415 555 0199"');
  const message=redactToolFailure(error,"internal");
  expect(message).toContain("order_lines column absent");
  expect(message).not.toContain("person@example.com");
  expect(message).not.toContain("415 555");
  expect(message.length).toBeLessThanOrEqual(300);
 });

});
