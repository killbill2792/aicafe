"use client";
import {useEffect,useRef,type ReactNode} from "react";

/** Native modal dialog: browser traps focus, makes the rest of the page inert,
 * supports Escape, and restores the invoking control's focus on close.
 * Both edit sheets and the copy-ready view share these accessibility guarantees. */
export default function StaffDialog({headingId,onClose,children,layout="sheet"}:{
 headingId:string;onClose:()=>void;children:ReactNode;layout?:"sheet"|"center"
}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{
  const dialog=ref.current;
  if(!dialog)return;
  if(!dialog.open)dialog.showModal();
  return ()=>{if(dialog.open)dialog.close();};
 },[]);
 return <dialog ref={ref} aria-modal="true" aria-labelledby={headingId}
  onClose={()=>{if(!ref.current?.open)onClose();}}
  className={layout==="center"?
   "fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border border-line bg-surface p-5 text-fg shadow-2xl backdrop:bg-black/50":
   "fixed inset-x-0 bottom-0 top-auto mx-auto mb-0 max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-line bg-surface p-5 pb-8 text-fg shadow-2xl backdrop:bg-black/50"}>
  {children}
 </dialog>;
}
