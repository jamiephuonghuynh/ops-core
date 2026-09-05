import type { WorkflowStep } from "cloudflare:workers";
import { sha256HexBytes } from "../../artifacts/service";
import { appendExecutionEvent } from "../../db/events";
import { getPublishedMappingSet, listMappingEntries } from "../../db/field-mappings";
import { createAvailableInput, claimInputForExecution, finalizeInputProcessing, failInputProcessing, getLatestInputProcessing } from "../../db/input-processing";
import { getActiveBinding, listActiveBindings } from "../../db/resource-bindings";
import { setExecutionNotificationConfig, setExecutionRuntimeConfig } from "../../db/executions";
import { claimBusinessKey, markBusinessClaimsCommitted, markBusinessClaimsUnknown, releaseUncommittedClaims } from "../../db/business-keys";
import { getResource } from "../../db/resources";
import { appendGoogleSheetWithCommit } from "../../google/output-commit";
import { createGoogleSheetSnapshot } from "../../google/snapshots";
import { getArtifactObject } from "../../storage/r2";
import { bindExistingResource, uploadR2Artifact } from "../../artifacts/service";
import { getDriveFileContent } from "../../google/drive";
import { parseFirstWorksheetXlsx } from "../../files/xlsx";
import type { Env, ExecutionRow, FieldMappingEntryRow, ResourceBindingRow, TaskDefinitionRow } from "../../types";
import { computeTask001, type NormalizedDataset } from "./compute";
import { TASK001_DEFINITION_VERSION, type Task001FieldMapping, type Task001MappingBundle } from "./definition";
import { comparablePayload } from "./duplicates";
import { normalize, type StandardRow } from "./geo";
import { buildPhysicalRowsForGoogleSheet, hashStandardRow } from "./delivery";
import { resolveLatestEligibleTask001Input } from "./inputs";
import { materializeStagingObject } from "../../staging/import";
import { getTaskRuntimeOwnership } from "../../db/runtime-ownership";
import { commitSourceCoverage } from "../../db/source-coverage";
import { updateAutomationRun } from "../../db/automation-runs";
import { deliverNotificationEvent, getPublishedNotificationConfigSetId, prepareNotificationEvent, processNotificationBacklog } from "../../notification/runtime";
import { assertTask001ProductionReadiness } from "./cutover";
import { recoverTask001DeliveryNotificationOutbox } from "./notification";

type RecordedStep = <T>(stepCode: string, stepOrder: number, inputSummary: unknown, callback: (attempt: number) => Promise<T>) => Promise<T>;

interface SafeWritePayload {
  executionMode?: string;
  bindingOverrides?: Record<string, string>;
  testFaults?: { failBeforeDeliveryCommit?: boolean; forceDeliveryUnknown?: boolean };
  automation?: {
    automationId?: string; runDate?: string; runSlot?: string; requestId?: string; sourceStartDate?: string; sourceEndDate?: string;
    stagedFile?: { stagingObjectKey?: string; fileName?: string; contentType?: string; contentLength?: number; sha256?: string };
  };
}

function parsePayload(execution: ExecutionRow): SafeWritePayload {
  if (!execution.request_payload_json) return {};
  try { return JSON.parse(execution.request_payload_json) as SafeWritePayload; }
  catch { throw new Error("TASK001_INVALID_REQUEST_PAYLOAD"); }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function emptyDataset(): NormalizedDataset { return { headers: [], rows: [] }; }
function mapping(entry: FieldMappingEntryRow): Task001FieldMapping { return { sourceField: entry.source_field, standardField: entry.standard_field, dataType: entry.data_type, required: entry.required_flag === 1 }; }
function formatHoChiMinhDateTime(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const parts = Object.fromEntries(formatter.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function readR2Dataset(env: Env, resourceId: string): Promise<NormalizedDataset> {
  const resource = await getResource(env, resourceId);
  if (!resource?.external_id || resource.resource_type !== "R2_OBJECT") throw new Error(`TASK001_SNAPSHOT_NOT_R2:${resourceId}`);
  const object = await getArtifactObject(env, resource.external_id);
  if (!object) throw new Error(`TASK001_SNAPSHOT_CONTENT_MISSING:${resourceId}`);
  const json = await new Response(object.body).json() as { headers?: unknown[]; rows?: unknown[][] };
  if (!Array.isArray(json.headers) || !Array.isArray(json.rows)) throw new Error(`TASK001_SNAPSHOT_INVALID:${resourceId}`);
  return { headers: json.headers, rows: json.rows };
}

async function snapshotJson(env: Env, executionId: string, role: string, fileName: string, value: unknown, idempotencyKey: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
  const result = await uploadR2Artifact(env, { executionId, artifactRole: role, direction: "INPUT", fileName, mimeType: "application/json", idempotencyKey, suppliedSha256: null, bytes, requestId: `WF_${executionId}` });
  if (result.kind === "ERROR") throw new Error(`${result.error}:${result.message}`);
  return { resourceId: result.resource.resource_id, hash: result.resource.content_hash || await sha256HexBytes(bytes) };
}

async function uploadEvidence(env: Env, executionId: string, value: unknown, executionMode = "TEST_SAFE_WRITE") {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
  const hash = await sha256HexBytes(bytes);
  const productionReport = executionMode === "PRODUCTION" || executionMode === "PRODUCTION_DRY_RUN";
  const result = await uploadR2Artifact(env, { executionId, artifactRole: productionReport ? "TASK001_PRODUCTION_REPORT" : "TASK001_SAFE_WRITE_REPORT", direction: "EVIDENCE", fileName: productionReport ? "task001-production-report.json" : "task001-safe-write-report.json", mimeType: "application/json", idempotencyKey: `${productionReport ? "TASK001:P6:REPORT" : "TASK001:P5:REPORT"}:${hash}`, suppliedSha256: hash, bytes, requestId: `WF_${executionId}` });
  if (result.kind === "ERROR") throw new Error(`${result.error}:${result.message}`);
  return result.resource.resource_id;
}

async function snapshotGapp(env: Env, executionId: string, sourceResourceId: string) {
  const resource = await getResource(env, sourceResourceId);
  if (!resource?.external_id) throw new Error("TASK001_GAPP_FILE_RESOURCE_INVALID");
  let bytes: ArrayBuffer;
  if (resource.resource_type === "DRIVE_FILE" && resource.provider === "GOOGLE") {
    const response = await getDriveFileContent(env, resource.external_id);
    if (!response.ok) throw new Error(`TASK001_GAPP_FILE_READ_FAILED:${response.status}`);
    bytes = await response.arrayBuffer();
  } else if (resource.resource_type === "R2_OBJECT") {
    const object = await getArtifactObject(env, resource.external_id);
    if (!object?.body) throw new Error("TASK001_GAPP_R2_CONTENT_MISSING");
    bytes = await new Response(object.body).arrayBuffer();
  } else throw new Error("TASK001_GAPP_FILE_RESOURCE_INVALID");
  const parsed = parseFirstWorksheetXlsx(bytes);
  const dataset = { headers: parsed.headers, rows: parsed.rows };
  const canonical = JSON.stringify(dataset);
  return snapshotJson(env, executionId, "TASK001_INPUT_GAPP_NORMALIZED", `task001-gapp-${sourceResourceId}.snapshot.json`, dataset, `TASK001:GAPP:${sourceResourceId}:${await sha256HexBytes(new TextEncoder().encode(canonical).buffer as ArrayBuffer)}`);
}

async function snapshotSheet(env: Env, executionId: string, resourceId: string, role: string) {
  const result = await createGoogleSheetSnapshot(env, { executionId, resourceId, artifactRole: role, snapshotMode: "NORMALIZED_SNAPSHOT", requestId: `WF_${executionId}` });
  if (result.kind === "ERROR" || !result.snapshotResourceId) throw new Error(result.kind === "ERROR" ? `${result.error}:${result.message}` : "TASK001_SNAPSHOT_RESOURCE_MISSING");
  return { resourceId: result.snapshotResourceId, hash: result.snapshot.snapshotHash };
}

function bundle(entries: FieldMappingEntryRow[]): Task001MappingBundle {
  const pick = (role: string, direction: "INPUT" | "OUTPUT") => entries.filter((e) => e.binding_role === role && e.mapping_direction === direction).sort((a,b) => a.ordinal-b.ordinal).map(mapping);
  return {
    gappInput: pick("GAPP_EXPORT", "INPUT"),
    vendorInput: pick("VENDOR_DATA", "INPUT"),
    salesAreaInput: pick("SALES_AREA", "INPUT"),
    gappOutput: pick("GAPP_ORDER", "OUTPUT"),
    deliveryOutput: pick("SMARTLINK_ORDER_DELIVERY", "OUTPUT"),
  };
}

function bindingMap(bindings: ResourceBindingRow[]): Map<string, ResourceBindingRow> { return new Map(bindings.map((b) => [b.binding_role, b])); }

async function applyOverrides(env: Env, map: Map<string, ResourceBindingRow>, payload: SafeWritePayload): Promise<Map<string, ResourceBindingRow>> {
  const overrides = payload.bindingOverrides ?? {};
  for (const role of ["GAPP_EXPORT", "GAPP_ORDER", "SMARTLINK_ORDER_DELIVERY"]) {
    const resourceId = (overrides[role] ?? "").trim();
    if (!resourceId) throw new Error(`TASK001_TEST_OVERRIDE_REQUIRED:${role}`);
    const base = map.get(role);
    if (!base) throw new Error(`TASK001_BINDING_MISSING:${role}`);
    if (resourceId === base.resource_id) throw new Error(`TASK001_PRODUCTION_WRITE_TARGET_FORBIDDEN:${role}`);
    const resource = await getResource(env, resourceId);
    if (!resource || resource.active_status !== "ACTIVE") throw new Error(`TASK001_OVERRIDE_RESOURCE_NOT_FOUND:${role}`);
    map.set(role, { ...base, resource_id: resourceId });
  }
  return map;
}

function hashFields(row: StandardRow): string[] { return Object.keys(comparablePayload(row)); }

async function classifyClaims(env: Env, input: { executionId: string; namespace: string; resourceId: string; rows: StandardRow[]; fields: string[] }) {
  const newRows: StandardRow[] = [];
  const identicalRows: StandardRow[] = [];
  const newClaimIds: string[] = [];
  for (const row of input.rows) {
    const key = normalize(row.order_id);
    if (!key) continue;
    const payloadHash = await hashStandardRow(row, input.fields);
    const decision = await claimBusinessKey(env, { namespace: input.namespace, businessKey: key, payloadHash, executionId: input.executionId, resourceId: input.resourceId });
    if (decision.kind === "CONFLICT") {
      await releaseUncommittedClaims(env, input.executionId, [input.namespace]);
      throw new Error(`DUPLICATE_CONFLICT:${key}`);
    }
    if (decision.kind === "BLOCKED") throw new Error(`BUSINESS_KEY_BLOCKED:${key}:${decision.claim.status}`);
    if (decision.kind === "NEW") { newRows.push(row); newClaimIds.push(decision.claim.business_key_claim_id); }
    else identicalRows.push(row);
  }
  return { newRows, identicalRows, newClaimIds };
}


async function resolveProductionStagedInput(env: Env, execution: ExecutionRow, payload: SafeWritePayload) {
  const staged = payload.automation?.stagedFile;
  if (!staged?.stagingObjectKey || !staged.fileName || !staged.sha256) throw new Error("TASK001_PRODUCTION_STAGED_INPUT_REQUIRED");
  const identity = `staging:${staged.stagingObjectKey}:${staged.sha256}`;
  let state = await getLatestInputProcessing(env,"task001_smartlink_order","GAPP_EXPORT",identity);
  if (["PROCESSED","PROCESSED_NO_OUTPUT"].includes(state?.status || "")) return { found:false as const, alreadyProcessed:true as const, state:state! };
  let resourceId = state?.resource_id || "";
  if (resourceId) {
    const rebound = await bindExistingResource(env, execution.execution_id, resourceId, "TASK001_GAPP_EXPORT_RAW", "INPUT", null);
    if (!rebound) throw new Error("TASK001_MATERIALIZED_INPUT_RESOURCE_MISSING");
  } else {
    const materialized = await materializeStagingObject(env,{ executionId:execution.execution_id, stagingObjectKey:staged.stagingObjectKey, fileName:staged.fileName, contentType:staged.contentType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sha256:staged.sha256, artifactRole:"TASK001_GAPP_EXPORT_RAW" });
    resourceId = materialized.resource.resource_id;
    state = await createAvailableInput(env,{taskId:"task001_smartlink_order",inputRole:"GAPP_EXPORT",resourceId,resourceIdentity:identity,contentHash:staged.sha256,detectedAt:new Date().toISOString()});
  }
  if (!state) throw new Error("TASK001_INPUT_PROCESSING_STATE_MISSING");
  const claimed = await claimInputForExecution(env,state.input_processing_id,execution.execution_id);
  if (!claimed && state.execution_id !== execution.execution_id) throw new Error(`TASK001_INPUT_BUSY:${state.status}`);
  return { found:true as const,inputProcessingId:state.input_processing_id,generation:state.generation,resourceId,resourceIdentity:identity,fileName:staged.fileName };
}

export async function runTask001ProductionFoundationWorkflow(env: Env, step: WorkflowStep, execution: ExecutionRow, task: TaskDefinitionRow, recordedStep: RecordedStep) {
  if (task.definition_version !== TASK001_DEFINITION_VERSION || task.execution_mode !== "CUTOVER_READY") throw new Error(`TASK001_UNSUPPORTED_DEFINITION:${task.definition_version}/${task.execution_mode}`);
  const payload = parsePayload(execution);
  const mode = payload.executionMode || "";
  if (!["TEST_SAFE_WRITE","PRODUCTION","PRODUCTION_DRY_RUN"].includes(mode)) throw new Error("TASK001_UNSUPPORTED_EXECUTION_MODE");
  const isProduction = mode === "PRODUCTION" || mode === "PRODUCTION_DRY_RUN";
  const isProductionWrite = mode === "PRODUCTION";
  if (isProductionWrite) {
    const owner = await getTaskRuntimeOwnership(env, execution.task_id);
    if (owner?.runtime_owner !== "CLOUDFLARE") throw new Error(`TASK001_RUNTIME_OWNER_MISMATCH:${owner?.runtime_owner || "NONE"}`);
    await assertTask001ProductionReadiness(env, true);
  } else if (mode === "PRODUCTION_DRY_RUN") await assertTask001ProductionReadiness(env, false);

  const config = await recordedStep("T001_01_RESOLVE_CONFIG", 1, {}, async () => {
    const mappingSet = await getPublishedMappingSet(env, execution.task_id);
    if (!mappingSet) throw new Error("TASK001_PUBLISHED_MAPPING_NOT_FOUND");
    const entries = await listMappingEntries(env, mappingSet.mapping_set_id);
    const activeBindings = await listActiveBindings(env, execution.task_id);
    if (!activeBindings.length) throw new Error("TASK001_ACTIVE_BINDINGS_NOT_FOUND");
    const versions = [...new Set(activeBindings.map((b) => b.binding_version))];
    if (versions.length !== 1 || versions[0] !== mappingSet.mapping_version) throw new Error("TASK001_CONFIG_VERSION_MISMATCH");
    const bindings = isProduction ? bindingMap(activeBindings) : await applyOverrides(env, bindingMap(activeBindings), payload);
    await setExecutionRuntimeConfig(env, execution.execution_id, { runtimeConfigVersion: mappingSet.mapping_version, mappingSetId: mappingSet.mapping_set_id, bindingVersion: versions[0] });
    let notificationConfigSetId: string | null = null;
    if (isProduction) {
      notificationConfigSetId = await getPublishedNotificationConfigSetId(env, "OPS");
      if (!notificationConfigSetId) throw new Error("TASK001_NOTIFICATION_CONFIG_NOT_PUBLISHED");
      await setExecutionNotificationConfig(env, execution.execution_id, notificationConfigSetId);
    }
    return { mappingSetId: mappingSet.mapping_set_id, configVersion: mappingSet.mapping_version, notificationConfigSetId, bindings: Object.fromEntries([...bindings].map(([role, b]) => [role, b])), mappings: entries };
  });

  const bindings = new Map(Object.entries(config.bindings) as Array<[string, ResourceBindingRow]>);
  const mappingBundle = bundle(config.mappings);
  const input = await recordedStep("T001_02_RESOLVE_INPUT", 2, { bindingRole: "GAPP_EXPORT", mode }, async () => isProduction ? resolveProductionStagedInput(env, execution, payload) : resolveLatestEligibleTask001Input(env, { executionId: execution.execution_id, binding: bindings.get("GAPP_EXPORT")! }));
  if (!input.found) return { status: "WARNING" as const, resultCode: "NO_NEW_INPUT", resultMessage: "No eligible NEW input was found", reportResourceId: null };

  try {
    const snapshots = await recordedStep("T001_03_SNAPSHOT_RESOURCES", 3, { inputResourceId: input.resourceId }, async () => ({
      gapp: await snapshotGapp(env, execution.execution_id, input.resourceId),
      vendor: await snapshotSheet(env, execution.execution_id, bindings.get("VENDOR_DATA")!.resource_id, "TASK001_INPUT_VENDOR_DATA"),
      salesArea: await snapshotSheet(env, execution.execution_id, bindings.get("SALES_AREA")!.resource_id, "TASK001_INPUT_SALES_AREA"),
    }));

    const compute = await recordedStep("T001_04_COMPUTE_CANONICAL_ORDERS", 4, { snapshotHashes: { gapp: snapshots.gapp.hash, vendor: snapshots.vendor.hash, salesArea: snapshots.salesArea.hash }, mappingSetId: config.mappingSetId }, async () => computeTask001({
      gapp: await readR2Dataset(env, snapshots.gapp.resourceId),
      vendor: await readR2Dataset(env, snapshots.vendor.resourceId),
      salesArea: await readR2Dataset(env, snapshots.salesArea.resourceId),
      gappOrderBaseline: emptyDataset(),
      vendorOrderBaseline: emptyDataset(),
      requestedAt: formatHoChiMinhDateTime(new Date(execution.requested_at)),
      mappings: mappingBundle,
    }));

    if (compute.resultStatus === "FAILED") throw new Error(`${compute.resultCode}:${compute.resultMessage}`);
    if (mode === "PRODUCTION_DRY_RUN") {
      const reportResourceId = await uploadEvidence(env, execution.execution_id,{executionId:execution.execution_id,taskId:execution.task_id,executionMode:mode,configVersion:config.configVersion,mappingSetId:config.mappingSetId,inputResourceId:input.resourceId,inputCount:compute.inputCount,includedCount:compute.includedCount,skippedCount:compute.skipped.length,resultStatus:"SUCCESS",resultCode:"TASK001_PRODUCTION_DRY_RUN_OK",completedAt:new Date().toISOString()}, mode);
      await failInputProcessing(env,input.inputProcessingId,"TASK001_PRODUCTION_DRY_RUN","Dry run completed without consuming the input");
      return {status:"SUCCESS" as const,resultCode:"TASK001_PRODUCTION_DRY_RUN_OK",resultMessage:"Production contract dry run completed without external writes",reportResourceId};
    }

    if (compute.resultCode === "NO_VENDOR_ROWS") {
      const finalized = await recordedStep("T001_08_FINALIZE_INPUT_STATE", 10, { inputProcessingId: input.inputProcessingId }, async () => {
        await finalizeInputProcessing(env, input.inputProcessingId, "PROCESSED_NO_OUTPUT", "NO_VENDOR_ROWS", execution.requested_by_actor_id);
        let reportResourceId: string | null = null;
        try { reportResourceId = await uploadEvidence(env, execution.execution_id, {
          executionId: execution.execution_id, taskId: execution.task_id, configVersion: config.configVersion, mappingSetId: config.mappingSetId,
          inputProcessingId: input.inputProcessingId, inputResourceId: input.resourceId, inputGeneration: input.generation,
          resultStatus: "WARNING", resultCode: "NO_VENDOR_ROWS", inputCount: compute.inputCount, includedCount: compute.includedCount, skippedCount: compute.skipped.length,
          canonicalCommittedRows: 0, deliveryCommittedRows: 0, completedAt: new Date().toISOString(),
        }, mode); } catch {}
        return { inputStatus: "PROCESSED_NO_OUTPUT", reportResourceId };
      });
      if (isProduction && payload.automation?.sourceStartDate && payload.automation?.sourceEndDate) {
        await commitSourceCoverage(env,{taskId:execution.task_id,sourceRole:"GAPP_EXPORT",sourceStartDate:payload.automation.sourceStartDate,sourceEndDate:payload.automation.sourceEndDate,coverageType:"NO_VENDOR_ROWS",executionId:execution.execution_id,resourceId:input.resourceId});
        if (payload.automation.runDate && payload.automation.runSlot) await updateAutomationRun(env,execution.task_id,payload.automation.runDate,payload.automation.runSlot,{status:"WARNING",executionId:execution.execution_id,resultCode:"NO_VENDOR_ROWS"});
      }
      return { status: "WARNING" as const, resultCode: "NO_VENDOR_ROWS", resultMessage: compute.resultMessage, reportResourceId: finalized.reportResourceId };
    }

    const gappResourceId = bindings.get("GAPP_ORDER")!.resource_id;
    const gappNamespace = `GAPP_ORDER:${gappResourceId}`;
    const canonicalClaims = await recordedStep("T001_05_CLAIM_BUSINESS_KEYS", 5, { namespace: gappNamespace, orderIds: compute.gappRows.map((r) => normalize(r.order_id)) }, async () => classifyClaims(env, { executionId: execution.execution_id, namespace: gappNamespace, resourceId: gappResourceId, rows: compute.gappRows, fields: hashFields(compute.gappRows[0] ?? {}) }));

    const canonicalCommit = await recordedStep("T001_06_COMMIT_GAPP_ORDER", 6, { newCount: canonicalClaims.newRows.length, identicalCount: canonicalClaims.identicalRows.length }, async (attempt) => {
      if (!canonicalClaims.newRows.length) return { committedRows: 0, identicalRows: canonicalClaims.identicalRows.length, skippedWrite: true };
      const physical = await buildPhysicalRowsForGoogleSheet(env, gappResourceId, mappingBundle.gappOutput, canonicalClaims.newRows);
      const batchHash = await sha256HexBytes(new TextEncoder().encode(JSON.stringify(physical.rows)).buffer as ArrayBuffer);
      const result = await appendGoogleSheetWithCommit(env, { executionId: execution.execution_id, resourceId: gappResourceId, artifactRole: "TASK001_GAPP_ORDER_COMMIT", commitKey: `GAPP_ORDER:${input.inputProcessingId}:${batchHash}:A${attempt}`, rows: physical.rows, businessKey: canonicalClaims.newRows.map((r) => normalize(r.order_id)).join(","), stepCode: "T001_06_COMMIT_GAPP_ORDER", requestId: `WF_${execution.execution_id}` });
      if (result.kind === "ERROR") {
        if (result.error === "OUTPUT_COMMIT_UNKNOWN") {
          return { committedRows: 0, identicalRows: canonicalClaims.identicalRows.length, unknown: true, error: result.error };
        }
        throw new Error(`${result.error}:${result.message}`);
      }
      return { committedRows: result.appendedRows, identicalRows: canonicalClaims.identicalRows.length, idempotentReplay: result.idempotentReplay, unknown: false, outputCommitId: result.commit.output_commit_id };
    });

    if (canonicalCommit.unknown) {
      await recordedStep("T001_06B_MARK_GAPP_ORDER_UNKNOWN", 7, { claimCount: canonicalClaims.newClaimIds.length }, async () => { await markBusinessClaimsUnknown(env, canonicalClaims.newClaimIds); return { unknownClaims: canonicalClaims.newClaimIds.length }; });
      throw new Error("OUTPUT_COMMIT_UNKNOWN:Canonical GAPP_ORDER append result is ambiguous; automatic retry is blocked");
    }
    await recordedStep("T001_06B_FINALIZE_GAPP_ORDER_CLAIMS", 7, { claimCount: canonicalClaims.newClaimIds.length, outputCommitId: canonicalCommit.outputCommitId ?? null }, async () => {
      await markBusinessClaimsCommitted(env, canonicalClaims.newClaimIds);
      return { committedClaims: canonicalClaims.newClaimIds.length };
    });
    if (payload.testFaults?.failBeforeDeliveryCommit) throw new Error("TASK001_TEST_FAULT_BEFORE_DELIVERY_COMMIT");

    const deliveryResourceId = bindings.get("SMARTLINK_ORDER_DELIVERY")!.resource_id;
    const deliveryNamespace = `SMARTLINK_ORDER_DELIVERY:${deliveryResourceId}`;
    const deliveryClaims = await classifyClaims(env, { executionId: execution.execution_id, namespace: deliveryNamespace, resourceId: deliveryResourceId, rows: compute.vendorRows, fields: mappingBundle.deliveryOutput.map((m) => m.standardField) });
    if (payload.testFaults?.forceDeliveryUnknown) {
      await markBusinessClaimsUnknown(env, deliveryClaims.newClaimIds);
      throw new Error("TASK001_TEST_FORCED_DELIVERY_UNKNOWN");
    }

    const deliveryCommit = await recordedStep("T001_07_COMMIT_SMARTLINK_DELIVERY", 8, { newCount: deliveryClaims.newRows.length, identicalCount: deliveryClaims.identicalRows.length }, async (attempt) => {
      if (!deliveryClaims.newRows.length) return { committedRows: 0, identicalRows: deliveryClaims.identicalRows.length, skippedWrite: true };
      const physical = await buildPhysicalRowsForGoogleSheet(env, deliveryResourceId, mappingBundle.deliveryOutput, deliveryClaims.newRows);
      const batchHash = await sha256HexBytes(new TextEncoder().encode(JSON.stringify(physical.rows)).buffer as ArrayBuffer);
      const result = await appendGoogleSheetWithCommit(env, { executionId: execution.execution_id, resourceId: deliveryResourceId, artifactRole: "TASK001_SMARTLINK_DELIVERY_COMMIT", commitKey: `SMARTLINK_DELIVERY:${input.inputProcessingId}:${batchHash}:A${attempt}`, rows: physical.rows, businessKey: deliveryClaims.newRows.map((r) => normalize(r.order_id)).join(","), stepCode: "T001_07_COMMIT_SMARTLINK_DELIVERY", requestId: `WF_${execution.execution_id}` });
      if (result.kind === "ERROR") {
        if (result.error === "OUTPUT_COMMIT_UNKNOWN") {
          return { committedRows: 0, identicalRows: deliveryClaims.identicalRows.length, unknown: true, error: result.error };
        }
        throw new Error(`${result.error}:${result.message}`);
      }
      return { committedRows: result.appendedRows, identicalRows: deliveryClaims.identicalRows.length, idempotentReplay: result.idempotentReplay, unknown: false, outputCommitId: result.commit.output_commit_id };
    });

    if (deliveryCommit.unknown) {
      await recordedStep("T001_07B_MARK_SMARTLINK_DELIVERY_UNKNOWN", 9, { claimCount: deliveryClaims.newClaimIds.length }, async () => { await markBusinessClaimsUnknown(env, deliveryClaims.newClaimIds); return { unknownClaims: deliveryClaims.newClaimIds.length }; });
      throw new Error("OUTPUT_COMMIT_UNKNOWN:Smartlink delivery append result is ambiguous; automatic retry is blocked");
    }
    const deliveryFinalize = await recordedStep("T001_07B_FINALIZE_SMARTLINK_DELIVERY", 9, { claimCount: deliveryClaims.newClaimIds.length, outputCommitId: deliveryCommit.outputCommitId ?? null }, async () => {
      await markBusinessClaimsCommitted(env, deliveryClaims.newClaimIds);
      let notificationEventId: string | null = null;
      if (isProductionWrite && deliveryCommit.committedRows > 0 && deliveryCommit.outputCommitId) {
        const deliveryResource = await getResource(env, deliveryResourceId);
        const prepared = await prepareNotificationEvent(env,{ eventKey:`TASK001:DELIVERY_COMMIT:${deliveryCommit.outputCommitId}`,producer:"OPS",eventType:"DELIVERY_COMMITTED",entityType:"OUTPUT_COMMIT",entityId:deliveryCommit.outputCommitId,taskId:execution.task_id,executionId:execution.execution_id,outcome:"SUCCESS",resourceRole:"SMARTLINK_ORDER_DELIVERY",context:{runDate:payload.automation?.runDate||"",runSlot:payload.automation?.runSlot||"",sourceStartDate:payload.automation?.sourceStartDate||"",sourceEndDate:payload.automation?.sourceEndDate||"",deliveredRows:deliveryCommit.committedRows,appendedRows:deliveryCommit.committedRows,outputLink:deliveryResource?.business_uri||"",taskName:"Smartlink: Đặt hàng G-APP",executionId:execution.execution_id,outputCommitId:deliveryCommit.outputCommitId} });
        notificationEventId = prepared.notificationEventId;
      }
      try { await appendExecutionEvent(env, execution.execution_id, "TASK001_DELIVERY_COMMITTED", { deliveredOrderCount: deliveryCommit.committedRows, deliveryResourceId, outputCommitId: deliveryCommit.outputCommitId ?? null, notificationEventId }); } catch {}
      return { committedClaims: deliveryClaims.newClaimIds.length, notificationEventId };
    });
    const noNewOutput = canonicalCommit.committedRows === 0 && deliveryCommit.committedRows === 0;
    const warning = compute.requiredWarnings.length > 0 || canonicalClaims.identicalRows.length > 0 || deliveryClaims.identicalRows.length > 0;
    const resultCode = isProduction ? (warning ? "TASK001_PRODUCTION_WARNING" : "TASK001_PRODUCTION_SUCCESS") : (warning ? "TASK001_SAFE_WRITE_WARNING" : "TASK001_SAFE_WRITE_SUCCESS");
    const finalized = await recordedStep("T001_08_FINALIZE_INPUT_STATE", 10, { inputProcessingId: input.inputProcessingId }, async () => {
      await finalizeInputProcessing(env, input.inputProcessingId, noNewOutput ? "PROCESSED_NO_OUTPUT" : "PROCESSED", noNewOutput ? "DUPLICATE_IDENTICAL" : resultCode, execution.requested_by_actor_id);
      let reportResourceId: string | null = null;
      try { reportResourceId = await uploadEvidence(env, execution.execution_id, {
        executionId: execution.execution_id, taskId: execution.task_id, configVersion: config.configVersion, mappingSetId: config.mappingSetId,
        inputProcessingId: input.inputProcessingId, inputResourceId: input.resourceId, inputGeneration: input.generation,
        resultStatus: warning ? "WARNING" : "SUCCESS", resultCode, inputCount: compute.inputCount, includedCount: compute.includedCount, skippedCount: compute.skipped.length,
        requiredWarningCount: compute.requiredWarnings.length, canonicalCommittedRows: canonicalCommit.committedRows, canonicalIdenticalRows: canonicalClaims.identicalRows.length,
        deliveryCommittedRows: deliveryCommit.committedRows, deliveryIdenticalRows: deliveryClaims.identicalRows.length,
        gappOrderResourceId: gappResourceId, deliveryResourceId, completedAt: new Date().toISOString(),
      }, mode); } catch {}
      return { inputStatus: noNewOutput ? "PROCESSED_NO_OUTPUT" : "PROCESSED", reportResourceId };
    });
    if (isProduction && payload.automation?.sourceStartDate && payload.automation?.sourceEndDate) {
      await recordedStep("T001_09_ADVANCE_SOURCE_COVERAGE", 11, { sourceStartDate:payload.automation.sourceStartDate, sourceEndDate:payload.automation.sourceEndDate }, async () => commitSourceCoverage(env,{taskId:execution.task_id,sourceRole:"GAPP_EXPORT",sourceStartDate:payload.automation!.sourceStartDate!,sourceEndDate:payload.automation!.sourceEndDate!,coverageType:warning?"BUSINESS_WARNING":"BUSINESS_SUCCESS",executionId:execution.execution_id,resourceId:input.resourceId}));
      if (payload.automation.runDate && payload.automation.runSlot) await updateAutomationRun(env,execution.task_id,payload.automation.runDate,payload.automation.runSlot,{status:warning?"WARNING":"SUCCESS",executionId:execution.execution_id,resultCode});
    }
    let notificationStatus: string | null = null;
    if (isProductionWrite) {
      const notification = await recordedStep("T001_10_DELIVER_NOTIFICATION_EVENT", 12, { notificationEventId: deliveryFinalize.notificationEventId }, async () => {
        let current: any = null;
        if (deliveryFinalize.notificationEventId) {
          try { current = await deliverNotificationEvent(env, deliveryFinalize.notificationEventId); }
          catch (error) { current = {status:"FAILED",notificationEventId:deliveryFinalize.notificationEventId,error:error instanceof Error?error.message:String(error)}; }
        }
        try { await recoverTask001DeliveryNotificationOutbox(env,20); } catch {}
        try { await processNotificationBacklog(env,{taskId:execution.task_id,limit:10}); } catch {}
        return current || {status:"NONE",notificationEventId:null};
      });
      notificationStatus = notification.status;
    }
    const notificationWarning = notificationStatus === "FAILED" || notificationStatus === "UNKNOWN" || notificationStatus === "PARTIAL";
    const finalStatus = (warning || notificationWarning) ? "WARNING" as const : "SUCCESS" as const;
    const finalResultCode = notificationWarning ? `${resultCode}_NOTIFICATION_${notificationStatus}` : resultCode;
    if (isProduction && payload.automation?.runDate && payload.automation?.runSlot) {
      await updateAutomationRun(env, execution.task_id, payload.automation.runDate, payload.automation.runSlot, { status: finalStatus, executionId: execution.execution_id, resultCode: finalResultCode });
    }
    return {
      status: finalStatus,
      resultCode: finalResultCode,
      resultMessage: `Canonical committed ${canonicalCommit.committedRows}; Smartlink delivery committed ${deliveryCommit.committedRows}; ${compute.skipped.length} non-Smartlink rows skipped; notification=${notificationStatus || "NONE"}.`,
      reportResourceId: finalized.reportResourceId,
    };
  } catch (error) {
    try {
      const gappResourceId = bindings.get("GAPP_ORDER")?.resource_id;
      const deliveryResourceId = bindings.get("SMARTLINK_ORDER_DELIVERY")?.resource_id;
      const namespaces = [gappResourceId ? `GAPP_ORDER:${gappResourceId}` : "", deliveryResourceId ? `SMARTLINK_ORDER_DELIVERY:${deliveryResourceId}` : ""].filter(Boolean);
      await releaseUncommittedClaims(env, execution.execution_id, namespaces);
    } catch {}
    try { await failInputProcessing(env, input.inputProcessingId, "TASK001_EXECUTION_FAILED", errorText(error)); } catch {}
    throw error;
  }
}
