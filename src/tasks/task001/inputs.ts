import { appendExecutionEvent } from "../../db/events";
import { createAvailableInput, getLatestInputProcessing, getPendingManualReprocess, claimInputForExecution } from "../../db/input-processing";
import { getResource } from "../../db/resources";
import { listDriveFolderFiles } from "../../google/drive";
import { registerGoogleDriveFileResource } from "../../google/resources";
import type { Env, ResourceBindingRow } from "../../types";

function isXlsx(name: string, mimeType: string): boolean {
  const lowerName = name.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  return lowerName.endsWith(".xlsx") || lowerMime.includes("spreadsheetml");
}

export async function resolveLatestEligibleTask001Input(env: Env, input: { executionId: string; binding: ResourceBindingRow }) {
  const resource = await getResource(env, input.binding.resource_id);
  if (!resource || resource.provider !== "GOOGLE" || resource.resource_type !== "API_RESOURCE" || !resource.external_id) throw new Error("TASK001_GAPP_EXPORT_BINDING_INVALID");
  let metadata: { kind?: string; fileMimeType?: string; selectionMode?: string } = {};
  try { metadata = { ...JSON.parse(resource.metadata_json), ...JSON.parse(input.binding.config_json || "{}") }; } catch { metadata = {}; }
  if (metadata.kind !== "DRIVE_FOLDER") throw new Error("TASK001_GAPP_EXPORT_NOT_DRIVE_FOLDER");
  if ((metadata.selectionMode || "LATEST_NEW").toUpperCase() !== "LATEST_NEW") throw new Error("TASK001_ONLY_LATEST_NEW_SUPPORTED_IN_PHASE5");

  const manual = await getPendingManualReprocess(env, "task001_smartlink_order", "GAPP_EXPORT");
  if (manual) {
    const claimed = await claimInputForExecution(env, manual.input_processing_id, input.executionId);
    if (claimed) {
      await appendExecutionEvent(env, input.executionId, "TASK001_INPUT_CLAIMED", {
        inputProcessingId: manual.input_processing_id, resourceId: manual.resource_id, resourceIdentity: manual.resource_identity, generation: manual.generation, manualReprocess: true,
      });
      const manualResource = await getResource(env, manual.resource_id);
      return { found: true as const, inputProcessingId: manual.input_processing_id, generation: manual.generation, resourceId: manual.resource_id, resourceIdentity: manual.resource_identity, fileName: manualResource?.file_name ?? null };
    }
  }

  const files = (await listDriveFolderFiles(env, resource.external_id)).filter((f) => isXlsx(f.name, f.mimeType));
  for (const file of files) {
    const registered = await registerGoogleDriveFileResource(env, file.id);
    const identity = `gdrive:${file.id}`;
    let state = await getLatestInputProcessing(env, "task001_smartlink_order", "GAPP_EXPORT", identity);
    if (!state) {
      state = await createAvailableInput(env, {
        taskId: "task001_smartlink_order",
        inputRole: "GAPP_EXPORT",
        resourceId: registered.resource.resource_id,
        resourceIdentity: identity,
        contentHash: file.md5Checksum ?? null,
        detectedAt: file.modifiedTime ?? new Date().toISOString(),
      });
    }
    if (["PROCESSED", "PROCESSED_NO_OUTPUT", "PROCESSING"].includes(state.status)) continue;
    const claimed = await claimInputForExecution(env, state.input_processing_id, input.executionId);
    if (!claimed) continue;
    await appendExecutionEvent(env, input.executionId, "TASK001_INPUT_CLAIMED", {
      inputProcessingId: state.input_processing_id,
      resourceId: registered.resource.resource_id,
      resourceIdentity: identity,
      generation: state.generation,
      fileName: file.name,
      modifiedTime: file.modifiedTime ?? null,
    });
    return {
      found: true as const,
      inputProcessingId: state.input_processing_id,
      generation: state.generation,
      resourceId: registered.resource.resource_id,
      resourceIdentity: identity,
      fileName: file.name,
    };
  }
  return { found: false as const };
}
