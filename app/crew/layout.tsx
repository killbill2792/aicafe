import type {Metadata} from "next";
import "../globals.css";
export const metadata:Metadata={title:"My work | AI CAFE",robots:{index:false,follow:false}};
/** Separate root layout: workers never load owner navigation or Supervisor. */
export default function CrewLayout({children}:{children:React.ReactNode}){
 return <html lang="en"><body className="min-h-screen bg-paper text-ink">
  <main className="mx-auto w-full max-w-2xl px-4 py-8">{children}</main>
 </body></html>;
}
