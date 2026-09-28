/** Reads an uploaded file as CSV text — .csv as-is, .xlsx/.xls converted (first sheet) to CSV
 * text via SheetJS, so every existing CSV parser (column detection, sales/labor/statement
 * parsing) works unchanged for either file type. `xlsx` is loaded lazily so the ~1MB parser
 * never ships in the main bundle for owners who only ever upload CSV. */
export async function readUploadedFileAsCsvText(file: File): Promise<string> {
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);
  if (!isExcel) return file.text();

  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_csv(sheet);
}

export const UPLOAD_FILE_ACCEPT =
  ".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";
