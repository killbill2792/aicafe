import { useEffect, useReducer, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

type Verification = { start:number;end:number;source?:"owner"|"estimate"|"unchecked";detail?:string };
export type ProvenanceLabels={owner:string;estimate:string;unchecked:string;breakEvenSales?:string;salesGap?:string;dailyOverhead?:string};
const tones={owner:"bg-blue-600",estimate:"bg-amber-600",unchecked:"bg-gray-500"} as const;
type DotEvent="hover-start"|"hover-end"|"focus-start"|"focus-end"|"tooltip-focus-start"|"tooltip-focus-end"|"click"|"escape";
type DotInteraction={hovered:boolean;focused:boolean;tooltipFocused?:boolean;pinned:boolean;dismissed:boolean};
const dotInitial:DotInteraction={hovered:false,focused:false,tooltipFocused:false,pinned:false,dismissed:false};
/** Hover/focus hints and tap-pinned state are independent: focus before click cannot close the first tap. */
export function sourceDotNext(state:DotInteraction,event:DotEvent):DotInteraction{
  switch(event){
    case "hover-start":return {...state,hovered:true,dismissed:false};
    case "hover-end":return {...state,hovered:false,dismissed:false};
    case "focus-start":return {...state,focused:true,dismissed:false};
    case "focus-end":return {...state,focused:false,pinned:false,dismissed:false};
    case "tooltip-focus-start":return {...state,focused:false,tooltipFocused:true,dismissed:false};
    case "tooltip-focus-end":return {...state,tooltipFocused:false,pinned:false};
    case "click":return {...state,pinned:!state.pinned,dismissed:state.pinned};
    case "escape":return {...state,pinned:false,dismissed:true};
  }
}
export function sourceDotIsOpen(state:DotInteraction):boolean{
  return state.pinned||(!state.dismissed&&(state.hovered||state.focused||state.tooltipFocused));
}
/** Keyboard scrolling works while focus stays on the superscript button. */
export function provenanceScrollCommand(key:string,height:number):number|"start"|"end"|null{
  const page=Math.max(64,height-32);
  switch(key){
    case "ArrowDown":return 40;
    case "ArrowUp":return -40;
    case "PageDown":return page;
    case "PageUp":return -page;
    case "Home":return "start";
    case "End":return "end";
    default:return null;
  }
}
type TooltipPosition={left:number;top:number;width:number};
/** Testable presentation: dark and light both use the theme's ink/paper contrast. */
export function ProvenanceTooltip({label,position,tooltipRef,onPointerEnter,onPointerLeave,onTooltipFocus,onTooltipBlur,onTooltipKeyDown}:{
  label:string;position:TooltipPosition|null;
  tooltipRef?:Ref<HTMLSpanElement>;
  onPointerEnter?:()=>void;onPointerLeave?:()=>void;
  onTooltipFocus?:()=>void;onTooltipBlur?:()=>void;
  onTooltipKeyDown?:(event:React.KeyboardEvent<HTMLSpanElement>)=>void;
}){
  return <span ref={tooltipRef} role="tooltip" dir="auto" tabIndex={-1}
    onMouseEnter={onPointerEnter} onMouseLeave={onPointerLeave}
    onFocus={onTooltipFocus} onBlur={onTooltipBlur} onKeyDown={onTooltipKeyDown}
    className="pointer-events-auto fixed z-[100] max-h-[calc(100dvh-16px)] overflow-y-auto rounded bg-ink px-3 py-2 text-[17px] leading-relaxed text-paper shadow"
    style={{left:position?.left??0,top:position?.top??0,width:position?.width??320,
      transform:"translateX(-50%)",visibility:position?"visible":"hidden"}}>{label}</span>;
}
/** Keep the 6px footnote attached to its number; portal tooltips outside clipped scroll areas. */
function SourceDot({tone,label}:{tone:keyof typeof tones;label:string}){
  const [interaction,dispatch]=useReducer(sourceDotNext,dotInitial);
  const open=sourceDotIsOpen(interaction);
  const [position,setPosition]=useState<TooltipPosition|null>(null);
  const button=useRef<HTMLButtonElement>(null);
  const tooltip=useRef<HTMLSpanElement>(null);
  useEffect(()=>{
    if(!open)return;
    const update=()=>{
      const target=button.current;
      if(!target)return;
      const rect=target.getBoundingClientRect();
      const width=Math.max(120,Math.min(320,window.innerWidth-16));
      const half=width/2;
      const left=Math.max(8+half,Math.min(window.innerWidth-8-half,rect.left+rect.width/2));
      // Place above the mark when possible; move below near the top edge.
      const height=tooltip.current?.getBoundingClientRect().height??48;
      const above=rect.top-height>=8;
      const top=above?rect.top-height:Math.min(window.innerHeight-height-8,rect.bottom);
      setPosition({left,top:Math.max(8,top),width});
    };
    update();
    window.addEventListener("resize",update);
    window.addEventListener("scroll",update,true);
    return ()=>{window.removeEventListener("resize",update);window.removeEventListener("scroll",update,true);};
  },[open,label]);
  return <span className="relative inline-block h-[6px] w-[6px] align-super">
    <button ref={button} type="button" aria-label={label} aria-expanded={open}
      onMouseEnter={()=>dispatch("hover-start")}
      onMouseLeave={e=>{
        // Hoverable popover: do not dismiss while entering its scroll surface.
        const next=e.relatedTarget;
        if(next instanceof Node&&tooltip.current?.contains(next))return;
        dispatch("hover-end");
      }}
      onFocus={()=>dispatch("focus-start")} onBlur={e=>{
        const next=e.relatedTarget;
        if(next instanceof Node&&tooltip.current?.contains(next)){
          dispatch("tooltip-focus-start");
          return;
        }
        dispatch("focus-end");
      }}
      onClick={()=>dispatch("click")}
      onKeyDown={e=>{
        if(e.key==="Escape"){dispatch("escape");return;}
        if(!open||!tooltip.current)return;
        if(e.key==="Tab"&&!e.shiftKey){
          // Give keyboard users direct access to the scrollable explanation.
          e.preventDefault();tooltip.current.focus();return;
        }
        const surface=tooltip.current;
        if(surface.scrollHeight<=surface.clientHeight)return;
        const command=provenanceScrollCommand(e.key,surface.clientHeight);
        if(command===null)return;
        e.preventDefault();
        if(command==="start")surface.scrollTop=0;
        else if(command==="end")surface.scrollTop=surface.scrollHeight;
        else surface.scrollTop+=command;
      }}
      className="absolute left-1/2 top-1/2 z-10 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
      <span aria-hidden="true" className={`block h-[6px] w-[6px] shrink-0 rounded-full ${tones[tone]}`}/>
    </button>
    {open&&typeof document!=="undefined"&&createPortal(
      <ProvenanceTooltip label={label} position={position} tooltipRef={tooltip}
        onPointerEnter={()=>dispatch("hover-start")} onPointerLeave={()=>dispatch("hover-end")}
        onTooltipFocus={()=>dispatch("tooltip-focus-start")}
        onTooltipBlur={()=>dispatch("tooltip-focus-end")}
        onTooltipKeyDown={e=>{
          if(e.key==="Escape"){button.current?.focus();dispatch("escape");}
        }}/>,
      document.body)}
  </span>;
}
type SourceLine = { text: string; start: number };
type ListMarker = { ordered: boolean; number: number; content: string; contentStart: number };

function sourceLines(source: string): SourceLine[] {
  let offset = 0;
  return source.split("\n").map(raw => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const line = { text, start: offset };
    offset += raw.length + 1;
    return line;
  });
}

function listMarker(line: SourceLine): ListMarker | null {
  // Only top-level list markers are supported. Indentation is limited to three
  // spaces to avoid treating indented code as a list.
  const number = /^ {0,3}(\d+)[.)] +(.+)$/.exec(line.text);
  if (number) return {
    ordered: true, number: Number(number[1]), content: number[2],
    contentStart: line.start + number[0].length - number[2].length,
  };
  const bullet = /^ {0,3}[-*+] +(.+)$/.exec(line.text);
  if (bullet) return {
    ordered: false, number: 0, content: bullet[1],
    contentStart: line.start + bullet[0].length - bullet[1].length,
  };
  return null;
}

/** Render verification labels at original UTF-16 offsets, after Markdown
 * delimiters have been interpreted. Both verified and regular text share the
 * same block parser; labels cannot switch lists back to raw source text. */
function annotatedText(
  text: string, absoluteStart: number, spans: readonly Verification[], labels: ProvenanceLabels, badged: Set<number>,
): ReactNode[] {
  const end = absoluteStart + text.length;
  const out: ReactNode[] = [];
  let cursor = absoluteStart;
  for (const span of spans) {
    if (span.end <= cursor || span.start >= end) continue;
    const from = Math.max(cursor, span.start);
    const to = Math.min(end, span.end);
    if (from > cursor) out.push(text.slice(cursor - absoluteStart, from - absoluteStart));
    if (from < to) {
      const source=span.source??"unchecked";
      const detail=span.detail==="breakEvenSales"?labels.breakEvenSales:span.detail==="salesGap"?labels.salesGap:span.detail==="dailyOverhead"?labels.dailyOverhead:span.detail;
      const explanation=detail?labels[source]+": "+detail:labels[source];
      out.push(<span key={from} className="whitespace-nowrap">
        {text.slice(from-absoluteStart,to-absoluteStart)}
        {!badged.has(span.start)&&<SourceDot tone={source} label={explanation}/>}
      </span>);
    }
    if (from < to) badged.add(span.start);
    cursor = Math.max(cursor, to);
  }
  if (cursor < end) out.push(text.slice(cursor - absoluteStart));
  return out;
}

function inlineMarkdown(
  text: string, absoluteStart: number, spans: readonly Verification[], labels: ProvenanceLabels, badged: Set<number>,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  // No model-authored HTML or links: React escapes literal source text. Inline
  // code is rendered as text and is never reparsed as emphasis.
  const pattern = /(\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(...annotatedText(text.slice(cursor, match.index), absoluteStart + cursor, spans, labels, badged));
    }
    const delimiter = match[2] !== undefined || match[3] !== undefined ? 2 : 1;
    const content = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6];
    const inner = annotatedText(content, absoluteStart + match.index + delimiter, spans, labels, badged);
    const key = absoluteStart + match.index;
    nodes.push(match[2] !== undefined || match[3] !== undefined
      ? <strong key={key} className="font-bold">{inner}</strong>
      : match[6] !== undefined
        ? <code key={key} className="rounded bg-surface2 px-1">{inner}</code>
        : <em key={key}>{inner}</em>);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(...annotatedText(text.slice(cursor), absoluteStart + cursor, spans, labels, badged));
  return nodes;
}

export function SourceLegend({sources,labels,legendLabel="Number sources"}:{
 sources:readonly ("owner"|"estimate"|"unchecked")[];labels:ProvenanceLabels;legendLabel?:string;
}){
 const used=(["owner","estimate","unchecked"] as const).filter(source=>sources.includes(source));
 return used.length>0?<p className="flex flex-wrap gap-x-3 gap-y-1 text-[17px] leading-relaxed text-ink-muted" aria-label={legendLabel}>
  {used.map(source=><span key={source} className="inline-flex items-center gap-1">
   <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tones[source]}`}/>{labels[source]}
  </span>)}
 </p>:null;
}
export function ChatMarkdown({text,unverified=[],label,labels,showLegend=true,legendLabel}:{
 text:string;unverified?:readonly Verification[];label?:string;labels?:ProvenanceLabels;
 showLegend?:boolean;legendLabel?:string;
}) {
 const copy=labels??{owner:"You told me",estimate:"Estimate",unchecked:label??"Not checked against your records"};
  const spans = [...unverified].filter(s =>
    Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) &&
    s.start >= 0 && s.end > s.start && s.end <= text.length,
  ).sort((a,b) => a.start - b.start)
    .filter((s, i, all) => i === 0 || s.start >= all[i - 1].end);

  const badged = new Set<number>();
  const lines = sourceLines(text);
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].text.trim()) { index++; continue; }
    const first = listMarker(lines[index]);
    if (first) {
      const ordered = first.ordered;
      const firstNumber = first.number;
      const entries: ReactNode[] = [];
      const listStart = index;
      while (index < lines.length) {
        const marker = listMarker(lines[index]);
        if (!marker || marker.ordered !== ordered) {
          // Markdown allows blank lines between list items. Only consume them
          // if the next nonblank line is another marker of this list type.
          if (!lines[index].text.trim()) {
            let lookahead = index;
            while (lookahead < lines.length && !lines[lookahead].text.trim()) lookahead++;
            const next = lookahead < lines.length ? listMarker(lines[lookahead]) : null;
            if (next && next.ordered === ordered) { index = lookahead; continue; }
          }
          break;
        }
        const item = inlineMarkdown(marker.content, marker.contentStart, spans, copy, badged);
        entries.push(ordered
          ? <li key={index} value={marker.number} className="ps-1">{item}</li>
          : <li key={index} className="ps-1">{item}</li>);
        index++;
      }
      blocks.push(ordered
        ? <ol key={listStart} start={firstNumber} className="list-decimal space-y-1 ps-6">{entries}</ol>
        : <ul key={listStart} className="list-disc space-y-1 ps-6">{entries}</ul>);
      continue;
    }
    const start = index;
    const rows: ReactNode[] = [];
    while (index < lines.length && lines[index].text.trim() && !listMarker(lines[index])) {
      if (rows.length) rows.push("\n");
      const line = lines[index];
      rows.push(...inlineMarkdown(line.text, line.start, spans, copy, badged));
      index++;
    }
    if (index === start) index++;
    else blocks.push(<p key={start} className="whitespace-pre-line">{rows}</p>);
  }
  const sources=spans.map(s=>s.source??"unchecked");
  return <div className="space-y-2 break-words text-[17px] leading-relaxed text-ink">
    {blocks}
    {showLegend&&<SourceLegend sources={sources} labels={copy} legendLabel={legendLabel}/>}

  </div>;
}
