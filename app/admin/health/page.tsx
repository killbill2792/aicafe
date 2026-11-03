import {readDataHealth} from "@/lib/data/dataHealth.server";
import {describeFinding,megabytes} from "@/lib/admin/dataHealth";
export const dynamic="force-dynamic";
export default async function AdminDataHealth(){
  const {days,cafeNames}=await readDataHealth();
  const name=(id:string)=>cafeNames[id]??id;
  return <div className="space-y-6"><header><h1 className="text-2xl font-bold">Data health</h1>
    <p className="text-sm text-slate-600">Checked daily: database size against the plan, sudden growth, Toast records stored more than once, and café-day totals that do not match (last 30 days). UTC days.</p></header>
    {!days.length&&<p>No checks yet. The first one runs with the daily cron.</p>}
    {days.map(day=>{
      const problems=day.findings.length+day.unknownFindings;
      return <section key={day.checkedOn} className="rounded-xl border bg-white p-5 space-y-2">
        <h2 className="font-semibold">{day.checkedOn} · {problems?`${problems} problem${problems===1?"":"s"}`:"No problems"}</h2>
        <p className="text-sm">Database {megabytes(day.databaseBytes)} of {megabytes(day.planBytes)} ({Math.round(day.databaseBytes/day.planBytes*100)}%).
          Largest: {day.largestTables.slice(0,4).map(t=>`${t.table} ${megabytes(t.bytes)}`).join(", ")}</p>
        {problems>0&&<ul className="list-disc pl-5 text-sm">
          {day.findings.map((f,i)=><li key={i}>{describeFinding(f,name)}</li>)}
          {day.unknownFindings>0&&<li>{day.unknownFindings} other problem(s) of a type this page does not know yet.</li>}
        </ul>}
      </section>;
    })}
  </div>;
}
