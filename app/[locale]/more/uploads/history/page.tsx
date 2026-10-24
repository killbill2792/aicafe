import { redirect } from "next/navigation";

// Keep old bookmarks working; the history now lives under the uploads hub.
export default function UploadHistoryPage() {
  redirect("/more/uploads#upload-history");
}
