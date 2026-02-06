// apps/api/src/approvalStore.ts

type ApprovalPayload = Record<string, any> & { ts?: number; id?: string };

const approvals = new Map<string, ApprovalPayload>();

function key(runId: string, action: string, id?: string) {
  return `${runId}:${action}:${id || ""}`;
}

function pickId(payload: any) {
  return String(payload?.id || payload?.draftId || payload?.messageId || "").trim();
}

export function setApproval(runId: string, action: string, payload: any) {
  const id = pickId(payload);
  approvals.set(key(runId, action, id), { ts: Date.now(), ...payload, id });
  return { id, key: key(runId, action, id) };
}

export function getApproval(runId: string, action: string, id?: string) {
  return approvals.get(key(runId, action, id));
}

export function consumeApproval(runId: string, action: string, id?: string) {
  const k = key(runId, action, id);
  const v = approvals.get(k);
  if (v) approvals.delete(k);
  return v || null;
}

/**
 * DEV ONLY: list stored approval keys so we can debug approval mismatches.
 * Do not expose this in production without auth.
 */
export function __unsafe_listApprovalKeys(): string[] {
  return Array.from(approvals.keys());
}

export function __unsafe_key(runId: string, action: string, id?: string) {
  return key(runId, action, id);
}