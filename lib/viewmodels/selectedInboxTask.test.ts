import {describe,expect,it} from "vitest";
import {selectedInboxTaskId} from "./selectedInboxTask";
describe("Exact task navigation is presentation-only and business scoped",()=>{
  const authorized=[{id:"price:latte:450:525"},{id:"coverage:sam:2026-10-12"}];
  it("selects only a persisted task already present in the filtered inbox",()=>{
    expect(selectedInboxTaskId(authorized,"price:latte:450:525")).toBe("price:latte:450:525");
    expect(selectedInboxTaskId(authorized,"coverage:sam:2026-10-12")).toBe("coverage:sam:2026-10-12");
  });
  it("cannot highlight a nonexistent, other-business, other-agent, or other-tab task",()=>{
    expect(selectedInboxTaskId(authorized,"other-business:task")).toBeNull();
    expect(selectedInboxTaskId([authorized[0]],authorized[1].id)).toBeNull();
    expect(selectedInboxTaskId([],authorized[0].id)).toBeNull();
    expect(selectedInboxTaskId(authorized,"price:latte:450:525#other")).toBeNull();
    expect(selectedInboxTaskId(authorized,"a".repeat(201))).toBeNull();
  });
});
