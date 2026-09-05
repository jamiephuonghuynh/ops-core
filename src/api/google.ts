import { errorResponse, jsonResponse } from "../response";
import type { Env, GoogleCellValue, GoogleSnapshotMode } from "../types";
import { getGoogleAccessToken, isGoogleWorkspaceConfigured } from "../google/auth";
import { registerGoogleDriveFileResource, registerGoogleDriveFolderResource, registerGoogleSheetResource } from "../google/resources";
import { getResource } from "../db/resources";
import { readNormalizedSheet } from "../google/sheets";
import { createGoogleSheetSnapshot } from "../google/snapshots";
import { appendGoogleSheetWithCommit } from "../google/output-commit";
import { normalizeArtifactRole } from "../artifacts/service";

function mappedGoogleError(error: unknown): { status: number; error: string; message: string } {
  const anyError = error as Error & { googleMapped?: { status: number; error: string; message: string } };
  return anyError.googleMapped ?? { status: 502, error: "GOOGLE_PROVIDER_ERROR", message: anyError.message || "Google provider request failed" };
}

export async function handleGoogleHealth(env: Env, requestId: string): Promise<Response> {
  if (!isGoogleWorkspaceConfigured(env)) return errorResponse("GOOGLE_AUTH_NOT_CONFIGURED", "Google Workspace credentials are not configured", 503, requestId);
  try {
    const token = await getGoogleAccessToken(env);
    return jsonResponse({ ok: true, googleAuth: "ok", serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, tokenExpiresIn: token.expiresIn }, 200, requestId);
  } catch (error) {
    return errorResponse("GOOGLE_TOKEN_FAILED", "Google OAuth token exchange failed", 502, requestId);
  }
}

export async function handleRegisterGoogleSheet(request: Request, env: Env, requestId: string): Promise<Response> {
  let body: { spreadsheetId?: string; sheetName?: string; range?: string; businessUri?: string; headerRow?: number };
  try { body = await request.json(); } catch { return errorResponse("INVALID_REQUEST", "Request body must be JSON", 400, requestId); }
  if (!body.spreadsheetId?.trim() || !body.sheetName?.trim()) return errorResponse("INVALID_REQUEST", "spreadsheetId and sheetName are required", 400, requestId);
  try {
    const result = await registerGoogleSheetResource(env, { spreadsheetId: body.spreadsheetId.trim(), sheetName: body.sheetName.trim(), range: body.range?.trim() || "A:ZZZ", businessUri: body.businessUri ?? null, headerRow: Number(body.headerRow || 1) });
    return jsonResponse({ ok: true, resource: result.resource, idempotentReplay: result.reused }, result.reused ? 200 : 201, requestId);
  } catch (error) {
    const mapped = mappedGoogleError(error); return errorResponse(mapped.error, mapped.message, mapped.status, requestId);
  }
}

export async function handleReadGoogleSheet(env: Env, resourceId: string, requestId: string): Promise<Response> {
  const resource = await getResource(env, resourceId);
  if (!resource) return errorResponse("RESOURCE_NOT_FOUND", "Resource was not found", 404, requestId);
  if (resource.resource_type !== "GOOGLE_SHEET") return errorResponse("INVALID_RESOURCE_TYPE", "Resource is not a Google Sheet", 422, requestId);
  try {
    const metadata = JSON.parse(resource.metadata_json) as { sheetName: string; range: string; headerRow?: number };
    const dataset = await readNormalizedSheet(env, resource.external_id || "", metadata.sheetName, metadata.range, metadata.headerRow ?? 1);
    return jsonResponse({ ok: true, resourceId, ...dataset, canonicalJson: undefined }, 200, requestId);
  } catch (error) { const mapped = mappedGoogleError(error); return errorResponse(mapped.error, mapped.message, mapped.status, requestId); }
}

export async function handleGoogleSheetSnapshot(request: Request, env: Env, executionId: string, requestId: string): Promise<Response> {
  let body: { resourceId?: string; artifactRole?: string; snapshotMode?: GoogleSnapshotMode };
  try { body = await request.json(); } catch { return errorResponse("INVALID_REQUEST", "Request body must be JSON", 400, requestId); }
  const role = normalizeArtifactRole(body.artifactRole ?? null);
  const mode = body.snapshotMode === "METADATA_ONLY" ? "METADATA_ONLY" : body.snapshotMode === "NORMALIZED_SNAPSHOT" ? "NORMALIZED_SNAPSHOT" : null;
  if (!body.resourceId || !role || !mode) return errorResponse("INVALID_REQUEST", "resourceId, valid artifactRole and snapshotMode are required", 400, requestId);
  try {
    const result = await createGoogleSheetSnapshot(env, { executionId, resourceId: body.resourceId, artifactRole: role, snapshotMode: mode, requestId });
    if (result.kind === "ERROR") return errorResponse(result.error, result.message, result.status, requestId);
    return jsonResponse({ ok: true, sourceResourceId: body.resourceId, snapshotResourceId: result.snapshotResourceId, artifactId: result.artifactId, snapshotHash: result.snapshot.snapshotHash, rowCount: result.snapshot.rowCount, columnCount: result.snapshot.columnCount, snapshotAt: result.snapshot.fetchedAt, snapshotMode: mode, idempotentReplay: "idempotentReplay" in result ? result.idempotentReplay : false }, 201, requestId);
  } catch (error) { const mapped = mappedGoogleError(error); return errorResponse(mapped.error, mapped.message, mapped.status, requestId); }
}

export async function handleAppendGoogleSheet(request: Request, env: Env, resourceId: string, requestId: string): Promise<Response> {
  let body: { executionId?: string; artifactRole?: string; commitKey?: string; rows?: GoogleCellValue[][]; businessKey?: string; stepCode?: string };
  try { body = await request.json(); } catch { return errorResponse("INVALID_REQUEST", "Request body must be JSON", 400, requestId); }
  const role = normalizeArtifactRole(body.artifactRole ?? null);
  if (!body.executionId || !role || !body.commitKey?.trim() || !Array.isArray(body.rows)) return errorResponse("INVALID_REQUEST", "executionId, artifactRole, commitKey and rows are required", 400, requestId);
  const result = await appendGoogleSheetWithCommit(env, { executionId: body.executionId, resourceId, artifactRole: role, commitKey: body.commitKey.trim(), rows: body.rows, businessKey: body.businessKey ?? null, stepCode: body.stepCode ?? null, requestId });
  if (result.kind === "ERROR") return errorResponse(result.error, result.message, result.status, requestId);
  return jsonResponse({ ok: true, commit: result.commit, appendedRows: result.appendedRows, idempotentReplay: result.idempotentReplay }, result.idempotentReplay ? 200 : 201, requestId);
}

export async function handleRegisterGoogleDriveFile(request: Request, env: Env, requestId: string): Promise<Response> {
  let body: { fileId?: string };
  try { body = await request.json(); } catch { return errorResponse("INVALID_REQUEST", "Request body must be JSON", 400, requestId); }
  if (!body.fileId?.trim()) return errorResponse("INVALID_REQUEST", "fileId is required", 400, requestId);
  try {
    const result = await registerGoogleDriveFileResource(env, body.fileId.trim());
    return jsonResponse({ ok: true, resource: result.resource, idempotentReplay: result.reused }, result.reused ? 200 : 201, requestId);
  } catch (error) { const mapped = mappedGoogleError(error); return errorResponse(mapped.error, mapped.message, mapped.status, requestId); }
}


export async function handleRegisterGoogleDriveFolder(request: Request, env: Env, requestId: string): Promise<Response> {
  let body: { folderId?: string };
  try { body = await request.json(); } catch { return errorResponse("INVALID_REQUEST", "Request body must be JSON", 400, requestId); }
  if (!body.folderId?.trim()) return errorResponse("INVALID_REQUEST", "folderId is required", 400, requestId);
  try {
    const result = await registerGoogleDriveFolderResource(env, body.folderId.trim());
    return jsonResponse({ ok: true, resource: result.resource, idempotentReplay: result.reused }, result.reused ? 200 : 201, requestId);
  } catch (error) { const mapped = mappedGoogleError(error); return errorResponse(mapped.error, mapped.message, mapped.status, requestId); }
}
