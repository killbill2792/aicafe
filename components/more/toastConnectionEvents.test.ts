import {describe,it,expect,vi} from "vitest";
import {TOAST_CONNECTION_CHANGED,subscribeToastConnectionChanges} from "./toastConnectionEvents";
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
