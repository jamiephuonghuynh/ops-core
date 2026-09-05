import type { BusinessKeyClaimRow, Env } from "../types";

export type ClaimDecision =
  | { kind: "NEW"; claim: BusinessKeyClaimRow }
  | { kind: "IDENTICAL"; claim: BusinessKeyClaimRow }
  | { kind: "CONFLICT"; claim: BusinessKeyClaimRow }
  | { kind: "BLOCKED"; claim: BusinessKeyClaimRow };

export async function claimBusinessKey(env: Env, input: { namespace: string; businessKey: string; payloadHash: string; executionId: string; resourceId: string }): Promise<ClaimDecision> {
  const now = new Date().toISOString();
  const candidate: BusinessKeyClaimRow = {
    business_key_claim_id: `BKC_${crypto.randomUUID()}`,
    namespace: input.namespace,
    business_key: input.businessKey,
    payload_hash: input.payloadHash,
    source_execution_id: input.executionId,
    canonical_resource_id: input.resourceId,
    status: "CLAIMED",
    created_at: now,
    updated_at: now,
    committed_at: null,
  };
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO business_key_claims (
      business_key_claim_id, namespace, business_key, payload_hash, source_execution_id,
      canonical_resource_id, status, created_at, updated_at, committed_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'CLAIMED', ?7, ?7, NULL)
  `).bind(candidate.business_key_claim_id, candidate.namespace, candidate.business_key, candidate.payload_hash, candidate.source_execution_id, candidate.canonical_resource_id, now).run();
  if (Number(result.meta.changes ?? 0) > 0) return { kind: "NEW", claim: candidate };
  const existing = await env.DB.prepare(`SELECT * FROM business_key_claims WHERE namespace = ?1 AND business_key = ?2`).bind(input.namespace, input.businessKey).first<BusinessKeyClaimRow>();
  if (!existing) throw new Error("BUSINESS_KEY_CLAIM_LOST");
  if (existing.status === "COMMITTED" && existing.payload_hash === input.payloadHash) return { kind: "IDENTICAL", claim: existing };
  if (existing.status === "COMMITTED") return { kind: "CONFLICT", claim: existing };
  if (existing.status === "CLAIMED" && existing.source_execution_id === input.executionId && existing.payload_hash === input.payloadHash) return { kind: "NEW", claim: existing };
  return { kind: "BLOCKED", claim: existing };
}

export async function markBusinessClaimsCommitted(env: Env, claimIds: string[]): Promise<void> {
  if (!claimIds.length) return;
  const now = new Date().toISOString();
  await env.DB.batch(claimIds.map((id) => env.DB.prepare(`
    UPDATE business_key_claims SET status = 'COMMITTED', committed_at = ?2, updated_at = ?2
    WHERE business_key_claim_id = ?1 AND status = 'CLAIMED'
  `).bind(id, now)));
}

export async function markBusinessClaimsUnknown(env: Env, claimIds: string[]): Promise<void> {
  if (!claimIds.length) return;
  const now = new Date().toISOString();
  await env.DB.batch(claimIds.map((id) => env.DB.prepare(`
    UPDATE business_key_claims SET status = 'UNKNOWN', updated_at = ?2
    WHERE business_key_claim_id = ?1 AND status = 'CLAIMED'
  `).bind(id, now)));
}

export async function releaseUncommittedClaims(env: Env, executionId: string, namespaces: string[]): Promise<void> {
  if (!namespaces.length) return;
  const placeholders = namespaces.map((_, i) => `?${i + 2}`).join(',');
  await env.DB.prepare(`DELETE FROM business_key_claims WHERE source_execution_id = ?1 AND status = 'CLAIMED' AND namespace IN (${placeholders})`).bind(executionId, ...namespaces).run();
}
