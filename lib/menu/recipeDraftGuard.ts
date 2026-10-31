/** A pending density/calibration entry changes the canonical base quantity that
 * will be saved for a recipe size, even when the visible quantity and unit are
 * identical to the last saved line. Never let navigation discard these drafts. */
export function hasPendingRecipeMeasurements(
 densityInputs:Readonly<Record<string,string>>,
 calibration:Readonly<Record<string,string>>,
):boolean{
 return Object.keys(densityInputs).length>0||Object.keys(calibration).length>0;
}
