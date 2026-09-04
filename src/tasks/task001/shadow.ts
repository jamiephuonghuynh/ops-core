import type { WorkflowStep } from "cloudflare:workers";
import { uploadR2Artifact, sha256HexBytes } from "../../artifacts/service";
import { appendExecutionEvent } from "../../db/events";
import { getResource } from "../../db/resources";
import { getDriveFileContent } from "../../google/drive";
import { createGoogleSheetSnapshot } from "../../google/snapshots";
import { getArtifactObject } from "../../storage/r2";
import type { Env, ExecutionRow, TaskDefinitionRow } from "../../types";
import { parseFirstWorksheetXlsx } from "../../files/xlsx";
import { computeTask001, type NormalizedDataset } from "./compute";
import { TASK001_DEFINITION_VERSION } from "./definition";

type RecordedStep = <T>(stepCode: string, stepOrder: number, inputSummary: unknown, callback: (attempt: number) => Promise<T>) => Promise<T>;

export interface Task001ShadowPayload {
  inputs: {
    gappExportResourceId: string;
    vendorDataResourceId: string;
    salesAreaResourceId: string;
  };
  baselines: {
    gappOrderResourceId: string;
    vendorOrderResourceId: string;
  };
}

interface SnapshotRefs {
  gapp: SnapshotRef;
  vendor: SnapshotRef;
  salesArea: SnapshotRef;
  gappOrderBaseline: SnapshotRef;
  vendorOrderBaseline: SnapshotRef;
}

interface SnapshotRef { resourceId: string; hash: string; rowCount: number; sourceResourceId: string }

function parsePayload(execution: ExecutionRow): Task001ShadowPayload {
  let raw: unknown;
  try { raw = execution.request_payload_json ? JSON.parse(execution.request_payload_json) : null; } catch { raw = null; }
  if (!raw || typeof raw !== "object") throw new Error("TASK001_INVALID_PAYLOAD: payload is required");
  const value = raw as Record<string, unknown>;
  const inputs = value.inputs as Record<string, unknown> | undefined;
  const baselines = value.baselines as Record<string, unknown> | undefined;
  const required = [inputs?.gappExportResourceId, inputs?.vendorDataResourceId, inputs?.salesAreaResourceId, baselines?.gappOrderResourceId, baselines?.vendorOrderResourceId];
  if (required.some((item) => typeof item !== "string" || !item.trim())) throw new Error("TASK001_INVALID_PAYLOAD: five exact resource IDs are required");
  return {
    inputs: { gappExportResourceId: String(inputs!.gappExportResourceId).trim(), vendorDataResourceId: String(inputs!.vendorDataResourceId).trim(), salesAreaResourceId: String(inputs!.salesAreaResourceId).trim() },
    baselines: { gappOrderResourceId: String(baselines!.gappOrderResourceId).trim(), vendorOrderResourceId: String(baselines!.vendorOrderResourceId).trim() },
  };
}

async function readBinaryResource(env: Env, resourceId: string): Promise<{ bytes: ArrayBuffer; fileName: string; mimeType: string }> {
  const resource = await getResource(env, resourceId);
  if (!resource || resource.active_status !== "ACTIVE") throw new Error(`TASK001_RESOURCE_NOT_FOUND: ${resourceId}`);
  if (resource.resource_type === "R2_OBJECT" && resource.provider === "CLOUDFLARE_R2" && resource.external_id) {
    const object = await getArtifactObject(env, resource.external_id);
    if (!object) throw new Error(`TASK001_RESOURCE_CONTENT_UNAVAILABLE: ${resourceId}`);
    return { bytes: await object.arrayBuffer(), fileName: resource.file_name || "input.xlsx", mimeType: resource.mime_type || "application/octet-stream" };
  }
  if (resource.resource_type === "DRIVE_FILE" && resource.provider === "GOOGLE" && resource.external_id) {
    const response = await getDriveFileContent(env, resource.external_id);
    if (!response.ok) throw new Error(`TASK001_GOOGLE_DRIVE_READ_FAILED: ${resourceId} HTTP ${response.status}`);
    return { bytes: await response.arrayBuffer(), fileName: resource.file_name || "input.xlsx", mimeType: resource.mime_type || response.headers.get("Content-Type") || "application/octet-stream" };
  }
  throw new Error(`TASK001_INVALID_GAPP_RESOURCE_TYPE: ${resource.resource_type}/${resource.provider}`);
}

function assertXlsx(fileName: string, mimeType: string): void {
  const nameOk = fileName.toLowerCase().endsWith(".xlsx");
  const mime = mimeType.toLowerCase();
  const mimeOk = mime.includes("spreadsheetml") || mime.includes("xlsx") || mime === "application/octet-stream";
  if (!nameOk && !mimeOk) throw new Error(`TASK001_INVALID_XLSX_RESOURCE: ${fileName} (${mimeType})`);
}

async function uploadJson(env: Env, executionId: string, role: string, direction: "INPUT" | "OUTPUT" | "EVIDENCE", fileName: string, value: unknown, key: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
  const result = await uploadR2Artifact(env, { executionId, artifactRole: role, direction, fileName, mimeType: "application/json", idempotencyKey: key, suppliedSha256: null, bytes, requestId: `WF_${executionId}` });
  if (result.kind === "ERROR") throw new Error(`${result.error}: ${result.message}`);
  return { resourceId: result.resource.resource_id, hash: result.resource.content_hash || await sha256HexBytes(bytes), rowCount: 0 };
}

async function snapshotGapp(env: Env, executionId: string, sourceResourceId: string): Promise<SnapshotRef> {
  const source = await readBinaryResource(env, sourceResourceId);
  assertXlsx(source.fileName, source.mimeType);
  const dataset = parseFirstWorksheetXlsx(source.bytes);
  const normalized = { headers: dataset.headers, rows: dataset.rows };
  const uploaded = await uploadJson(env, executionId, "TASK001_INPUT_GAPP_NORMALIZED", "INPUT", `task001-gapp-${sourceResourceId}.snapshot.json`, normalized, `TASK001:GAPP:${sourceResourceId}:${await sha256HexBytes(new TextEncoder().encode(JSON.stringify(normalized)).buffer as ArrayBuffer)}`);
  await appendExecutionEvent(env, executionId, "TASK001_GAPP_SNAPSHOT_CREATED", { sourceResourceId, snapshotResourceId: uploaded.resourceId, snapshotHash: uploaded.hash, rowCount: dataset.rowCount, worksheetName: dataset.worksheetName });
  return { resourceId: uploaded.resourceId, hash: uploaded.hash, rowCount: dataset.rowCount, sourceResourceId };
}

async function snapshotSheet(env: Env, executionId: string, sourceResourceId: string, role: string): Promise<SnapshotRef> {
  const resource = await getResource(env, sourceResourceId);
  if (!resource || resource.active_status !== "ACTIVE") throw new Error(`TASK001_RESOURCE_NOT_FOUND: ${sourceResourceId}`);
  if (resource.resource_type !== "GOOGLE_SHEET" || resource.provider !== "GOOGLE") throw new Error(`TASK001_INVALID_SHEET_RESOURCE: ${sourceResourceId}`);
  const result = await createGoogleSheetSnapshot(env, { executionId, resourceId: sourceResourceId, artifactRole: role, snapshotMode: "NORMALIZED_SNAPSHOT", requestId: `WF_${executionId}` });
  if (result.kind === "ERROR" || !result.snapshotResourceId) throw new Error(result.kind === "ERROR" ? `${result.error}: ${result.message}` : "TASK001_SNAPSHOT_RESOURCE_MISSING");
  return { resourceId: result.snapshotResourceId, hash: result.snapshot.snapshotHash, rowCount: result.snapshot.rowCount, sourceResourceId };
}

async function readSnapshotJson(env: Env, ref: SnapshotRef): Promise<NormalizedDataset> {
  const resource = await getResource(env, ref.resourceId);
  if (!resource?.external_id || resource.resource_type !== "R2_OBJECT") throw new Error(`TASK001_SNAPSHOT_NOT_R2: ${ref.resourceId}`);
  const object = await getArtifactObject(env, resource.external_id);
  if (!object) throw new Error(`TASK001_SNAPSHOT_CONTENT_MISSING: ${ref.resourceId}`);
  const parsed = await new Response(object.body).json() as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error(`TASK001_SNAPSHOT_INVALID_JSON: ${ref.resourceId}`);
  const value = parsed as Record<string, unknown>;
  if (!Array.isArray(value.headers) || !Array.isArray(value.rows)) throw new Error(`TASK001_SNAPSHOT_INVALID_DATASET: ${ref.resourceId}`);
  return { headers: value.headers as unknown[], rows: value.rows as unknown[][] };
}

function formatHoChiMinhDateTime(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const parts = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export async function runTask001ShadowWorkflow(env: Env, step: WorkflowStep, execution: ExecutionRow, task: TaskDefinitionRow, recordedStep: RecordedStep) {
  if (task.definition_version !== TASK001_DEFINITION_VERSION || task.execution_mode !== "SHADOW_COMPUTE") throw new Error(`TASK001_UNSUPPORTED_DEFINITION: ${task.definition_version}/${task.execution_mode}`);
  const payload = parsePayload(execution);
  const snapshots = await recordedStep<SnapshotRefs>("TASK001_01_SNAPSHOT_INPUTS", 1, { resourceIds: { ...payload.inputs, ...payload.baselines } }, async () => ({
    gapp: await snapshotGapp(env, execution.execution_id, payload.inputs.gappExportResourceId),
    vendor: await snapshotSheet(env, execution.execution_id, payload.inputs.vendorDataResourceId, "TASK001_INPUT_VENDOR_DATA"),
    salesArea: await snapshotSheet(env, execution.execution_id, payload.inputs.salesAreaResourceId, "TASK001_INPUT_SALES_AREA"),
    gappOrderBaseline: await snapshotSheet(env, execution.execution_id, payload.baselines.gappOrderResourceId, "TASK001_BASELINE_GAPP_ORDER"),
    vendorOrderBaseline: await snapshotSheet(env, execution.execution_id, payload.baselines.vendorOrderResourceId, "TASK001_BASELINE_VENDOR_ORDER"),
  }));

  const result = await recordedStep("TASK001_02_SHADOW_COMPUTE", 2, { snapshotHashes: Object.fromEntries(Object.entries(snapshots).map(([key, ref]) => [key, ref.hash])) }, async () => {
    const compute = await computeTask001({
      gapp: await readSnapshotJson(env, snapshots.gapp), vendor: await readSnapshotJson(env, snapshots.vendor), salesArea: await readSnapshotJson(env, snapshots.salesArea),
      gappOrderBaseline: await readSnapshotJson(env, snapshots.gappOrderBaseline), vendorOrderBaseline: await readSnapshotJson(env, snapshots.vendorOrderBaseline), requestedAt: formatHoChiMinhDateTime(new Date(execution.requested_at)),
    });
    const report = {
      executionId: execution.execution_id, taskId: execution.task_id, definitionVersion: task.definition_version,
      inputResources: { ...payload.inputs, ...payload.baselines },
      snapshotHashes: Object.fromEntries(Object.entries(snapshots).map(([key, ref]) => [key, ref.hash])),
      snapshotRowCounts: Object.fromEntries(Object.entries(snapshots).map(([key, ref]) => [key, ref.rowCount])),
      inputCount: compute.inputCount, includedCount: compute.includedCount, skippedCount: compute.skipped.length, requiredWarningCount: compute.requiredWarnings.length,
      vendorDuplicateIdenticalCount: compute.vendorDuplicates.warnings.length, vendorDuplicateConflictCount: compute.vendorDuplicates.errors.length,
      gappDuplicateIdenticalCount: compute.gappDuplicates.warnings.length, gappDuplicateConflictCount: compute.gappDuplicates.errors.length,
      gappProjectedAppendCount: compute.gappRows.length, vendorProjectedAppendCount: compute.vendorRows.length,
      includedOrderIds: compute.includedOrderIds, skipped: compute.skipped, requiredWarnings: compute.requiredWarnings,
      vendorDuplicateWarnings: compute.vendorDuplicates.warnings, vendorDuplicateErrors: compute.vendorDuplicates.errors,
      gappDuplicateWarnings: compute.gappDuplicates.warnings, gappDuplicateErrors: compute.gappDuplicates.errors,
      gappOutputBusinessHash: compute.gappBusinessHash, vendorOutputBusinessHash: compute.vendorBusinessHash,
      resultStatus: compute.resultStatus, resultCode: compute.resultCode, resultMessage: compute.resultMessage, computedAt: execution.requested_at,
    };
    const gappArtifact = await uploadJson(env, execution.execution_id, "TASK001_GAPP_ORDER_SHADOW", "OUTPUT", "task001-gapp-order-shadow.json", { rows: compute.gappRows, businessHash: compute.gappBusinessHash }, `TASK001:GAPP_OUTPUT:${compute.gappBusinessHash}`);
    const vendorArtifact = await uploadJson(env, execution.execution_id, "TASK001_VENDOR_ORDER_SHADOW", "OUTPUT", "task001-vendor-order-shadow.json", { rows: compute.vendorRows, businessHash: compute.vendorBusinessHash }, `TASK001:VENDOR_OUTPUT:${compute.vendorBusinessHash}`);
    const reportArtifact = await uploadJson(env, execution.execution_id, "TASK001_SHADOW_REPORT", "EVIDENCE", "task001-shadow-report.json", report, `TASK001:REPORT:${await sha256HexBytes(new TextEncoder().encode(JSON.stringify(report)).buffer as ArrayBuffer)}`);
    await appendExecutionEvent(env, execution.execution_id, "TASK001_SHADOW_COMPUTED", { resultStatus: compute.resultStatus, resultCode: compute.resultCode, gappProjectedAppendCount: compute.gappRows.length, vendorProjectedAppendCount: compute.vendorRows.length, gappBusinessHash: compute.gappBusinessHash, vendorBusinessHash: compute.vendorBusinessHash, reportResourceId: reportArtifact.resourceId });
    return { status: compute.resultStatus, resultCode: compute.resultCode, resultMessage: compute.resultMessage, reportResourceId: reportArtifact.resourceId, gappOutputResourceId: gappArtifact.resourceId, vendorOutputResourceId: vendorArtifact.resourceId };
  });
  return result;
}
