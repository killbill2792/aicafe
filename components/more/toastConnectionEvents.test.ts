import {describe,it,expect,vi} from "vitest";
import {TOAST_CONNECTION_CHANGED,subscribeToastConnectionChanges,createToastStatusRequestGate} from "./toastConnectionEvents";
describe("Toast credential changes refresh the adjacent owner dashboard",()=>{
 it("receives a verified/save/disconnect announcement and unsubscribes on unmount",()=>{
  const target=new EventTarget(),onChange=vi.fn();
  const unsubscribe=subscribeToastConnectionChanges(target,onChange);
  target.dispatchEvent(new Event("unrelated"));
  expect(onChange).not.toHaveBeenCalled();
  target.dispatchEvent(new Event(TOAST_CONNECTION_CHANGED));
  expect(onChange).toHaveBeenCalledTimes(1);
  unsubscribe();
  target.dispatchEvent(new Event(TOAST_CONNECTION_CHANGED));
  expect(onChange).toHaveBeenCalledTimes(1);
 });
});

describe("out-of-order Toast status reads",()=>{
 it("only the most recently requested snapshot may replace the dashboard",()=>{
  const gate=createToastStatusRequestGate();
  const beforeConnecting=gate.begin();
  const afterVerified=gate.begin();
  expect(gate.isCurrent(beforeConnecting)).toBe(false);
  expect(gate.isCurrent(afterVerified)).toBe(true);
  gate.invalidate();
  expect(gate.isCurrent(afterVerified)).toBe(false);
 });
});
