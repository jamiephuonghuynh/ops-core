import { sha256HexBytes } from "../../artifacts/service";
import { getResource } from "../../db/resources";
import { readSheetHeaders } from "../../google/sheets";
import type { Env, GoogleCellValue } from "../../types";
import type { Task001FieldMapping } from "./definition";
import { normalize, type StandardRow } from "./geo";

export async function hashStandardRow(row: StandardRow, fields: string[]): Promise<string> {
  const canonical = JSON.stringify(fields.filter((f) => f !== "requested_at").map((field) => normalize(row[field])));
  return sha256HexBytes(new TextEncoder().encode(canonical).buffer as ArrayBuffer);
}

export async function buildPhysicalRowsForGoogleSheet(env: Env, resourceId: string, mappings: Task001FieldMapping[], rows: StandardRow[]): Promise<{ headers: GoogleCellValue[]; rows: GoogleCellValue[][] }> {
  const resource = await getResource(env, resourceId);
  if (!resource || resource.resource_type !== "GOOGLE_SHEET" || resource.provider !== "GOOGLE" || !resource.external_id) throw new Error(`TASK001_OUTPUT_RESOURCE_INVALID:${resourceId}`);
  let metadata: { sheetName: string; headerRow?: number };
  try { metadata = JSON.parse(resource.metadata_json) as { sheetName: string; headerRow?: number }; }
  catch { throw new Error(`TASK001_OUTPUT_RESOURCE_METADATA_INVALID:${resourceId}`); }
  const headers = await readSheetHeaders(env, resource.external_id, metadata.sheetName, metadata.headerRow ?? 1);
  const byHeader = new Map(mappings.map((m) => [normalize(m.sourceField), m.standardField]));
  const physicalRows = rows.map((row) => headers.map((header) => {
    const standardField = byHeader.get(normalize(header));
    if (!standardField) return "";
    const value = row[standardField];
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    return String(value);
  }));
  return { headers, rows: physicalRows };
}
