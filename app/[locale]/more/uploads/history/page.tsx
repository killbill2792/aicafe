import { redirect } from "@/i18n/navigation";

export default async function UploadHistoryPage({params}: {params:Promise<{locale:string}>}) {
  const {locale} = await params;
  redirect({href:"/more/uploads#upload-history",locale});
}
