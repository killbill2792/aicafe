"use client";

import { useState, useTransition } from "react";
import { Camera, Trash2 } from "lucide-react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { removeProductPhoto, saveProductPhoto } from "@/lib/actions/menuItems";
import { useRouter } from "@/i18n/navigation";
import type { ProductPhoto } from "@/lib/data/getProductPhoto";

export default function ProductPhotoEditor({ menuItemId, businessId, photo, labels }: { menuItemId: string; businessId: string | null; photo: ProductPhoto; labels: { photo: string; change: string; remove: string; error: string } }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  async function upload(file: File) {
    if (!businessId || !/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) { setError(labels.error); return; }
    setError(null);
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `${businessId}/${crypto.randomUUID()}.${ext}`;
    const supabase = createBrowserSupabaseClient();
    const { error: uploadError } = await supabase.storage.from("product-photos").upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) { setError(labels.error); return; }
    startTransition(async () => {
      const result = await saveProductPhoto({ menuItemId, storagePath: path });
      if (!result.ok) { await supabase.storage.from("product-photos").remove([path]); setError(result.error); return; }
      router.refresh();
    });
  }
  function remove() { startTransition(async () => { const result = await removeProductPhoto(menuItemId); if (result.ok) router.refresh(); else setError(result.error); }); }
  return <div className="relative min-h-40 overflow-hidden rounded-2xl bg-[#E9DDCE]">
    {photo ? <img src={photo.signedUrl} alt={labels.photo} className="h-48 w-full object-cover" /> : <div className="flex h-40 items-center justify-center text-ink-muted"><Camera aria-hidden="true" size={42} /></div>}
    <div className="absolute inset-x-2 bottom-2 flex gap-2">
      <label className="flex min-h-12 cursor-pointer items-center justify-center rounded-full bg-card/95 px-4 text-sm font-bold text-ink shadow-sm"><Camera aria-hidden="true" className="me-2" size={17}/>{photo ? labels.change : labels.photo}<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={pending} onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.currentTarget.value = ""; }} /></label>
      {photo && <button type="button" onClick={remove} disabled={pending} className="flex min-h-12 items-center rounded-full bg-card/95 px-4 text-sm font-bold text-warn"><Trash2 aria-hidden="true" className="me-2" size={17}/>{labels.remove}</button>}
    </div>
    {error && <p className="absolute inset-x-2 top-2 rounded-lg bg-card p-2 text-sm font-semibold text-warn">{error}</p>}
  </div>;
}
