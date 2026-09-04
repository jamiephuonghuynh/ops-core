import * as XLSX from "xlsx";
import { normalize } from "../tasks/task001/geo";

export interface NormalizedWorkbookDataset {
  headers: string[];
  rows: unknown[][];
  rowCount: number;
  columnCount: number;
  worksheetName: string;
}

export function parseFirstWorksheetXlsx(bytes: ArrayBuffer): NormalizedWorkbookDataset {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(new Uint8Array(bytes), { type: "array", cellDates: true, raw: false, dense: false });
  } catch (error) {
    throw new Error(`XLSX_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  const worksheetName = workbook.SheetNames[0];
  if (!worksheetName) return { headers: [], rows: [], rowCount: 0, columnCount: 0, worksheetName: "" };
  const worksheet = workbook.Sheets[worksheetName];
  if (!worksheet) throw new Error("XLSX_PARSE_FAILED: first worksheet is unavailable");
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: false, defval: "", blankrows: false });
  if (!matrix.length) return { headers: [], rows: [], rowCount: 0, columnCount: 0, worksheetName };
  const headers = (matrix[0] ?? []).map(normalize);
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  if (!headers.length) return { headers: [], rows: [], rowCount: 0, columnCount: 0, worksheetName };
  const rows: unknown[][] = [];
  for (const sourceRow of matrix.slice(1)) {
    const row = Array.from({ length: headers.length }, (_, index) => sourceRow[index] ?? "");
    if (row.some((value) => normalize(value) !== "")) rows.push(row);
  }
  return { headers, rows, rowCount: rows.length, columnCount: headers.length, worksheetName };
}
