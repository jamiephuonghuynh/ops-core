import { appendExecutionEvent } from "../db/events";
import { getExecution } from "../db/executions";
import { findOutputCommit, insertOutputCommitIfAbsent, markOutputCommitCommitted, markOutputCommitFailed, markOutputCommitUnknown } from "../db/output-commits";
import { getResource } from "../db/resources";
import { sha256HexBytes } from "../artifacts/service";
import type { Env, GoogleCellValue, OutputCommitRow } from "../types";
import { appendSheetRows } from "./sheets";

export async function appendGoogleSheetWithCommit(env: Env, input: { executionId: string; resourceId: string; artifactRole: string; commitKey: string; rows: GoogleCellValue[][]; businessKey?: string | null; stepCode?: string | null; requestId: string }): Promise<{ kind: "SUCCESS"; commit: OutputCommitRow; appendedRows: number; idempotentReplay: boolean } | { kind: "ERROR"; status: number; error: string; message: string }> {
  const execution = await getExecution(env, input.executionId);
  if (!execution) return { kind: "ERROR", status: 404, error: "EXECUTION_NOT_FOUND", message: "Execution was not found" };
  const resource = await getResource(env, input.resourceId);
  if (!resource) return { kind: "ERROR", status: 404, error: "RESOURCE_NOT_FOUND", message: "Resource was not found" };
  if (resource.resource_type !== "GOOGLE_SHEET" || resource.provider !== "GOOGLE") return { kind: "ERROR", status: 422, error: "INVALID_RESOURCE_TYPE", message: "Resource is not a Google Sheet" };
  if (!input.rows.length) return { kind: "ERROR", status: 400, error: "INVALID_REQUEST", message: "At least one row is required" };
  const payloadHash = await sha256HexBytes(new TextEncoder().encode(JSON.stringify(input.rows)).buffer as ArrayBuffer);
  let commit = await findOutputCommit(env, input.executionId, input.resourceId, input.artifactRole, input.commitKey);
  if (commit && commit.payload_hash !== payloadHash) return { kind: "ERROR", status: 409, error: "OUTPUT_COMMIT_CONFLICT", message: "Commit key was already used with a different row payload" };
  if (commit?.status === "COMMITTED") return { kind: "SUCCESS", commit, appendedRows: input.rows.length, idempotentReplay: true };
  if (commit?.status === "UNKNOWN") return { kind: "ERROR", status: 409, error: "OUTPUT_COMMIT_UNKNOWN", message: "Previous append result is unknown and will not be retried blindly" };
  if (commit?.status === "PREPARED") return { kind: "ERROR", status: 409, error: "OUTPUT_COMMIT_IN_PROGRESS", message: "Output commit is already in progress" };

  const now = new Date().toISOString();
  if (!commit) {
    const candidate: OutputCommitRow = {
      output_commit_id: `OCM_${crypto.randomUUID()}`,
      execution_id: input.executionId,
      resource_id: input.resourceId,
      step_code: input.stepCode ?? null,
      artifact_role: input.artifactRole,
      commit_key: input.commitKey,
      business_key: input.businessKey ?? null,
      payload_hash: payloadHash,
      status: "PREPARED",
      provider_operation: "GOOGLE_SHEETS_APPEND",
      provider_reference: null,
      attempt_count: 0,
      error_code: null,
      error_message: null,
      created_at: now,
      updated_at: now,
      committed_at: null,
    };
    const inserted = await insertOutputCommitIfAbsent(env, candidate);
    commit = inserted ? candidate : await findOutputCommit(env, input.executionId, input.resourceId, input.artifactRole, input.commitKey);
    if (!commit) return { kind: "ERROR", status: 500, error: "INTERNAL_ERROR", message: "Output commit could not be established" };
    if (commit.payload_hash !== payloadHash) return { kind: "ERROR", status: 409, error: "OUTPUT_COMMIT_CONFLICT", message: "Commit key was concurrently used with different rows" };
    if (!inserted) {
      if (commit.status === "COMMITTED") return { kind: "SUCCESS", commit, appendedRows: input.rows.length, idempotentReplay: true };
      return { kind: "ERROR", status: 409, error: commit.status === "UNKNOWN" ? "OUTPUT_COMMIT_UNKNOWN" : "OUTPUT_COMMIT_IN_PROGRESS", message: "Existing output commit cannot be retried automatically" };
    }
  } else if (commit.status === "FAILED") {
    return { kind: "ERROR", status: 409, error: "OUTPUT_COMMIT_FAILED", message: "Failed commit requires a new commit key" };
  }

  let metadata: { sheetName: string; range: string };
  try { metadata = JSON.parse(resource.metadata_json) as { sheetName: string; range: string }; }
  catch { return { kind: "ERROR", status: 500, error: "CONFIG_ERROR", message: "Google Sheet resource metadata is invalid" }; }

  await appendExecutionEvent(env, input.executionId, "GOOGLE_SHEET_APPEND_PREPARED", { resourceId: input.resourceId, commitId: commit.output_commit_id, rowCount: input.rows.length, payloadHash });
  try {
    const result = await appendSheetRows(env, resource.external_id || "", metadata.sheetName, metadata.range, input.rows);
    await markOutputCommitCommitted(env, commit.output_commit_id, result.providerReference);
    commit = (await findOutputCommit(env, input.executionId, input.resourceId, input.artifactRole, input.commitKey))!;
    await appendExecutionEvent(env, input.executionId, "GOOGLE_SHEET_APPEND_COMMITTED", { resourceId: input.resourceId, commitId: commit.output_commit_id, rowCount: result.updatedRows, providerReference: result.providerReference });
    return { kind: "SUCCESS", commit, appendedRows: result.updatedRows, idempotentReplay: false };
  } catch (error) {
    const anyError = error as Error & { googleMapped?: { status: number; error: string; message: string }; requestMayHaveBeenSent?: boolean };
    const mapped = anyError.googleMapped ?? { status: 502, error: "GOOGLE_SHEETS_APPEND_FAILED", message: anyError.message || "Google Sheets append failed" };
    if (anyError.requestMayHaveBeenSent) {
      await markOutputCommitUnknown(env, commit.output_commit_id, mapped.error, mapped.message);
      await appendExecutionEvent(env, input.executionId, "GOOGLE_SHEET_APPEND_UNKNOWN", { resourceId: input.resourceId, commitId: commit.output_commit_id, error: mapped.error });
      return { kind: "ERROR", status: 409, error: "OUTPUT_COMMIT_UNKNOWN", message: "Google append result is ambiguous; automatic retry is blocked" };
    }
    await markOutputCommitFailed(env, commit.output_commit_id, mapped.error, mapped.message);
    return { kind: "ERROR", status: mapped.status, error: mapped.error, message: mapped.message };
  }
}
