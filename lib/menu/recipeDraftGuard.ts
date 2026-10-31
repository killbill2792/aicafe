/** A pending density/calibration entry changes the canonical base quantity that
 * will be saved for a recipe size, even when the visible quantity and unit are
 * identical to the last saved line. Never let navigation discard these drafts. */
/** A size-specific recipe save only includes the currently focused size. Any
 * other pending density/calibration/quantity edit must be saved before focus
 * changes, or its inputs would be cleared by the next size's save. */
export function planRecipeSizeSwitch(current:string,next:string,dirty:boolean):{focusedSize:string;blocked:boolean}{
 if(current===next)return {focusedSize:current,blocked:false};
 return dirty?{focusedSize:current,blocked:true}:{focusedSize:next,blocked:false};
}

export function hasPendingRecipeMeasurements(
 densityInputs:Readonly<Record<string,string>>,
 calibration:Readonly<Record<string,string>>,
 exceptNewRowCalibrationKey?:string,
):boolean{
 return Object.keys(densityInputs).length>0||
  Object.keys(calibration).some(key=>key!==exceptNewRowCalibrationKey);
}
