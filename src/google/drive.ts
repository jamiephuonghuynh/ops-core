import { GOOGLE_DRIVE_BASE_URL } from "../config";
import type { Env } from "../types";
import { googleFetch, mapGoogleError } from "./http";

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
  md5Checksum?: string;
  modifiedTime?: string;
}

export async function getDriveFileMetadata(env: Env, fileId: string): Promise<DriveFileMetadata> {
  const fields = encodeURIComponent("id,name,mimeType,size,parents,webViewLink,md5Checksum,modifiedTime");
  const url = `${GOOGLE_DRIVE_BASE_URL}/files/${encodeURIComponent(fileId)}?fields=${fields}&supportsAllDrives=true`;
  const result = await googleFetch<DriveFileMetadata>(env, url);
  if (!result.response.ok || !result.data) {
    const mapped = mapGoogleError(result.response.status, "DRIVE_READ");
    throw Object.assign(new Error(mapped.message), { googleMapped: mapped, providerText: result.text.slice(0, 500) });
  }
  return result.data;
}

export async function getDriveFileContent(env: Env, fileId: string): Promise<Response> {
  const { accessToken } = await (await import("./auth")).getGoogleAccessToken(env);
  const url = `${GOOGLE_DRIVE_BASE_URL}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}


interface DriveListResponse { nextPageToken?: string; files?: DriveFileMetadata[] }

export async function listDriveFolderFiles(env: Env, folderId: string): Promise<DriveFileMetadata[]> {
  const files: DriveFileMetadata[] = [];
  let pageToken: string | null = null;
  do {
    const query = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
    const params = new URLSearchParams({
      q: query,
      pageSize: "1000",
      orderBy: "modifiedTime desc",
      fields: "nextPageToken,files(id,name,mimeType,size,parents,webViewLink,md5Checksum,modifiedTime)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const url = `${GOOGLE_DRIVE_BASE_URL}/files?${params.toString()}`;
    const result = await googleFetch<DriveListResponse>(env, url);
    if (!result.response.ok || !result.data) {
      const mapped = mapGoogleError(result.response.status, "DRIVE_READ");
      throw Object.assign(new Error(mapped.message), { googleMapped: mapped, providerText: result.text.slice(0, 500) });
    }
    files.push(...(result.data.files ?? []));
    pageToken = result.data.nextPageToken ?? null;
  } while (pageToken);
  return files;
}
