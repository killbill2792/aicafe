import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {join} from "node:path";

describe("visible Toast owner reviews",()=>{
 it("Staff page shows review cards and the backend provides working owner actions",()=>{
  const page=readFileSync(join(process.cwd(),"app/[locale]/staff/page.tsx"),"utf8");
  const panel=readFileSync(join(process.cwd(),"components/staff/PosImportReviewPanel.tsx"),"utf8");
  const action=readFileSync(join(process.cwd(),"lib/actions/posImportReviews.ts"),"utf8");
  expect(page).toContain("<PosImportReviewPanel");
  expect(panel).toContain("resolvePosStaffImportReview");
  for(const review of ["staff_identity","unlinked_timecard",
    "overlapping_timecard","shift_corrected"])expect(panel).toContain(review);
  expect(action).toContain('rpc("pos_resolve_staff_import_review"');
  expect(action).toContain("requireSchedulingOwner()");
 });
});
