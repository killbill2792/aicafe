import {describe,expect,it} from "vitest";
import {normalizeStaffPhone} from "./staffPhone";
describe("owner staff phone normalization",()=>{
 it("uses the café country for local numbers",()=>{
  expect(normalizeStaffPhone("(415) 555-1234","US")).toBe("+14155551234");
  expect(normalizeStaffPhone("415.555.1234","CA")).toBe("+14155551234");
  expect(normalizeStaffPhone("612 345 678","ES")).toBe("+34612345678");
 });
 it("recognizes international prefixes and Arabic-Indic digits",()=>{
  expect(normalizeStaffPhone("0034 612 345 678","US")).toBe("+34612345678");
  expect(normalizeStaffPhone("+١ ٤١٥ ٥٥٥ ١٢٣٤","US")).toBe("+14155551234");
  expect(normalizeStaffPhone("۰۰۳۴ ۶۱۲ ۳۴۵ ۶۷۸","MX")).toBe("+34612345678");
 });
 it("never guesses absent country or accepts garbage",()=>{
  expect(normalizeStaffPhone("4155551234",null)).toBeUndefined();
  expect(normalizeStaffPhone("hello","US")).toBeUndefined();
  expect(normalizeStaffPhone("1234","US")).toBeUndefined();
  expect(normalizeStaffPhone("1234","MX")).toBeUndefined();
  expect(normalizeStaffPhone(undefined,"US")).toBeNull();
  expect(normalizeStaffPhone("+0123","US")).toBeUndefined();
  expect(normalizeStaffPhone("",null)).toBeNull();
 });
});
