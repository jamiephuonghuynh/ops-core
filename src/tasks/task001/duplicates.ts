import { TASK001_COMPARABLE_FIELDS } from "./definition";
import { normalize, type StandardRow } from "./geo";

export interface DuplicateIssue {
  rowNumber: number;
  order_id: string;
  reason: "DUPLICATE_IDENTICAL_IN_INPUT" | "DUPLICATE_CONFLICT_IN_INPUT" | "DUPLICATE_IDENTICAL_IN_TARGET" | "DUPLICATE_CONFLICT_IN_TARGET";
}

export interface DuplicateResult {
  warnings: DuplicateIssue[];
  errors: DuplicateIssue[];
  skipOrderIds: Record<string, true>;
}

export function comparablePayload(row: StandardRow): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const field of TASK001_COMPARABLE_FIELDS) payload[field] = normalize(row[field]);
  return payload;
}

function comparableKey(row: StandardRow): string {
  return JSON.stringify(comparablePayload(row));
}

export function detectDuplicateOrders(rows: StandardRow[], existingByOrderId: Record<string, StandardRow>): DuplicateResult {
  const warnings: DuplicateIssue[] = [];
  const errors: DuplicateIssue[] = [];
  const skipOrderIds: Record<string, true> = {};
  const seenThisRun: Record<string, string> = {};
  rows.forEach((row, idx) => {
    const orderId = normalize(row.order_id);
    if (!orderId) return;
    const currentKey = comparableKey(row);
    if (seenThisRun[orderId]) {
      if (seenThisRun[orderId] === currentKey) {
        warnings.push({ rowNumber: idx + 2, order_id: orderId, reason: "DUPLICATE_IDENTICAL_IN_INPUT" });
        skipOrderIds[orderId] = true;
      } else {
        errors.push({ rowNumber: idx + 2, order_id: orderId, reason: "DUPLICATE_CONFLICT_IN_INPUT" });
      }
      return;
    }
    seenThisRun[orderId] = currentKey;
    const existing = existingByOrderId[orderId];
    if (!existing) return;
    if (comparableKey(existing) === currentKey) {
      warnings.push({ rowNumber: idx + 2, order_id: orderId, reason: "DUPLICATE_IDENTICAL_IN_TARGET" });
      skipOrderIds[orderId] = true;
    } else {
      errors.push({ rowNumber: idx + 2, order_id: orderId, reason: "DUPLICATE_CONFLICT_IN_TARGET" });
    }
  });
  return { warnings, errors, skipOrderIds };
}
