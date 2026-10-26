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
 it("removes national trunk prefixes only where the dialing plan requires it",()=>{
  expect(normalizeStaffPhone("07700 900123","GB")).toBe("+447700900123");
  expect(normalizeStaffPhone("06 12 34 56 78","FR")).toBe("+33612345678");
  expect(normalizeStaffPhone("050 123 4567","AE")).toBe("+971501234567");
  expect(normalizeStaffPhone("0412 345 678","AU")).toBe("+61412345678");
  // Italian geographic area codes retain their significant leading zero.
  expect(normalizeStaffPhone("06 1234 5678","IT")).toBe("+390612345678");
 });
 it("rejects malformed international numbers and ambiguous domestic prefixes",()=>{
  // A direct +number or an international 00 prefix must not bypass the same validation.
  expect(normalizeStaffPhone("+44 07700 900123","US")).toBeUndefined();
  expect(normalizeStaffPhone("0033 0612345678","GB")).toBeUndefined();
  expect(normalizeStaffPhone("+971 0501234567","AE")).toBeUndefined();
  // Brazilian/Argentine domestic dialing can contain carrier or mobile
  // prefixes: do not invent an E.164 number from unsupported local forms.
  expect(normalizeStaffPhone("021 11987654321","BR")).toBeUndefined();
  expect(normalizeStaffPhone("011 15 12345678","AR")).toBeUndefined();
  expect(normalizeStaffPhone("0700 900123","GB")).toBeUndefined();
  expect(normalizeStaffPhone("1234","FR")).toBeUndefined();
  expect(normalizeStaffPhone("+447700900123","US")).toBe("+447700900123");
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
