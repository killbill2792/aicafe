"use client";

import {useEffect,useRef} from "react";
import {usePathname} from "next/navigation";
import {perfDestinationRoute,perfRoute,rscStats,TRACE_COOKIE,type NavMetric,type PerfRoute} from "@/lib/perf/navigationMetrics";

const RATE=0.1;
const TIMEOUT=15000;
type Pending={
  route:PerfRoute;action:"link"|"period"|"money-view";targetPath:string;selected?:string;
  start:number;trace:string;feedbackMs:number|null;pendingMs:number|null;
  committed:boolean;target:Element;observer:MutationObserver;timeout:number;
};
function device():NavMetric["device"] {
  return window.matchMedia("(min-width: 768px)").matches?"desktop":"phone";
}
function send(event:NavMetric) {
  navigator.sendBeacon?.("/api/perf/navigation",
    new Blob([JSON.stringify(event)],{type:"application/json"}));
}
function stats(start:number) {
  return rscStats(performance.getEntriesByType("resource") as PerformanceResourceTiming[],
    start,performance.now(),window.location.origin);
}
function clearTrace() {
  document.cookie=TRACE_COOKIE+"=; Max-Age=0; Path=/; SameSite=Lax";
}

/** Observes existing app navigation. No router calls, business reads or navigation changes. */
export default function NavigationTiming() {
  const path=usePathname();
  const pending=useRef<Pending|null>(null);
  const check=useRef<()=>void>(()=>{});

  useEffect(()=>{
    function finish(p:Pending,status:NavMetric["status"]) {
      if(pending.current!==p)return;
      pending.current=null;
      p.observer.disconnect();
      window.clearTimeout(p.timeout);
      const event:NavMetric={route:p.route,action:p.action,session:"client",device:device(),status,
        trace:p.trace,feedbackMs:p.feedbackMs,pendingMs:p.pendingMs,
        usableMs:status==="usable"?Math.round(performance.now()-p.start):null,...stats(p.start)};
      send(event);
      if(status==="usable"&&p.route==="home"&&document.querySelector('[data-testid="chat-start"]'))
        send({...event,route:"chat-start"});
      clearTrace();
    }
    function checkReady() {
      const p=pending.current;
      if(!p)return;
      const elapsed=Math.round(performance.now()-p.start);
      if(document.querySelector("main[data-perf-loading]")) {
        p.feedbackMs??=elapsed;
        p.pendingMs??=elapsed;
      }
      if(!document.querySelector("main[data-perf-ready]"))return;
      if(p.action==="link") {
        if(!p.committed||window.location.pathname!==p.targetPath)return;
      } else {
        const selected=document.querySelectorAll<HTMLElement>("[data-perf-nav][aria-pressed=true]");
        if(![...selected].some(el=>el.dataset.perfNav===p.action&&el.dataset.perfValue===p.selected))return;
      }
      window.requestAnimationFrame(()=>finish(p,"usable"));
    }
    check.current=checkReady;
    function click(event:MouseEvent) {
      if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||
        event.shiftKey||event.altKey||!(event.target instanceof Element))return;
      const button=event.target.closest<HTMLElement>("[data-perf-nav]");
      const link=button?null:event.target.closest<HTMLAnchorElement>("a[href]");
      if(!button&&!link)return;
      const action=button?.dataset.perfNav??"link";
      if(action!=="link"&&action!=="period"&&action!=="money-view")return;
      if(button?.getAttribute("aria-pressed")==="true")return;
      let targetPath=window.location.pathname;
      let route=perfDestinationRoute(targetPath,new URLSearchParams(window.location.search).get("view"),
        action,button?.dataset.perfValue);
      if(link) {
        const to=new URL(link.href,window.location.href);
        if(to.origin!==window.location.origin||to.pathname===targetPath)return;
        targetPath=to.pathname;
        route=perfRoute(to.pathname,to.searchParams.get("view"));
      }
      if(!route)return;
      if(pending.current) {
        pending.current.observer.disconnect();
        window.clearTimeout(pending.current.timeout);
        pending.current=null;
      }
      if(Math.random()>=RATE) {clearTrace();return;}
      const trace=crypto.randomUUID().replace(/-/g,"").slice(0,16);
      document.cookie=TRACE_COOKIE+"="+trace+"; Max-Age=30; Path=/; SameSite=Lax"+
        (location.protocol==="https:"?"; Secure":"");
      const p:Pending={
        route,action,targetPath,selected:button?.dataset.perfValue,
        start:performance.now(),trace,feedbackMs:null,pendingMs:null,committed:false,
        target:button??link!,timeout:0,observer:new MutationObserver(changes=>{
          if(pending.current!==p)return;
          if(changes.some(change=>change.type==="attributes"&&change.target===p.target))
            p.feedbackMs??=Math.round(performance.now()-p.start);
          checkReady();
        }),
      };
      pending.current=p;
      p.observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,
        attributeFilter:["aria-current","aria-pressed","class","data-perf-loading","data-perf-ready"]});
      p.timeout=window.setTimeout(()=>finish(p,"timeout"),TIMEOUT);
    }
    document.addEventListener("click",click,true);
    return ()=>{
      document.removeEventListener("click",click,true);
      if(pending.current) {
        pending.current.observer.disconnect();
        window.clearTimeout(pending.current.timeout);
        pending.current=null;
      }
    };
  },[]);

  useEffect(()=>{
    const p=pending.current;
    if(p?.action==="link"&&path===p.targetPath) {
      p.committed=true;
      check.current();
    }
  },[path]);

  // Cold document load uses the browser navigation entry rather than adding a fetch.
  useEffect(()=>{
    if(Math.random()>=RATE)return;
    const candidate=perfRoute(window.location.pathname,new URLSearchParams(window.location.search).get("view"));
    if(!candidate)return;
    const route:PerfRoute=candidate;
    let recorded=false;
    const observer=new MutationObserver(()=>ready());
    function ready() {
      if(recorded||!document.querySelector("main[data-perf-ready]"))return;
      recorded=true;
      window.requestAnimationFrame(()=>{
        const nav=performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming|undefined;
        const event={
          action:"initial" as const,session:"document" as const,device:device(),
          status:"usable" as const,feedbackMs:null,pendingMs:null,
          usableMs:Math.round(performance.now()),rscRequests:0,
          ttfbMs:nav&&nav.responseStart>=nav.startTime
            ?Math.round(nav.responseStart-nav.startTime):null,
        };
        send({...event,route});
        if(route==="home"&&document.querySelector('[data-testid="chat-start"]'))
          send({...event,route:"chat-start"});
      });
      observer.disconnect();
    }
    observer.observe(document.documentElement,{subtree:true,childList:true});
    ready();
    const timer=window.setTimeout(()=>observer.disconnect(),TIMEOUT);
    return ()=>{observer.disconnect();window.clearTimeout(timer);};
  },[]);

  return null;
}
