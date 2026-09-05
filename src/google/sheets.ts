import { GOOGLE_SHEETS_BASE_URL } from "../config";
import { sha256HexBytes } from "../artifacts/service";
import type { Env, GoogleCellValue, NormalizedGoogleSheet } from "../types";
import { googleFetch, mapGoogleError } from "./http";
import { getGoogleAccessToken } from "./auth";

interface SpreadsheetMeta {
  spreadsheetId?: string;
  properties?: { title?: string };
  sheets?: Array<{ properties?: { sheetId?: number; title?: string; gridProperties?: Record<string, number> } }>;
}

interface ValuesResponse { range?: string; majorDimension?: string; values?: unknown[][] }
interface AppendResponse { spreadsheetId?: string; tableRange?: string; updates?: { updatedRange?: string; updatedRows?: number; updatedColumns?: number; updatedCells?: number } }

export function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export function buildA1Range(sheetName: string, range: string): string {
  const clean = (range || "A:ZZZ").trim();
  if (clean.includes("!")) return clean;
  return `${quoteSheetName(sheetName)}!${clean}`;
}

function normalizeCell(value: unknown): GoogleCellValue {
  if (value === null || value === undefined || value === "") return value === "" ? "" : null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function trimTrailingEmptyRows(rows: GoogleCellValue[][]): GoogleCellValue[][] {
  let end = rows.length;
  const isEmpty = (row: GoogleCellValue[]) => row.every((v) => v === null || v === "");
  while (end > 0 && isEmpty(rows[end - 1])) end -= 1;
  return rows.slice(0, end);
}

export async function getSpreadsheetSheetMetadata(env: Env, spreadsheetId: string, sheetName: string): Promise<{ spreadsheetTitle: string | null; sheetId: number | null; sheetTitle: string; gridProperties: Record<string, number> | null }> {
  const fields = encodeURIComponent("spreadsheetId,properties.title,sheets.properties(sheetId,title,gridProperties)");
  const url = `${GOOGLE_SHEETS_BASE_URL}/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${fields}`;
  const result = await googleFetch<SpreadsheetMeta>(env, url);
  if (!result.response.ok) {
    const mapped = mapGoogleError(result.response.status, "SHEETS_READ");
    throw Object.assign(new Error(mapped.message), { googleMapped: mapped, providerText: result.text.slice(0, 500) });
  }
  const sheet = result.data?.sheets?.find((s) => s.properties?.title === sheetName);
  if (!sheet?.properties?.title) {
    throw Object.assign(new Error("Google Sheet tab was not found"), { googleMapped: { status: 404, error: "GOOGLE_RESOURCE_NOT_FOUND", message: "Google Sheet tab was not found" } });
  }
  return {
    spreadsheetTitle: result.data?.properties?.title ?? null,
    sheetId: sheet.properties.sheetId ?? null,
    sheetTitle: sheet.properties.title,
    gridProperties: sheet.properties.gridProperties ?? null,
  };
}

export async function readNormalizedSheet(env: Env, spreadsheetId: string, sheetName: string, range: string, headerRow = 1): Promise<NormalizedGoogleSheet> {
  const a1 = buildA1Range(sheetName, range);
  const encodedRange = encodeURIComponent(a1);
  const url = `${GOOGLE_SHEETS_BASE_URL}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
  const result = await googleFetch<ValuesResponse>(env, url);
  if (!result.response.ok) {
    const mapped = mapGoogleError(result.response.status, "SHEETS_READ");
    throw Object.assign(new Error(mapped.message), { googleMapped: mapped, providerText: result.text.slice(0, 500) });
  }
  const raw = (result.data?.values ?? []).map((row) => row.map(normalizeCell));
  const headerIndex = Math.max(0, headerRow - 1);
  const headersRaw = raw[headerIndex] ?? [];
  const bodyRaw = trimTrailingEmptyRows(raw.slice(headerIndex + 1));
  const columnCount = Math.max(headersRaw.length, ...bodyRaw.map((r) => r.length), 0);
  const pad = (row: GoogleCellValue[]) => Array.from({ length: columnCount }, (_, i) => i < row.length ? row[i] : null);
  const headers = pad(headersRaw);
  const rows = bodyRaw.map(pad);
  const canonicalJson = JSON.stringify({ headers, rows });
  const snapshotHash = await sha256HexBytes(new TextEncoder().encode(canonicalJson).buffer as ArrayBuffer);
  return { headers, rows, rowCount: rows.length, columnCount, fetchedAt: new Date().toISOString(), snapshotHash, canonicalJson };
}

export async function appendSheetRows(env: Env, spreadsheetId: string, sheetName: string, range: string, rows: GoogleCellValue[][]): Promise<{ updatedRange: string | null; updatedRows: number; providerReference: string | null }> {
  const a1 = buildA1Range(sheetName, range);
  const url = `${GOOGLE_SHEETS_BASE_URL}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false`;
  const { accessToken } = await getGoogleAccessToken(env);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ majorDimension: "ROWS", values: rows }),
    });
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
      googleMapped: { status: 502, error: "GOOGLE_PROVIDER_TIMEOUT", message: "Google append result is ambiguous after a network failure" },
      requestMayHaveBeenSent: true,
    });
  }
  const text = await response.text();
  let data: AppendResponse | null = null;
  if (text) { try { data = JSON.parse(text) as AppendResponse; } catch { data = null; } }
  if (!response.ok) {
    const mapped = mapGoogleError(response.status, "SHEETS_APPEND");
    throw Object.assign(new Error(mapped.message), { googleMapped: mapped, providerText: text.slice(0, 500), requestMayHaveBeenSent: false });
  }
  const updatedRange = data?.updates?.updatedRange ?? null;
  return { updatedRange, updatedRows: Number(data?.updates?.updatedRows ?? rows.length), providerReference: updatedRange ?? data?.tableRange ?? null };
}

export async function readSheetHeaders(env: Env, spreadsheetId: string, sheetName: string, headerRow = 1): Promise<GoogleCellValue[]> {
  const a1 = `${quoteSheetName(sheetName)}!${headerRow}:${headerRow}`;
  const url = `${GOOGLE_SHEETS_BASE_URL}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
  const result = await googleFetch<ValuesResponse>(env, url);
  if (!result.response.ok) {
    const mapped = mapGoogleError(result.response.status, "SHEETS_READ");
    throw Object.assign(new Error(mapped.message), { googleMapped: mapped, providerText: result.text.slice(0, 500) });
  }
  return (result.data?.values?.[0] ?? []).map(normalizeCell);
}
