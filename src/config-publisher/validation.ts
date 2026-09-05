import type { BindingDirection, MappingDirection } from "../types";

export interface PublishedBindingInput {
  role: string;
  direction: BindingDirection;
  resourceId: string;
  config: Record<string, unknown>;
}

export interface PublishedMappingInput {
  role: string;
  direction: MappingDirection;
  sourceConfigId: string;
  sourceField: string;
  standardField: string;
  dataType: "text" | "number" | "datetime";
  required: boolean;
  ordinal: number;
}

const REQUIRED_ROLES = ["GAPP_EXPORT", "VENDOR_DATA", "SALES_AREA", "GAPP_ORDER", "SMARTLINK_ORDER_DELIVERY"];

export function validateTask001PublishedConfig(bindings: PublishedBindingInput[], mappings: PublishedMappingInput[]): string[] {
  const errors: string[] = [];
  const roleCount = new Map<string, number>();
  for (const binding of bindings) roleCount.set(binding.role, (roleCount.get(binding.role) ?? 0) + 1);
  for (const role of REQUIRED_ROLES) {
    if ((roleCount.get(role) ?? 0) !== 1) errors.push(`TASK001_BINDING_ROLE_INVALID:${role}:${roleCount.get(role) ?? 0}`);
  }
  const keys = new Set<string>();
  for (const mapping of mappings) {
    if (!mapping.sourceField.trim() || !mapping.standardField.trim()) errors.push(`TASK001_MAPPING_EMPTY_FIELD:${mapping.sourceConfigId}`);
    if (!['text','number','datetime'].includes(mapping.dataType)) errors.push(`TASK001_MAPPING_INVALID_DATATYPE:${mapping.sourceConfigId}:${mapping.dataType}`);
    const key = `${mapping.role}|${mapping.direction}|${mapping.sourceField.trim()}`;
    if (keys.has(key)) errors.push(`TASK001_MAPPING_DUPLICATE_SOURCE_FIELD:${key}`);
    keys.add(key);
  }
  for (const role of ["GAPP_EXPORT", "VENDOR_DATA", "SALES_AREA"]) {
    if (!mappings.some((m) => m.role === role && m.direction === "INPUT")) errors.push(`TASK001_MAPPING_ROLE_MISSING:${role}:INPUT`);
  }
  for (const role of ["GAPP_ORDER", "SMARTLINK_ORDER_DELIVERY"]) {
    if (!mappings.some((m) => m.role === role && m.direction === "OUTPUT")) errors.push(`TASK001_MAPPING_ROLE_MISSING:${role}:OUTPUT`);
  }
  const gappOutputStandards = new Set(mappings.filter((m) => m.role === "GAPP_ORDER" && m.direction === "OUTPUT").map((m) => m.standardField));
  if (!gappOutputStandards.has("order_id")) errors.push("TASK001_GAPP_ORDER_ORDER_ID_MAPPING_REQUIRED");
  const deliveryStandards = new Set(mappings.filter((m) => m.role === "SMARTLINK_ORDER_DELIVERY" && m.direction === "OUTPUT").map((m) => m.standardField));
  if (!deliveryStandards.has("order_id")) errors.push("TASK001_DELIVERY_ORDER_ID_MAPPING_REQUIRED");
  return errors;
}
