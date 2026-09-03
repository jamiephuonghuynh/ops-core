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
}

export async function getDriveFileMetadata(env: Env, fileId: string): Promise<DriveFileMetadata> {
  const fields = encodeURIComponent("id,name,mimeType,size,parents,webViewLink,md5Checksum");
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
