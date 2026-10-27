import {getTranslations} from "next-intl/server";
import {getOpenPosStaffImportReviews} from "@/lib/data/posImportReviews.server";
import {resolvePosStaffImportReview} from "@/lib/actions/posImportReviews";

type Person={id:string;name:string};
export default async function PosImportReviewPanel({people}:{people:Person[]}){
 const [state,t]=await Promise.all([
  getOpenPosStaffImportReviews(),getTranslations("StaffSchedule")
 ]);
 if(!state.available||state.reviews.length===0)return null;
 const names=new Map(people.map(p=>[p.id,p.name]));
 const title={
  staff_identity:t("posReviewIdentity"),unlinked_timecard:t("posReviewUnlinked"),
  overlapping_timecard:t("posReviewOverlap"),shift_corrected:t("posReviewCorrected"),
 };
 return <section aria-label={t("posReviewsTitle")}
  className="rounded-2xl border border-warn bg-card p-4">
  <h2 className="text-lg font-bold text-ink">{t("posReviewsTitle")}</h2>
  <p className="mt-1 text-sm text-ink-muted">{t("posReviewsHint")}</p>
  {state.truncated&&<p role="status">{t("posReviewsTruncated")}</p>}
  <ul className="mt-3 space-y-3">
   {state.reviews.map(review=>{
    const candidateIds=Array.isArray(review.detail.candidates)?
      review.detail.candidates.filter((id):id is string=>typeof id==="string"):[];
    const linkable=review.reviewType==="staff_identity"||
      review.reviewType==="unlinked_timecard";
    const choices=review.reviewType==="staff_identity"?
      people.filter(p=>candidateIds.includes(p.id)):people;
    return <li key={review.reviewType+":"+review.sourceKey}
     className="rounded-xl border border-line p-3">
     <p className="font-semibold">{title[review.reviewType]}</p>
     <p className="break-words text-sm text-ink-muted">
      {String(review.detail.displayName??review.detail.employeeGuid??
        review.detail.employeeId??review.sourceKey).slice(0,160)}
     </p>
     {linkable?
      <form action={resolvePosStaffImportReview} className="mt-2 flex flex-wrap items-end gap-2">
       <input type="hidden" name="reviewType" value={review.reviewType}/>
       <input type="hidden" name="sourceKey" value={review.sourceKey}/>
       <input type="hidden" name="decision" value="link_existing"/>
       <label className="flex flex-col gap-1 text-sm">{t("posReviewChooseEmployee")}
        <select name="employeeId" required defaultValue="" className="min-h-11 rounded-lg border border-line bg-card px-2">
         <option value="" disabled>{t("posReviewChooseEmployee")}</option>
         {choices.map(person=><option key={person.id} value={person.id}>{names.get(person.id)}</option>)}
        </select>
       </label>
       <button type="submit" disabled={choices.length===0}
        className="min-h-11 rounded-lg bg-accent px-3 text-on-accent">
        {t("posReviewLink")}
       </button>
      </form>:
      <div className="mt-2 flex flex-wrap gap-2">
       {review.reviewType==="shift_corrected"&&
        <form action={resolvePosStaffImportReview}>
         <input type="hidden" name="reviewType" value={review.reviewType}/>
         <input type="hidden" name="sourceKey" value={review.sourceKey}/>
         <input type="hidden" name="decision" value="accept_toast"/>
         <button type="submit" className="min-h-11 rounded-lg border border-line px-3">
          {t("posReviewAcceptToast")}
         </button>
        </form>}
       <form action={resolvePosStaffImportReview}>
        <input type="hidden" name="reviewType" value={review.reviewType}/>
        <input type="hidden" name="sourceKey" value={review.sourceKey}/>
        <input type="hidden" name="decision" value="keep_owner"/>
        <button type="submit" className="min-h-11 rounded-lg border border-line px-3">
         {t("posReviewKeepOwner")}
        </button>
       </form>
      </div>}
    </li>;
   })}
  </ul>
 </section>;
}
