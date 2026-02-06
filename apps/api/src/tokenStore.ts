// /Users/partha/Desktop/cliniq/apps/api/src/tokenStore.ts

/* -------------------- types -------------------- */

export type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
};

export type SlackTokens = {
  access_token: string;
  team_id?: string;
  team_name?: string;
  user_id?: string;
};

export type RunTokens = {
  google?: GoogleTokens;
  slack?: SlackTokens;
};

/* -------------------- store -------------------- */

const runTokens = new Map<string, RunTokens>();

/**
 * Back-compat: existing Google code calls setRunTokens(runId, Tokens)
 * We store it under runTokens[runId].google
 */
export function setRunTokens(runId: string, t: GoogleTokens) {
  const cur = runTokens.get(runId) || {};
  cur.google = t;
  runTokens.set(runId, cur);
  console.log("[API][tokenStore] set google", { runId, hasRefresh: !!t.refresh_token });
}

/**
 * Back-compat: existing Google code calls getRunTokens(runId)
 * Return the Google token bundle (or null).
 */
export function getRunTokens(runId: string): GoogleTokens | null {
  const cur = runTokens.get(runId);
  return cur?.google || null;
}

/**
 * Generic provider setter for Slack/Google etc.
 */
export function setProviderToken<K extends keyof RunTokens>(
  runId: string,
  provider: K,
  value: NonNullable<RunTokens[K]>
) {
  const cur = runTokens.get(runId) || {};
  (cur as any)[provider] = value;
  runTokens.set(runId, cur);
  console.log("[API][tokenStore] set provider", { runId, provider });
}

export function getProviderToken<K extends keyof RunTokens>(
  runId: string,
  provider: K
): RunTokens[K] | null {
  const cur = runTokens.get(runId) || null;
  if (!cur) return null;
  return (cur[provider] as any) || null;
}

export function clearRunTokens(runId: string) {
  runTokens.delete(runId);
  console.log("[API][tokenStore] cleared", { runId });
}
