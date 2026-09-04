import { sha256HexBytes } from "../../artifacts/service";
import {
  GAPP_BUSINESS_HASH_FIELDS,
  GAPP_INPUT_MAPPINGS,
  GAPP_OUTPUT_MAPPINGS,
  GAPP_OUTPUT_FIELDS,
  SALES_AREA_INPUT_MAPPINGS,
  TASK001_TEXT_IDENTIFIER_FIELDS,
  VENDOR_BUSINESS_HASH_FIELDS,
  VENDOR_INPUT_MAPPINGS,
  VENDOR_OUTPUT_MAPPINGS,
  VENDOR_OUTPUT_FIELDS,
  type Task001FieldMapping,
} from "./definition";
import { detectDuplicateOrders, type DuplicateResult } from "./duplicates";
import { buildSalesAreaIndex, enrichGeoFields, normalize, type StandardRow } from "./geo";

export interface NormalizedDataset { headers: unknown[]; rows: unknown[][] }
export interface RequiredWarning { rowNumber: number; field: string }
export interface SkippedRow { rowNumber: number; order_id: string; product_code: string; vendor_id: string; reason: "NOT_SMARTLINK_VENDOR" | "UNKNOWN_VENDOR_MAPPING" }

export interface Task001ComputeInput {
  gapp: NormalizedDataset;
  vendor: NormalizedDataset;
  salesArea: NormalizedDataset;
  gappOrderBaseline: NormalizedDataset;
  vendorOrderBaseline: NormalizedDataset;
  requestedAt: string;
}

export interface Task001ComputeResult {
  resultStatus: "SUCCESS" | "WARNING" | "FAILED";
  resultCode: string;
  resultMessage: string;
  inputCount: number;
  includedCount: number;
  includedOrderIds: string[];
  skipped: SkippedRow[];
  requiredWarnings: RequiredWarning[];
  vendorDuplicates: DuplicateResult;
  gappDuplicates: DuplicateResult;
  gappRows: StandardRow[];
  vendorRows: StandardRow[];
  gappBusinessHash: string;
  vendorBusinessHash: string;
}

function coerce(value: unknown, dataType: Task001FieldMapping["dataType"]): unknown {
  if (value == null) return "";
  if (dataType === "text") return normalize(value);
  if (dataType === "number") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return value;
}

function rowsToObjects(dataset: NormalizedDataset): StandardRow[] {
  const headers = dataset.headers.map(normalize);
  return dataset.rows.map((values) => {
    const row: StandardRow = {};
    headers.forEach((header, index) => { if (header) row[header] = values[index] ?? ""; });
    return row;
  });
}

function mapRows(dataset: NormalizedDataset, mappings: Task001FieldMapping[]): StandardRow[] {
  return rowsToObjects(dataset).map((raw) => {
    const standard: StandardRow = {};
    for (const mapping of mappings) standard[mapping.standardField] = coerce(raw[mapping.sourceField], mapping.dataType);
    return standard;
  });
}

function validateRequired(rows: StandardRow[], mappings: Task001FieldMapping[]): RequiredWarning[] {
  const warnings: RequiredWarning[] = [];
  const required = mappings.filter((mapping) => mapping.required);
  rows.forEach((row, index) => required.forEach((mapping) => {
    if (!normalize(row[mapping.standardField])) warnings.push({ rowNumber: index + 1, field: mapping.standardField });
  }));
  return warnings;
}

function parseMoney(value: unknown): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value;
  let cleaned = String(value).trim().replace(/[^0-9,.-]/g, "");
  if (!cleaned) return 0;
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")) cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    else cleaned = cleaned.replace(/,/g, "");
  } else if (hasComma) {
    const parts = cleaned.split(",");
    cleaned = parts.length === 2 && parts[1].length <= 2 ? `${parts[0].replace(/,/g, "")}.${parts[1]}` : cleaned.replace(/,/g, "");
  } else if (hasDot) {
    const parts = cleaned.split(".");
    if (!(parts.length === 2 && parts[1].length <= 2)) cleaned = cleaned.replace(/\./g, "");
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function calculateAmount(unitPrice: unknown, quantity: unknown): number | "" {
  if (!normalize(unitPrice) || !normalize(quantity)) return "";
  const u = parseMoney(unitPrice);
  const q = parseMoney(quantity);
  return Number.isFinite(u) && Number.isFinite(q) ? u * q : "";
}

function buildVendorIndex(rows: StandardRow[]): Record<string, StandardRow> {
  const index: Record<string, StandardRow> = {};
  for (const row of rows) {
    const code = normalize(row.standard_code);
    if (!code) continue;
    index[code] = {
      vendor_id: normalize(row.vendor_id),
      standard_code: code,
      standard_name: normalize(row.standard_name),
      unit_price: normalize(row.unit_price) === "" ? "" : parseMoney(row.unit_price),
    };
  }
  return index;
}

function filterSmartlink(rows: StandardRow[], vendorIndex: Record<string, StandardRow>): { included: StandardRow[]; skipped: SkippedRow[] } {
  const included: StandardRow[] = [];
  const skipped: SkippedRow[] = [];
  rows.forEach((row, index) => {
    const productCode = normalize(row.product_code);
    const vendor = vendorIndex[productCode];
    const vendorId = vendor ? normalize(vendor.vendor_id) : "";
    if (vendor && vendorId.toLowerCase() === "smartlink") {
      row.vendor_id = vendorId;
      row.unit_price = vendor.unit_price;
      row.amount = calculateAmount(row.unit_price, row.quantity);
      included.push(row);
    } else {
      skipped.push({ rowNumber: index + 2, order_id: normalize(row.order_id), product_code: productCode, vendor_id: vendorId, reason: vendor ? "NOT_SMARTLINK_VENDOR" : "UNKNOWN_VENDOR_MAPPING" });
    }
  });
  return { included, skipped };
}

function normalizeTextIdentifiers(rows: StandardRow[]): void {
  for (const row of rows) for (const field of TASK001_TEXT_IDENTIFIER_FIELDS) if (row[field] != null && row[field] !== "") row[field] = String(row[field]);
}

function mapBaseline(dataset: NormalizedDataset, outputMappings: Task001FieldMapping[]): Record<string, StandardRow> {
  const headerToStandard: Record<string, string> = {};
  outputMappings.forEach((mapping) => { headerToStandard[normalize(mapping.sourceField)] = mapping.standardField; });
  const headers = dataset.headers.map(normalize);
  const result: Record<string, StandardRow> = {};
  for (const values of dataset.rows) {
    const row: StandardRow = {};
    headers.forEach((header, index) => {
      const field = headerToStandard[header];
      if (field) row[field] = values[index] ?? "";
    });
    const orderId = normalize(row.order_id);
    if (orderId) result[orderId] = row;
  }
  return result;
}

function projectRows(rows: StandardRow[], fields: string[]): StandardRow[] {
  return rows.map((row) => {
    const projected: StandardRow = {};
    for (const field of fields) projected[field] = row[field] ?? "";
    return projected;
  });
}

async function stableBusinessHash(rows: StandardRow[], fields: string[]): Promise<string> {
  const canonical = JSON.stringify(rows.map((row) => fields.map((field) => normalize(row[field]))));
  return sha256HexBytes(new TextEncoder().encode(canonical).buffer as ArrayBuffer);
}

export async function computeTask001(input: Task001ComputeInput): Promise<Task001ComputeResult> {
  const standardRows = mapRows(input.gapp, GAPP_INPUT_MAPPINGS);
  const requiredWarnings = validateRequired(standardRows, GAPP_INPUT_MAPPINGS);
  const vendorRows = mapRows(input.vendor, VENDOR_INPUT_MAPPINGS);
  const salesAreaRows = mapRows(input.salesArea, SALES_AREA_INPUT_MAPPINGS);
  const routed = filterSmartlink(standardRows, buildVendorIndex(vendorRows));
  const salesAreaIndex = buildSalesAreaIndex(salesAreaRows);
  enrichGeoFields(routed.included, salesAreaIndex);
  normalizeTextIdentifiers(routed.included);

  if (!routed.included.length) {
    return {
      resultStatus: "WARNING", resultCode: "NO_VENDOR_ROWS", resultMessage: `No Smartlink rows found. ${routed.skipped.length} rows skipped.`,
      inputCount: standardRows.length, includedCount: 0, includedOrderIds: [], skipped: routed.skipped, requiredWarnings,
      vendorDuplicates: { warnings: [], errors: [], skipOrderIds: {} }, gappDuplicates: { warnings: [], errors: [], skipOrderIds: {} },
      gappRows: [], vendorRows: [], gappBusinessHash: await stableBusinessHash([], GAPP_BUSINESS_HASH_FIELDS), vendorBusinessHash: await stableBusinessHash([], VENDOR_BUSINESS_HASH_FIELDS),
    };
  }

  const vendorDuplicates = detectDuplicateOrders(routed.included, mapBaseline(input.vendorOrderBaseline, VENDOR_OUTPUT_MAPPINGS));
  const gappDuplicates = detectDuplicateOrders(routed.included, mapBaseline(input.gappOrderBaseline, GAPP_OUTPUT_MAPPINGS));
  const duplicateErrors = [...vendorDuplicates.errors, ...gappDuplicates.errors];
  if (duplicateErrors.length) {
    return {
      resultStatus: "FAILED", resultCode: "DUPLICATE_CONFLICT", resultMessage: `Conflicting duplicate order_id found: ${duplicateErrors.length}`,
      inputCount: standardRows.length, includedCount: routed.included.length, includedOrderIds: routed.included.map((row) => normalize(row.order_id)), skipped: routed.skipped, requiredWarnings, vendorDuplicates, gappDuplicates,
      gappRows: [], vendorRows: [], gappBusinessHash: await stableBusinessHash([], GAPP_BUSINESS_HASH_FIELDS), vendorBusinessHash: await stableBusinessHash([], VENDOR_BUSINESS_HASH_FIELDS),
    };
  }

  const vendorRowsToAppend = routed.included.filter((row) => !vendorDuplicates.skipOrderIds[normalize(row.order_id)]);
  const gappRowsToAppend = routed.included.filter((row) => !gappDuplicates.skipOrderIds[normalize(row.order_id)]);
  vendorRowsToAppend.forEach((row) => { row.requested_at = input.requestedAt; });
  gappRowsToAppend.forEach((row) => { row.requested_at = input.requestedAt; });
  const projectedGapp = projectRows(gappRowsToAppend, GAPP_OUTPUT_FIELDS);
  const projectedVendor = projectRows(vendorRowsToAppend, VENDOR_OUTPUT_FIELDS);
  const warningCount = requiredWarnings.length + vendorDuplicates.warnings.length + gappDuplicates.warnings.length;
  const status = warningCount ? "WARNING" : "SUCCESS";
  return {
    resultStatus: status,
    resultCode: warningCount ? "TASK001_WARNING" : "TASK001_SHADOW_SUCCESS",
    resultMessage: [
      `Predicted ${projectedGapp.length} G-APP ORDER rows.`,
      `Predicted ${projectedVendor.length} Smartlink rows.`,
      routed.skipped.length ? `${routed.skipped.length} non-Smartlink rows skipped.` : "",
      vendorDuplicates.warnings.length ? `${vendorDuplicates.warnings.length} duplicate identical Smartlink rows skipped.` : "",
      gappDuplicates.warnings.length ? `${gappDuplicates.warnings.length} duplicate identical G-APP ORDER rows skipped.` : "",
      requiredWarnings.length ? `${requiredWarnings.length} required-field warnings.` : "",
    ].filter(Boolean).join(" "),
    inputCount: standardRows.length, includedCount: routed.included.length, includedOrderIds: routed.included.map((row) => normalize(row.order_id)), skipped: routed.skipped, requiredWarnings, vendorDuplicates, gappDuplicates,
    gappRows: projectedGapp, vendorRows: projectedVendor,
    gappBusinessHash: await stableBusinessHash(projectedGapp, GAPP_BUSINESS_HASH_FIELDS),
    vendorBusinessHash: await stableBusinessHash(projectedVendor, VENDOR_BUSINESS_HASH_FIELDS),
  };
}
