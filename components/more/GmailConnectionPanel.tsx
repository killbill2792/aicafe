"use client";
import {useEffect,useState} from "react";
import {Mail,ShieldCheck,CheckCircle2,AlertTriangle} from "lucide-react";
import {useLocale} from "next-intl";

type Status={status:"active"|"needs_reconnect"|"revoking"|"disconnected";configured:boolean;
  email:string|null;permissions:{read:boolean;draft:boolean;send:boolean;organize:boolean}};
export const gmailCopy={
  en:{
  "title": "Gmail",
  "subtitle": "Connect your email securely to Supervisor",
  "mailboxTitle": "Your Gmail account",
  "mailboxSubtitle": "One connection. A more capable Supervisor.",
  "loading": "Checking your Gmail connection…",
  "connected": "Connected and ready",
  "notConnected": "Not connected",
  "reconnectRequired": "Please reconnect to keep using Gmail",
  "revoking": "Disconnected from AI CAFE. Finishing Google's revocation.",
  "googleConsent": "Choose your Google account and approve access. No API keys or passwords are required.",
  "permissions": "Your Gmail connection is private to your café and owner account.",
  "canDo": "Supervisor can search mail, read conversations, prepare replies and organize messages.",
  "ownerApproves": "Every draft creation, send or mailbox change requires your approval.",
  "connect": "Connect Gmail",
  "reconnect": "Reconnect Gmail",
  "disconnect": "Disconnect Gmail",
  "disconnectConfirm": "Disconnect this Gmail account from AI CAFE? Your existing emails remain in Gmail.",
  "disconnecting": "Disconnecting…",
  "retryRevoke": "Retry Google revocation",
  "revokePending": "AI CAFE access is blocked. Google's revocation is pending; please retry.",
  "statusUnavailable": "Gmail connection status is unavailable. Please refresh.",
  "connectionFailed": "Google connection was not completed. Please try again.",
  "notConfigured": "Gmail is not enabled for this AI CAFE deployment yet.",
  "disconnectHint": "Disconnecting never deletes messages from your Gmail mailbox."
},
  es:{
  "title": "Gmail",
  "subtitle": "Conecta tu correo de forma segura con Supervisor",
  "mailboxTitle": "Tu cuenta de Gmail",
  "mailboxSubtitle": "Una conexión. Un Supervisor más útil.",
  "loading": "Comprobando la conexión de Gmail…",
  "connected": "Conectado y listo",
  "notConnected": "Sin conectar",
  "reconnectRequired": "Vuelve a conectar Gmail para seguir usándolo",
  "revoking": "Acceso de AI CAFE desconectado. Finalizando la revocación en Google.",
  "googleConsent": "Elige tu cuenta de Google y autoriza el acceso. No necesitas contraseñas ni claves API.",
  "permissions": "Tu conexión de Gmail es privada para tu cafetería y tu cuenta de propietario.",
  "canDo": "Supervisor puede buscar correos, leer conversaciones, preparar respuestas y organizar mensajes.",
  "ownerApproves": "Crear borradores, enviar o cambiar mensajes siempre requiere tu aprobación.",
  "connect": "Conectar Gmail",
  "reconnect": "Reconectar Gmail",
  "disconnect": "Desconectar Gmail",
  "disconnectConfirm": "¿Desconectar Gmail de AI CAFE? Tus correos seguirán en Gmail.",
  "disconnecting": "Desconectando…",
  "retryRevoke": "Reintentar revocación",
  "revokePending": "El acceso de AI CAFE está bloqueado. La revocación en Google sigue pendiente; vuelve a intentarlo.",
  "statusUnavailable": "No se puede consultar el estado de Gmail. Actualiza la página.",
  "connectionFailed": "La conexión de Google no se completó. Inténtalo de nuevo.",
  "notConfigured": "Gmail todavía no está habilitado para esta instalación de AI CAFE.",
  "disconnectHint": "Desconectar Gmail nunca borra tus mensajes."
},
  ar:{
  "title": "Gmail",
  "subtitle": "اربط بريدك الإلكتروني بأمان مع المشرف",
  "mailboxTitle": "حساب Gmail الخاص بك",
  "mailboxSubtitle": "اتصال واحد. مشرف أكثر قدرة.",
  "loading": "جارٍ التحقق من اتصال Gmail…",
  "connected": "متصل وجاهز",
  "notConnected": "غير متصل",
  "reconnectRequired": "أعِد ربط Gmail لمتابعة استخدامه",
  "revoking": "تم إيقاف وصول AI CAFE. جارٍ إكمال إلغاء الإذن لدى Google.",
  "googleConsent": "اختر حساب Google ووافق على الوصول. لا حاجة إلى كلمات مرور أو مفاتيح API.",
  "permissions": "اتصال Gmail خاص بمقهاك وحساب المالك.",
  "canDo": "يستطيع المشرف البحث في الرسائل وقراءة المحادثات وتجهيز الردود وتنظيم البريد.",
  "ownerApproves": "إنشاء مسودة أو إرسال رسالة أو تغيير البريد يتطلب موافقتك في كل مرة.",
  "connect": "ربط Gmail",
  "reconnect": "إعادة ربط Gmail",
  "disconnect": "فصل Gmail",
  "disconnectConfirm": "هل تريد فصل Gmail عن AI CAFE؟ ستبقى رسائلك في Gmail.",
  "disconnecting": "جارٍ الفصل…",
  "retryRevoke": "إعادة محاولة إلغاء الإذن",
  "revokePending": "تم حظر وصول AI CAFE. إلغاء إذن Google لم يكتمل بعد؛ أعِد المحاولة.",
  "statusUnavailable": "تعذّر التحقق من حالة Gmail. حدّث الصفحة.",
  "connectionFailed": "لم يكتمل ربط حساب Google. حاول مجددًا.",
  "notConfigured": "Gmail غير مفعّل لهذا الإصدار من AI CAFE بعد.",
  "disconnectHint": "فصل الحساب لا يحذف أي رسالة من Gmail."
}
} as const;
export default function GmailConnectionPanel(){
  const activeLocale=useLocale();
  const copy=gmailCopy[activeLocale==="es"?"es":activeLocale==="ar"?"ar":"en"];
  const [data,setData]=useState<Status|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const load=async()=>{
    const response=await fetch("/api/connectors/gmail/status",{cache:"no-store"});
    if(!response.ok)throw Error();
    setData(await response.json() as Status);
  };
  useEffect(()=>{let alive=true;
    void fetch("/api/connectors/gmail/status",{cache:"no-store"})
      .then(r=>{if(!r.ok)throw Error();return r.json() as Promise<Status>;})
      .then(x=>{if(alive)setData(x);})
      .catch(()=>{if(alive)setError(copy.statusUnavailable);});
    return ()=>{alive=false;};
  },[]);
  const disconnect=async()=>{
    if(busy||!window.confirm(copy.disconnectConfirm))return;
    setBusy(true);setError("");
    try{
      const response=await fetch("/api/connectors/gmail/disconnect",{
        method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin"});
      await load();
      if(!response.ok)setError(copy.revokePending);
    }catch{setError(copy.revokePending);}
    finally{setBusy(false);}
  };
  const failure=typeof window!=="undefined"?new URLSearchParams(window.location.search).get("error"):null;
  const connected=data?.status==="active"&&Object.values(data.permissions).every(Boolean);
  return <section className="rounded-card-lg border border-line bg-card p-5 text-ink" aria-label={copy.title}>
    <div className="flex items-center gap-3">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft"><Mail aria-hidden="true" size={25}/></span>
      <div className="min-w-0 flex-1"><h2 className="font-headline text-xl font-bold">{copy.mailboxTitle}</h2>
        <p className="text-sm text-ink-muted">{copy.mailboxSubtitle}</p></div>
    </div>
    {!data&&!error?<p role="status" className="mt-5">{copy.loading}</p>:null}
    {connected?<div className="mt-5 flex items-start gap-3 rounded-xl bg-good-tint p-4 text-good">
      <CheckCircle2 aria-hidden="true" size={21}/>
      <div><p className="font-bold">{copy.connected}</p><p className="break-all text-sm">{data!.email}</p></div>
    </div>:data?<div className="mt-5 rounded-xl bg-surface2 p-4 text-ink">
      <p className="font-semibold">{data.status==="revoking"?copy.revoking:
        data.status==="needs_reconnect"?copy.reconnectRequired:copy.notConnected}</p>
      <p className="mt-1 text-sm text-ink-muted">{copy.googleConsent}</p></div>:null}
    <div className="mt-5 grid gap-3 text-sm text-ink-muted">
      <p className="flex gap-2"><ShieldCheck size={18} className="shrink-0"/>{copy.permissions}</p>
      <p>{copy.canDo}</p>
      <p>{copy.ownerApproves}</p>
    </div>
    {(error||failure)&&<p role="alert" className="mt-4 flex gap-2 text-warn">
      <AlertTriangle size={18} className="shrink-0"/>{error||copy.connectionFailed}</p>}
    <div className="mt-6 flex flex-wrap gap-3">
      {!connected&&data?.status!=="revoking"&&data?.configured&&<a
        href="/api/connectors/gmail/connect"
        className="flex min-h-12 items-center justify-center rounded-xl bg-accent px-6 text-base font-bold text-white">
        {data?.status==="needs_reconnect"?copy.reconnect:copy.connect}
      </a>}
      {connected&&<button type="button" onClick={()=>void disconnect()} disabled={busy}
        className="min-h-12 rounded-xl border border-line px-5 text-base font-bold disabled:opacity-50">
        {busy?copy.disconnecting:copy.disconnect}
      </button>}
      {data?.status==="revoking"&&<button type="button" onClick={()=>void disconnect()} disabled={busy}
        className="min-h-12 rounded-xl border border-line px-5 font-bold">{copy.retryRevoke}</button>}
    </div>
    {data&&!data.configured&&<p className="mt-4 text-sm text-warn">{copy.notConfigured}</p>}
    <p className="mt-4 text-xs text-ink-muted">{copy.disconnectHint}</p>
  </section>;
}
