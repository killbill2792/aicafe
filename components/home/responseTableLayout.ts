import {useLayoutEffect,useState} from "react";

/** Measure the table's real preferred width, with its own typography, cells
 * and spacing. Reflow only when its actual content needs more room than the
 * container offers. No column-count threshold or device breakpoint. */
export function useAdaptiveTable(){
 const [region,setRegion]=useState<HTMLDivElement|null>(null);
 useLayoutEffect(()=>{
  if(!region)return;
  let disposed=false;
  const sync=()=>{
   if(disposed)return;
   const table=region.querySelector("table");if(!table)return;
   const available=region.clientWidth;
   if(!available)return;
   const labels=Array.from(table.tHead?.rows[0]?.cells??[],cell=>cell.textContent??"");
   if(!labels.length)return;
   // Preserve native table semantics when the visual layout changes.
   if(!table.hasAttribute("role"))table.setAttribute("role","table");
   for(const group of Array.from(table.tBodies)){
    if(!group.hasAttribute("role"))group.setAttribute("role","rowgroup");
    for(const row of Array.from(group.rows)){
     if(!row.hasAttribute("role"))row.setAttribute("role","row");
     for(const [index,cell] of Array.from(row.cells).entries()){
      if(!cell.hasAttribute("role"))cell.setAttribute("role",cell.tagName==="TH"?"rowheader":"cell");
      if(!cell.querySelector(".luna-table-label"))cell.setAttribute("data-luna-column",labels[index]??"");
     }
    }
   }
   region.removeAttribute("data-luna-reflow");
   region.setAttribute("data-luna-measuring","");
   const preferred=table.getBoundingClientRect().width;
   region.removeAttribute("data-luna-measuring");
   region.toggleAttribute("data-luna-reflow",preferred>available);
  };
  sync();
  const observer=new ResizeObserver(sync);observer.observe(region);
  const contentObserver=new MutationObserver(sync);
  contentObserver.observe(region,{childList:true,subtree:true,characterData:true});
  void document.fonts.ready.then(sync);
  return()=>{disposed=true;observer.disconnect();contentObserver.disconnect();};
 },[region]);
 return setRegion;
}
export const wideResponseTableClass="luna-adaptive-table";
export const wideResponseCellClass="luna-table-cell";
export const wideResponseLabelClass="luna-table-label text-[0.8125rem] font-medium leading-snug text-ink-muted wrap-anywhere";
