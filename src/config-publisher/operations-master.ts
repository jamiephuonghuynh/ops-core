import { sha256HexBytes } from "../artifacts/service";
import { getResource } from "../db/resources";
import { registerGoogleDriveFileResource, registerGoogleDriveFolderResource, registerGoogleSheetResource } from "../google/resources";
import { readNormalizedSheet } from "../google/sheets";
import type { Env, GoogleCellValue } from "../types";
import { validateTask001PublishedConfig, type PublishedBindingInput, type PublishedMappingInput } from "./validation";

const TASK001_ID = "task001_smartlink_order";

function text(value: unknown): string { return value == null ? "" : String(value).trim(); }
function upper(value: unknown): string { return text(value).toUpperCase(); }
function tableRows(headers: GoogleCellValue[], rows: GoogleCellValue[][]): Record<string, unknown>[] {
  const names = headers.map(text);
  return rows.map((values) => Object.fromEntries(names.map((h, i) => [h, values[i] ?? ""])));
}
function roleAlias(role: string): string { return role === "VENDOR_ORDER" ? "SMARTLINK_ORDER_DELIVERY" : role; }

async function resourceForInput(env: Env, row: Record<string, unknown>): Promise<string> {
  const type = upper(row.InputType);
  const externalId = text(row.InputResourceID);
  if (!externalId) throw new Error(`TASK001_INPUT_RESOURCE_ID_MISSING:${text(row.InputID)}`);
  if (type === "GOOGLE_SHEET") {
    return (await registerGoogleSheetResource(env, { spreadsheetId: externalId, sheetName: text(row.SheetName), range: "A:ZZZ", headerRow: 1, businessUri: text(row.InputResourceLink) || null })).resource.resource_id;
  }
  if (type === "DRIVE_FOLDER") return (await registerGoogleDriveFolderResource(env, externalId)).resource.resource_id;
  if (type === "DRIVE_FILE") return (await registerGoogleDriveFileResource(env, externalId)).resource.resource_id;
  throw new Error(`TASK001_UNSUPPORTED_INPUT_TYPE:${type}`);
}

async function resourceForOutput(env: Env, row: Record<string, unknown>): Promise<string> {
  const externalId = text(row.OutputResourceID);
  const sheetName = text(row.SheetName);
  if (!externalId || !sheetName) throw new Error(`TASK001_OUTPUT_RESOURCE_INVALID:${text(row.OutputID)}`);
  return (await registerGoogleSheetResource(env, { spreadsheetId: externalId, sheetName, range: "A:ZZZ", headerRow: 1, businessUri: text(row.OutputResourceLink) || null })).resource.resource_id;
}

export async function publishTask001ConfigFromOperationsMaster(env: Env, input: { operationsMasterResourceId: string; publishedBy: string | null }) {
  const masterResource = await getResource(env, input.operationsMasterResourceId);
  if (!masterResource || masterResource.provider !== "GOOGLE" || masterResource.resource_type !== "GOOGLE_SHEET" || !masterResource.external_id) {
    throw new Error("OPERATIONS_MASTER_RESOURCE_INVALID");
  }
  const spreadsheetId = masterResource.external_id;
  const [inputsDs, outputsDs, mappingsDs] = await Promise.all([
    readNormalizedSheet(env, spreadsheetId, "INPUTS", "A:Z", 1),
    readNormalizedSheet(env, spreadsheetId, "OUTPUTS", "A:Z", 1),
    readNormalizedSheet(env, spreadsheetId, "FIELD_MAPPING", "A:P", 1),
  ]);
  const inputRows = tableRows(inputsDs.headers, inputsDs.rows).filter((r) => text(r.TaskID) === TASK001_ID && upper(r.ActiveStatus) === "ACTIVE");
  const outputRows = tableRows(outputsDs.headers, outputsDs.rows).filter((r) => text(r.TaskID) === TASK001_ID && upper(r.ActiveStatus) === "ACTIVE");
  const mappingRows = tableRows(mappingsDs.headers, mappingsDs.rows).filter((r) => text(r.TaskID) === TASK001_ID && upper(r.ActiveStatus) === "ACTIVE");

  const inputRoleById = new Map<string, string>();
  const outputRoleById = new Map<string, string>();
  const bindings: PublishedBindingInput[] = [];
  for (const row of inputRows) {
    const role = roleAlias(text(row.InputRole));
    const id = text(row.InputID);
    inputRoleById.set(id, role);
    bindings.push({ role, direction: role === "GAPP_EXPORT" ? "INPUT" : "REFERENCE", resourceId: await resourceForInput(env, row), config: { sourceConfigId: id, selectionMode: upper(row.SelectionMode), fileMimeType: text(row.FileMimeType), sourceType: upper(row.InputType) } });
  }
  for (const row of outputRows) {
    const role = roleAlias(text(row.OutputRole));
    const id = text(row.OutputID);
    outputRoleById.set(id, role);
    bindings.push({ role, direction: role === "SMARTLINK_ORDER_DELIVERY" ? "DELIVERY" : "OUTPUT", resourceId: await resourceForOutput(env, row), config: { sourceConfigId: id, outputMode: upper(row.OutputMode), deliveryMode: upper(row.DeliveryMode), sourceType: upper(row.OutputType), legacyOutputRole: text(row.OutputRole) } });
  }

  const mappings: PublishedMappingInput[] = [];
  mappingRows.forEach((row, index) => {
    const inputId = text(row.InputID);
    const outputId = text(row.OutputID);
    const direction = inputId ? "INPUT" : "OUTPUT";
    const role = inputId ? inputRoleById.get(inputId) : outputRoleById.get(outputId);
    if (!role) return;
    mappings.push({
      role,
      direction,
      sourceConfigId: inputId || outputId,
      sourceField: text(row.SourceField),
      standardField: text(row.StandardField),
      dataType: (text(row.DataType).toLowerCase() || "text") as "text" | "number" | "datetime",
      required: upper(row.Required) === "Y",
      ordinal: index + 1,
    });
  });

  const errors = validateTask001PublishedConfig(bindings, mappings);
  if (errors.length) return { ok: false as const, errors };

  const canonical = JSON.stringify({
    taskId: TASK001_ID,
    bindings: bindings.map((b) => ({ role: b.role, direction: b.direction, resourceId: b.resourceId, config: b.config })),
    mappings: mappings.map((m) => ({ role: m.role, direction: m.direction, sourceConfigId: m.sourceConfigId, sourceField: m.sourceField, standardField: m.standardField, dataType: m.dataType, required: m.required, ordinal: m.ordinal })),
  });
  const sourceHash = await sha256HexBytes(new TextEncoder().encode(canonical).buffer as ArrayBuffer);
  const now = new Date().toISOString();
  const version = `CFG_${now.replace(/[-:.TZ]/g, "").slice(0, 17)}_${sourceHash.slice(0, 8)}_${crypto.randomUUID().slice(0, 6)}`;
  const mappingSetId = `MAPSET_${crypto.randomUUID()}`;

  await env.DB.prepare(`
    INSERT INTO field_mapping_sets (mapping_set_id, task_id, mapping_version, source_resource_id, source_hash, status, published_at, published_by, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'DRAFT', NULL, ?6, ?7, ?7)
  `).bind(mappingSetId, TASK001_ID, version, input.operationsMasterResourceId, sourceHash, input.publishedBy, now).run();

  if (mappings.length) {
    await env.DB.batch(mappings.map((m) => env.DB.prepare(`
      INSERT INTO field_mapping_entries (mapping_entry_id, mapping_set_id, binding_role, mapping_direction, source_config_id, source_field, standard_field, data_type, required_flag, ordinal, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `).bind(`MAPE_${crypto.randomUUID()}`, mappingSetId, m.role, m.direction, m.sourceConfigId, m.sourceField, m.standardField, m.dataType, m.required ? 1 : 0, m.ordinal, now)));
  }
  if (bindings.length) {
    await env.DB.batch(bindings.map((b) => env.DB.prepare(`
      INSERT INTO resource_bindings (binding_id, task_id, binding_role, binding_direction, resource_id, binding_version, active_status, config_json, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'INACTIVE', ?7, ?8, ?8)
    `).bind(`BND_${crypto.randomUUID()}`, TASK001_ID, b.role, b.direction, b.resourceId, version, JSON.stringify(b.config), now)));
  }
  const activation = [
    env.DB.prepare(`UPDATE field_mapping_sets SET status = 'SUPERSEDED', updated_at = ?2 WHERE task_id = ?1 AND status = 'PUBLISHED'`).bind(TASK001_ID, now),
    env.DB.prepare(`UPDATE resource_bindings SET active_status = 'INACTIVE', updated_at = ?2 WHERE task_id = ?1 AND active_status = 'ACTIVE'`).bind(TASK001_ID, now),
    env.DB.prepare(`UPDATE field_mapping_sets SET status = 'PUBLISHED', published_at = ?2, updated_at = ?2 WHERE mapping_set_id = ?1`).bind(mappingSetId, now),
    env.DB.prepare(`UPDATE resource_bindings SET active_status = 'ACTIVE', updated_at = ?3 WHERE task_id = ?1 AND binding_version = ?2`).bind(TASK001_ID, version, now),
  ];
  await env.DB.batch(activation);
  return { ok: true as const, taskId: TASK001_ID, configVersion: version, mappingSetId, sourceHash, bindingCount: bindings.length, mappingCount: mappings.length };
}
