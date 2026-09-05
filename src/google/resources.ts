import { appendExecutionEvent } from "../db/events";
import { findResourceByCanonicalUri, insertResource } from "../db/resources";
import type { Env, ResourceReferenceRow } from "../types";
import { getDriveFileMetadata } from "./drive";
import { getSpreadsheetSheetMetadata } from "./sheets";

export function googleSheetCanonicalUri(spreadsheetId: string, sheetName: string, range: string): string {
  return `gsheet://${spreadsheetId}/${encodeURIComponent(sheetName)}?range=${encodeURIComponent(range)}`;
}

export async function registerGoogleSheetResource(env: Env, input: { spreadsheetId: string; sheetName: string; range: string; businessUri?: string | null; headerRow?: number }): Promise<{ resource: ResourceReferenceRow; reused: boolean }> {
  const range = (input.range || "A:ZZZ").trim();
  const metadata = await getSpreadsheetSheetMetadata(env, input.spreadsheetId, input.sheetName);
  const canonicalUri = googleSheetCanonicalUri(input.spreadsheetId, input.sheetName, range);
  const existing = await findResourceByCanonicalUri(env, canonicalUri);
  if (existing) return { resource: existing, reused: true };
  const now = new Date().toISOString();
  const resource: ResourceReferenceRow = {
    resource_id: `RES_${crypto.randomUUID()}`,
    resource_type: "GOOGLE_SHEET",
    provider: "GOOGLE",
    canonical_uri: canonicalUri,
    business_uri: input.businessUri ?? `https://docs.google.com/spreadsheets/d/${input.spreadsheetId}/edit`,
    external_id: input.spreadsheetId,
    external_parent_id: null,
    mime_type: "application/vnd.google-apps.spreadsheet",
    file_name: metadata.spreadsheetTitle,
    content_hash: null,
    byte_size: null,
    metadata_json: JSON.stringify({ sheetName: input.sheetName, range, headerRow: input.headerRow ?? 1, sheetId: metadata.sheetId, gridProperties: metadata.gridProperties }),
    active_status: "ACTIVE",
    created_at: now,
    updated_at: now,
  };
  await insertResource(env, resource);
  return { resource, reused: false };
}

export async function registerGoogleDriveFileResource(env: Env, fileId: string): Promise<{ resource: ResourceReferenceRow; reused: boolean }> {
  const metadata = await getDriveFileMetadata(env, fileId);
  if (metadata.mimeType === "application/vnd.google-apps.spreadsheet") {
    throw Object.assign(new Error("Google native Sheets must be registered as GOOGLE_SHEET resources"), { googleMapped: { status: 422, error: "GOOGLE_NATIVE_FILE_UNSUPPORTED", message: "Google native Sheets must be registered as GOOGLE_SHEET resources" } });
  }
  const canonicalUri = `gdrive://${metadata.id}`;
  const existing = await findResourceByCanonicalUri(env, canonicalUri);
  if (existing) return { resource: existing, reused: true };
  const now = new Date().toISOString();
  const resource: ResourceReferenceRow = {
    resource_id: `RES_${crypto.randomUUID()}`,
    resource_type: "DRIVE_FILE",
    provider: "GOOGLE",
    canonical_uri: canonicalUri,
    business_uri: metadata.webViewLink ?? null,
    external_id: metadata.id,
    external_parent_id: metadata.parents?.[0] ?? null,
    mime_type: metadata.mimeType,
    file_name: metadata.name,
    content_hash: metadata.md5Checksum ?? null,
    byte_size: metadata.size ? Number(metadata.size) : null,
    metadata_json: JSON.stringify({ parents: metadata.parents ?? [], md5Checksum: metadata.md5Checksum ?? null }),
    active_status: "ACTIVE",
    created_at: now,
    updated_at: now,
  };
  await insertResource(env, resource);
  return { resource, reused: false };
}

export async function registerGoogleDriveFolderResource(env: Env, folderId: string): Promise<{ resource: ResourceReferenceRow; reused: boolean }> {
  const metadata = await getDriveFileMetadata(env, folderId);
  if (metadata.mimeType !== "application/vnd.google-apps.folder") {
    throw Object.assign(new Error("Google resource is not a Drive folder"), { googleMapped: { status: 422, error: "INVALID_RESOURCE_TYPE", message: "Google resource is not a Drive folder" } });
  }
  const canonicalUri = `gdrive-folder://${folderId}`;
  const existing = await findResourceByCanonicalUri(env, canonicalUri);
  if (existing) return { resource: existing, reused: true };
  const now = new Date().toISOString();
  const resource: ResourceReferenceRow = {
    resource_id: `RES_${crypto.randomUUID()}`,
    resource_type: "API_RESOURCE",
    provider: "GOOGLE",
    canonical_uri: canonicalUri,
    business_uri: metadata.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`,
    external_id: folderId,
    external_parent_id: null,
    mime_type: metadata.mimeType,
    file_name: metadata.name,
    content_hash: null,
    byte_size: null,
    metadata_json: JSON.stringify({ kind: "DRIVE_FOLDER" }),
    active_status: "ACTIVE",
    created_at: now,
    updated_at: now,
  };
  await insertResource(env, resource);
  return { resource, reused: false };
}
