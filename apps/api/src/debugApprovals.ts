// apps/api/src/debugApprovals.ts
import { __unsafe_listApprovalKeys, __unsafe_key } from "./approvalStore";

export function listApprovalsForRun(runId: string): string[] {
  return __unsafe_listApprovalKeys().filter((k) => k.startsWith(`${runId}:`));
}

export function expectedApprovalKey(runId: string, action: string, id: string) {
  return __unsafe_key(runId, action, id);
}
