"use client";

import {useState} from "react";
import SavedEventsCard from "./SavedEventsCard";

/** Development-only browser acceptance fixture, never imported by a production
 * event route. Real reads remain in the existing authenticated Events API. */
export default function EventsVisualFixture({locale}:{locale:"en"|"es"|"ar"}){
  const [handoff,setHandoff]=useState<null|{
    date:string;title:string;eventId?:string;cityEventId?:string;
    existingThreadId?:string;draftPrompt?:string;
  }>(null);
  return <section className="mx-auto w-full max-w-4xl space-y-5 p-4">
    <h1 className="font-headline text-2xl font-bold">Events acceptance fixture</h1>
    <SavedEventsCard locale={locale} chatDisabled={false}
      onChatAboutDay={(date,title,eventId,existingThreadId,cityEventId,draftPrompt)=>
        setHandoff({date,title,eventId,existingThreadId,cityEventId,draftPrompt})}/>
    {handoff&&<output data-testid="events-visual-handoff" className="block break-words rounded-xl bg-surface2 p-4">
      {JSON.stringify(handoff)}
    </output>}
  </section>;
}
