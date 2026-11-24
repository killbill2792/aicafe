/** Validate the U3 restricted PostgreSQL connection BEFORE opening a pool.
 * A Supabase pooler uses username role.project-ref while PG current_user is
 * still the restricted role. Never accept an admin/service-role connection. */
export function validateResearchConnection(raw:string,publicSupabaseUrl:string|undefined):URL{
  let url:URL;
  try{url=new URL(raw);}catch{throw Error("research_connection_untrusted");}
  let projectRef:string|null=null;
  try{
    const host=new URL(publicSupabaseUrl??"").hostname.toLowerCase();
    const match=/^([a-z0-9]{8,40})\.supabase\.co$/u.exec(host);
    projectRef=match?.[1]??null;
  }catch{ /* Local disposable test credentials have no public project URL. */ }
  const hostname=url.hostname.toLowerCase();
  const username=decodeURIComponent(url.username);
  const pooler=/^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(hostname);
  const localTest=process.env.NODE_ENV==="test"&&
    ["127.0.0.1","localhost"].includes(hostname);
  const direct=projectRef!==null&&hostname===`db.${projectRef}.supabase.co`;
  const validUser=pooler?
    (projectRef!==null&&username===`aicafe_research.${projectRef}`):
    username==="aicafe_research";
  // All external research connections require TLS. A disposable local test
  // database may connect without SSL; never allow that in production.
  const tls=url.searchParams.get("sslmode");
  const sslVerified=["require","verify-full"].includes(tls??"");
  if(!["postgres:","postgresql:"].includes(url.protocol)||
    !url.password||!validUser||!(pooler||direct||localTest)||
    url.pathname!=="/postgres"||url.hash||
    (localTest?url.searchParams.size>0:
      url.searchParams.size!==1||!sslVerified)||
    (pooler&&!["5432","6543"].includes(url.port)))
    throw Error("research_connection_untrusted");
  return url;
}
