import { tokenizeNumbers } from "@/lib/ai/agent/numberTokens";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import { useEffect, useReducer, useRef, useState, type ReactNode, type Ref } from "react";
import {Streamdown,defaultRehypePlugins,type Components,type ExtraProps} from "streamdown";
import type {Root,Element,Text} from "hast";
import {decodeString} from "micromark-util-decode-string";
import {wideResponseTableClass,wideResponseCellClass,wideResponseLabelClass} from "./responseTableLayout";
import { createPortal } from "react-dom";

type Verification = { start:number;end:number;source?:"owner"|"estimate"|"unchecked";detail?:string };
export type ProvenanceLabels={owner:string;estimate:string;unchecked:string;breakEvenSales?:string;salesGap?:string;dailyOverhead?:string};
const tones={owner:"bg-chart-staff",estimate:"bg-warn",unchecked:"border border-ink bg-transparent"} as const;
const underlineTones={owner:"decoration-chart-staff",estimate:"decoration-warn",
  unchecked:"decoration-ink"} as const;
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
  return state.pinned||(!state.dismissed&&(state.hovered||state.focused||state.tooltipFocused===true));
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
    className="pointer-events-auto fixed z-100 max-h-[calc(100dvh-16px)] overflow-y-auto rounded-sm bg-ink px-3 py-2 text-[1.0625rem] leading-relaxed text-paper shadow-sm"
    style={{left:position?.left??0,top:position?.top??0,width:position?.width??320,
      transform:"translateX(-50%)",visibility:position?"visible":"hidden"}}>{label}</span>;
}
/** Underline the entire verified token, not a dot that can split a number.
 * Keep the existing hover, touch and keyboard explanation in a portal. */
function SourceUnderline({tone,label,children}:{tone:keyof typeof tones;label:string;children:ReactNode}){
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
  return <>
    <button ref={button} type="button" aria-label={String(children)+" — "+label} aria-expanded={open}
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
      className={`relative inline cursor-help border-0 bg-transparent p-0 align-baseline text-inherit underline decoration-dotted decoration-2 underline-offset-[3px] before:absolute before:inset-x-0 before:top-1/2 before:h-12 before:-translate-y-1/2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${underlineTones[tone]}`}
      style={{font:"inherit"}}>{children}
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
  </>;
}

type Locale="en"|"es"|"ar";
type MarkOptions={spans:readonly Verification[];labels:ProvenanceLabels;locale:Locale};
type NumberMark={start:number;end:number;source:keyof typeof tones;label:string};
/** This is a source-annotation plugin, not a Markdown parser. The renderer
 * supplies parsed AST text and original UTF-16 offsets. */
function sourceMarks(text:string,sourceRange:(start:number,end:number)=>{start:number;end:number}, {spans,labels,locale}:MarkOptions,uncertain=false):NumberMark[]{
 const clockRanges=[...text.matchAll(/\b\d{1,2}\s*[–-]\s*\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?/giu)]
   .map(m=>({start:m.index,end:m.index+m[0].length}));
 return tokenizeNumbers(text,locale).flatMap(token=>{
  if(clockRanges.some(r=>token.start<r.end&&token.end>r.start))return [];
  const range=sourceRange(token.start,token.end);
  const matching=spans.filter(s=>s.start<range.end&&s.end>range.start).map(s=>uncertain?{...s,source:"unchecked" as const,detail:undefined}:s);
  const unchecked=matching.some(s=>(s.source??"unchecked")==="unchecked");
  if(!matching.length||(["clock","clockRange","date","dateRange","duration","ordinal","phone/id"].includes(token.kind)&&!unchecked))return [];
  const span=matching.find(s=>(s.source??"unchecked")==="unchecked")??matching[0];
  const source=span.source??"unchecked";
  const detail=span.detail==="breakEvenSales"?labels.breakEvenSales:span.detail==="salesGap"?labels.salesGap:span.detail==="dailyOverhead"?labels.dailyOverhead:span.detail;
  return [{start:token.start,end:token.end,source,label:detail?labels[source]+": "+detail:labels[source]}];
 });
}
function sourceAnnotationPlugin(options:MarkOptions){
 return (tree:Root,file:{value:unknown})=>{
  const source=String(file.value),badged=new Set<number>();
  const mapping=(node:Text,parent:Root|Element)=>{
   const position=node.position??parent.position;
   const start=position?.start.offset,end=position?.end.offset;
   if(start===undefined||end===undefined)return undefined;
   const raw=source.slice(start,end);
   const literal=raw.indexOf(node.value);
   if(literal>=0&&raw.lastIndexOf(node.value)===literal)
    return {range:(a:number,b:number)=>({start:start+literal+a,end:start+literal+b}),uncertain:false};
   // Use the same CommonMark decoder as the parser, mapping every decoded
   // UTF-16 unit to the full source escape/reference that produced it.
   const units:{start:number;end:number}[]=[];let decoded="";
   const append=(value:string,a:number,b:number)=>{
    decoded+=value;for(let i=0;i<value.length;i++)units.push({start:start+a,end:start+b});
   };
   let cursor=0;
   for(const match of raw.matchAll(/\\[!-/:-@\[-\x60{-~]|&(?:#[xX][\da-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});|\r\n?/gu)){
    while(cursor<match.index){append(raw[cursor],cursor,cursor+1);cursor++;}
    const value=match[0][0]==="\r"?"\n":decodeString(match[0]);
    if(value===match[0]){for(const ch of value){append(ch,cursor,cursor+ch.length);cursor+=ch.length;}}
    else{append(value,cursor,cursor+match[0].length);cursor+=match[0].length;}
   }
   while(cursor<raw.length){append(raw[cursor],cursor,cursor+1);cursor++;}
   const at=decoded.indexOf(node.value);
   if(at>=0&&decoded.lastIndexOf(node.value)===at)
    return {range:(a:number,b:number)=>({start:units[at+a]?.start??start,end:units[at+b-1]?.end??end}),uncertain:false};
   // If the parser changed more than escapes, never silently turn a
   // potentially unsupported number into a verified one. Use the enclosing
   // source range and downgrade ambiguous provenance to unchecked.
   return {range:()=>({start,end}),uncertain:true};
  };
  // The established Markdown AST already contains the actual cells and
  // header text. Attach display labels to those nodes, not a second table.
  const elements=(n:Element,tag:string)=>n.children.filter((c):c is Element=>c.type==="element"&&c.tagName===tag);
  const plain=(n:Element):string=>n.children.map(c=>c.type==="text"?c.value:c.type==="element"?plain(c):"").join("");
  const labelWideTable=(table:Element)=>{
   const head=elements(table,"thead")[0],row=head&&elements(head,"tr")[0];
   const labels=row?elements(row,"th").map(plain):[];
   if(labels.length<=4)return;
   for(const body of elements(table,"tbody"))for(const tr of elements(body,"tr")){
    elements(tr,"td").forEach((td,i)=>{td.properties.dataCafeColumn=labels[i]??"";});
   }
  };
  const walk=(parent:Root|Element,ordered=false)=>{
   for(let i=0;i<parent.children.length;i++){
    const node=parent.children[i];
    if(node.type==="element"){
     if(node.tagName==="table")labelWideTable(node);
     // Preserve explicit numbering for numbered owner instructions, including
     // a non-one start, using the parser's list-item source position.
     if(ordered&&node.tagName==="li"){
      const at=node.position?.start.offset;
      if(at!==undefined){
       const value=/^\s*(\d+)[.)]\s/u.exec(source.slice(at,node.position?.end.offset));
       if(value)node.properties.value=Number(value[1]);
      }
     }
     walk(node,node.tagName==="ol");continue;
    }
    if(node.type!=="text")continue;
    const mapped=mapping(node,parent);
    if(!mapped)continue;
    const key=(m:NumberMark)=>mapped.range(m.start,m.end).start;
    const marks=sourceMarks(node.value,mapped.range,options,mapped.uncertain).filter(m=>mapped.uncertain||!badged.has(key(m)));
    if(!marks.length)continue;
    const nodes:(Text|Element)[]=[];let cursor=0;
    for(const mark of marks){
     if(mark.start<cursor)continue;
     if(mark.start>cursor)nodes.push({type:"text",value:node.value.slice(cursor,mark.start)});
     nodes.push({type:"element",tagName:"span",properties:{dataCafeSource:mark.source,dataCafeLabel:mark.label},
      children:[{type:"text",value:node.value.slice(mark.start,mark.end)}]});
     if(!mapped.uncertain)badged.add(key(mark));cursor=mark.end;
    }
    if(cursor<node.value.length)nodes.push({type:"text",value:node.value.slice(cursor)});
    parent.children.splice(i,1,...nodes);i+=nodes.length-1;
   }
  };
  walk(tree);
 };
}
const headingClass="mt-4 mb-1 font-semibold leading-snug text-balance wrap-break-word text-ink";
const cellClass="border-b border-line px-1.5 sm:px-3 py-2 align-top whitespace-normal wrap-anywhere";
const alignment=(value:unknown)=>value==="right"||value==="end"?"text-end":value==="center"?"text-center":"text-start";
function ResponseTable({children,node}:React.ComponentProps<"table">&ExtraProps){
 const head=node?.children.find((child):child is Element=>child.type==="element"&&child.tagName==="thead");
 const row=head?.children.find((child):child is Element=>child.type==="element"&&child.tagName==="tr");
 const columns=row?.children.filter((child):child is Element=>child.type==="element"&&child.tagName==="th")??[];
 const wide=columns.length>4;
 return <div role="region" aria-label="Response table" tabIndex={0} className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-line focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ink">
  <table role="table" className={"w-full table-auto border-collapse text-[0.9375rem] sm:text-[1.0625rem] "+(wide?wideResponseTableClass:"")}>
   <caption className="sr-only">Response table</caption>
   {children}
  </table>
 </div>;
}
const components:Components={
 table:ResponseTable,
 th:({children,align,style,node})=><th scope="col" className={cellClass+" bg-surface2 font-semibold "+alignment(align??node?.properties.align??style?.textAlign)}>{children}</th>,
 td:({children,align,style,node})=>{
  const label=node?.properties.dataCafeColumn;
  const wide=typeof label==="string";
  return <td role="cell" className={cellClass+" "+alignment(align??node?.properties.align??style?.textAlign)+(wide?" "+wideResponseCellClass:"")}>
   {wide&&<span aria-hidden="true" className={wideResponseLabelClass}>{label}</span>}{wide?<div className="min-w-0 wrap-anywhere">{children}</div>:children}
  </td>;
 },
 h1:({children})=><h2 className={headingClass+" text-xl"}>{children}</h2>,
 h2:({children})=><h3 className={headingClass+" text-[1.1875rem]"}>{children}</h3>,
 h3:({children})=><h4 className={headingClass+" text-[1.0625rem]"}>{children}</h4>,
 h4:({children})=><h5 className={headingClass+" text-[1.0625rem]"}>{children}</h5>,
 h5:({children})=><h6 className={headingClass+" text-[1.0625rem]"}>{children}</h6>,
 h6:({children})=><h6 className={headingClass+" text-[1.0625rem]"}>{children}</h6>,
 p:({children})=><p className="whitespace-pre-line wrap-break-word">{children}</p>,
 strong:({children})=><strong className="font-bold">{children}</strong>,
 ul:({children})=><ul className="list-disc space-y-1 ps-6">{children}</ul>,
 ol:({children,start})=><ol start={start} className="list-decimal space-y-1 ps-6">{children}</ol>,
 li:({children,value,className,node})=><li value={value??(typeof node?.properties.value==="number"?node.properties.value:undefined)} className={className?.includes("task-list-item")?"list-none ps-1":"ps-1"}>{children}</li>,
 input:({checked})=><input type="checkbox" checked={checked===true} disabled className="me-2 align-middle accent-current"/>,
 a:({href,children})=>href&&/^https?:\/\//iu.test(href)?<a href={href} target="_blank" rel="noopener noreferrer" className="underline text-accent-text">{children}</a>:<span>{children}</span>,
 img:({alt})=><span>{alt}</span>,
 pre:({children})=><pre className="max-w-full overflow-x-auto rounded-lg bg-surface2 p-3 text-sm">{children}</pre>,
 code:({children})=><code className="rounded-sm bg-surface2 px-1">{children}</code>,
 inlineCode:({children})=><code className="rounded-sm bg-surface2 px-1">{children}</code>,
 blockquote:({children})=><blockquote className="border-s-2 border-line ps-3 text-ink-muted">{children}</blockquote>,
 hr:()=> <hr className="border-line"/>,
 span:({children,node})=>{
  const source=node?.properties.dataCafeSource,label=node?.properties.dataCafeLabel;
  return (source==="owner"||source==="estimate"||source==="unchecked")&&typeof label==="string"?
   <span className="whitespace-nowrap"><SourceUnderline tone={source} label={label}>{children}</SourceUnderline></span>:<span>{children}</span>;
 },
};
// Keep library sanitation, but do not parse model-authored raw HTML. Its
// native remark escape plugin preserves unsupported HTML as literal text.
const safeRehype=[defaultRehypePlugins.sanitize,defaultRehypePlugins.harden];
const safeUrl=(url:string,key:string)=>key==="href"&&/^https?:\/\//iu.test(url)?url:undefined;
/** Adapt historical model tables to GFM without changing stored prose. Insert
 * only missing table separators/pipe escapes; translate provenance offsets. */
function normalizeTableMarkdown(text:string,spans:readonly Verification[]){
 const lines=text.split("\n"),insertions:{at:number;value:string}[]=[];
 const delimiter=(line:string)=>/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u.test(line)&&line.includes("|");
 let offset=0,inTable=false,fence:{char:string;length:number}|null=null;
 for(let i=0;i<lines.length;i++){
  const line=lines[i],opening=/^ {0,3}(\x60{3,}|~{3,})/u.exec(line);
  if(opening){
   const token=opening[1];
   if(!fence)fence={char:token[0],length:token.length};
   else if(token[0]===fence.char&&token.length>=fence.length&&line.slice(opening[0].length).trim()==="")fence=null;
   inTable=false;
  }else if(!fence){
   const header=line.includes("|")&&delimiter(lines[i+1]??"");
   if(header){if(inTable)insertions.push({at:offset,value:"\n"});inTable=true;}
   else if(!line.trim()||/^ {0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s)/u.test(line))inTable=false;
   // GFM requires pipe escaping even inside inline code in a table cell.
   if(inTable){
    for(const match of line.matchAll(/(?<!\x60)(\x60+)(?!\x60)([^\r\n]*?)\1(?!\x60)/gu)){
     const start=match.index+match[1].length;
     for(let j=0;j<match[2].length;j++)if(match[2][j]==="|"){
      let backslashes=0;
      for(let k=j-1;k>=0&&match[2][k]==="\\";k--)backslashes++;
      if(backslashes%2===0)insertions.push({at:offset+start+j,value:"\\"});
     }
    }
   }
  }
  offset+=line.length+1;
 }
 if(!insertions.length)return {text,spans};
 let normalized="",cursor=0;
 for(const item of insertions){normalized+=text.slice(cursor,item.at)+item.value;cursor=item.at;}
 normalized+=text.slice(cursor);
 const shift=(at:number,inclusive:boolean)=>at+insertions.reduce((n,item)=>n+(item.at<at||inclusive&&item.at===at?item.value.length:0),0);
 return {text:normalized,spans:spans.map(span=>({...span,start:shift(span.start,true),end:shift(span.end,false)}))};
}
function MarkdownSegment({text,options,streaming}:{text:string;options:MarkOptions;streaming:boolean}){
 const normalized=normalizeTableMarkdown(text,options.spans);
 const rehypePlugins=[...safeRehype,[sourceAnnotationPlugin,{...options,spans:normalized.spans}] as [typeof sourceAnnotationPlugin,MarkOptions]];
 return <Streamdown mode={streaming?"streaming":"static"} isAnimating={streaming}
   dir={options.locale==="ar"?"rtl":"auto"} controls={false} components={components}
   rehypePlugins={rehypePlugins} urlTransform={safeUrl} className="space-y-2 min-w-0 wrap-break-word">{normalized.text}</Streamdown>;
}
export function SourceLegend({sources,labels,legendLabel="Number sources"}:{
 sources:readonly ("owner"|"estimate"|"unchecked")[];labels:ProvenanceLabels;legendLabel?:string;
}){
 const used=(["owner","estimate","unchecked"] as const).filter(source=>sources.includes(source));
 return used.length>0?<p className="flex flex-wrap gap-x-3 gap-y-1 text-[0.875rem] leading-relaxed text-ink-muted" aria-label={legendLabel}>
  {used.map(source=><span key={source} className="inline-flex items-center gap-1">
   <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tones[source]}`}/>{labels[source]}
  </span>)}
 </p>:null;
}

/** Historical replies used one exact disclosure marker. Preserve those saved
 * messages; all actual Markdown is rendered by Streamdown. */
function legacySections(text:string){
 const sections:{start:number;end:number;details:boolean}[]=[];
 const pattern=/^<details>\r?\n<summary>How I got this<\/summary>\r?\n([\s\S]*?)^<\/details>[ \t]*(?:\r?\n|$)/gmu;
 let cursor=0;
 for(const match of text.matchAll(pattern)){
  if(match.index<cursor)continue;
  if(match.index>cursor)sections.push({start:cursor,end:match.index,details:false});
  let start=match.index+match[0].indexOf("\n",match[0].indexOf("</summary>"))+1;
  let end=start+match[1].length;
  cursor=match.index+match[0].length;
  if(!text.slice(start,end).trim()){
   const next=text.slice(cursor).match(/^\s*([^\r\n]+(?:\r?\n[^\r\n]+)*)/u);
   if(next){start=cursor+next[0].indexOf(next[1]);end=start+next[1].length;cursor=end;}
  }
  if(end>start)sections.push({start,end,details:true});
 }
 if(cursor<text.length)sections.push({start:cursor,end:text.length,details:false});
 return sections;
}
export function ChatMarkdown({text,unverified=[],label,labels,locale="en",showLegend=true,legendLabel,compact=false,streaming=false}:{
 text:string;unverified?:readonly Verification[];label?:string;labels?:ProvenanceLabels;locale?:Locale;
 showLegend?:boolean;legendLabel?:string;compact?:boolean;streaming?:boolean;
}){
 const copy=labels??{owner:"You told me",estimate:"Estimate",unchecked:label??"Not checked against your records"};
 const spans=[...unverified].filter(s=>Number.isSafeInteger(s.start)&&Number.isSafeInteger(s.end)&&s.start>=0&&s.end>s.start&&s.end<=text.length)
  .sort((a,b)=>a.start-b.start).filter((s,i,all)=>i===0||s.start>=all[i-1].end);
 return <div data-testid="supervisor-answer-prose" className={compact?"space-y-1 min-w-0 wrap-break-word text-[0.9375rem] leading-snug text-ink-muted":"space-y-2 min-w-0 wrap-break-word text-[1.0625rem] leading-relaxed text-ink"}>
  {legacySections(text).map(section=>{
   const options:MarkOptions={locale,labels:copy,spans:spans.filter(s=>s.start<section.end&&s.end>section.start)
    .map(s=>({...s,start:s.start-section.start,end:s.end-section.start}))};
   const body=<MarkdownSegment text={text.slice(section.start,section.end)} options={options} streaming={streaming&&!spans.length}/>;
   return section.details?<details key={section.start} className="rounded-xl border border-line bg-surface2 text-ink">
    <summary className="min-h-12 cursor-pointer rounded-xl px-4 py-3 font-semibold focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ink">{({en,es,ar}[locale]).SupervisorChat.howIGotThis}</summary>
    <div className="space-y-2 border-t border-line px-4 py-3">{body}</div>
   </details>:<div key={section.start} className="min-w-0">{body}</div>;
  })}
  {showLegend&&<SourceLegend sources={spans.map(s=>s.source??"unchecked")} labels={copy} legendLabel={legendLabel}/>}
 </div>;
}
