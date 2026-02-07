// /Users/partha/Desktop/cliniq/apps/api/src/tokenStore.ts
import { supabase } from "./supabase";

/* -------------------- types -------------------- */

export type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number; // ms since epoch
  scope?: string;
};

export type SlackTokens = {
  access_token: string;
  team_id?: string;
  team_name?: string;
  user_id?: string; // slack user id
};

export type RunTokens = {
  google?: GoogleTokens;
  slack?: SlackTokens;
};

/* -------------------- legacy per-run store (kept for safety) -------------------- */

const runTokens = new Map<string, RunTokens>();

export function clearRunTokens(runId: string) {
  runTokens.delete(runId);
  console.log("[API][tokenStore] cleared", { runId });
}

/* -------------------- new: per-user provider connections -------------------- */

type Provider = "google" | "slack";

function toIsoFromExpiryMs(expiryMs?: number) {
  if (!expiryMs) return null;
  return new Date(expiryMs).toISOString();
}

function fromIsoToExpiryMs(expires_at?: string | null) {
  if (!expires_at) return undefined;
  const t = Date.parse(expires_at);
  return Number.isFinite(t) ? t : undefined;
}

export async function upsertProviderConnection(args: {
  userId: string;
  provider: Provider;
  access_token: string;
  refresh_token?: string;
  expires_at?: string | null; // ISO
  scopes?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  slack_user_id?: string | null;
  metadata?: any;
}) {
  const {
    userId,
    provider,
    access_token,
    refresh_token,
    expires_at,
    scopes,
    team_id,
    team_name,
    slack_user_id,
    metadata,
  } = args;

  const { data, error } = await supabase
    .from("provider_connections")
    .upsert(
      {
        user_id: userId,
        provider,
        scopes: scopes || null,
        access_token,
        refresh_token: refresh_token || null,
        expires_at: expires_at || null,
        team_id: team_id || null,
        team_name: team_name || null,
        slack_user_id: slack_user_id || null,
        metadata: metadata || {},
      },
      { onConflict: "user_id,provider,team_id" }
    )
    .select("*")
    .single();

  if (error) throw new Error(`upsertProviderConnection failed: ${error.message}`);
  return data;
}

export async function getProviderConnection(args: {
  userId: string;
  provider: Provider;
  team_id?: string | null; // for slack
}) {
  const { userId, provider, team_id } = args;

  let q = supabase
    .from("provider_connections")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", provider)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (provider === "slack" && team_id) q = q.eq("team_id", team_id);

  const { data, error } = await q.maybeSingle();

  if (error) throw new Error(`getProviderConnection failed: ${error.message}`);
  return data || null;
}

/* -------------------- Back-compat wrappers --------------------
   Old code calls setRunTokens(runId, googleTokens) and getRunTokens(runId).
   We keep those, but ALSO provide the new per-user getters/setters.
--------------------------------------------------------------- */

/** legacy (per-run) google set */
export function setRunTokens(runId: string, t: GoogleTokens) {
  const cur = runTokens.get(runId) || {};
  cur.google = t;
  runTokens.set(runId, cur);
  console.log("[API][tokenStore] set google (legacy)", { runId, hasRefresh: !!t.refresh_token });
}

/** legacy (per-run) google get */
export function getRunTokens(runId: string): GoogleTokens | null {
  const cur = runTokens.get(runId);
  return cur?.google || null;
}

/** legacy generic provider set */
export function setProviderToken<K extends keyof RunTokens>(
  runId: string,
  provider: K,
  value: NonNullable<RunTokens[K]>
) {
  const cur = runTokens.get(runId) || {};
  (cur as any)[provider] = value;
  runTokens.set(runId, cur);
  console.log("[API][tokenStore] set provider (legacy)", { runId, provider });
}

/** legacy generic provider get */
export function getProviderToken<K extends keyof RunTokens>(runId: string, provider: K): RunTokens[K] | null {
  const cur = runTokens.get(runId) || null;
  if (!cur) return null;
  return (cur[provider] as any) || null;
}

/* -------------------- New helpers used by handlers -------------------- */

export async function getGoogleTokensForUser(userId: string): Promise<GoogleTokens | null> {
  const row = await getProviderConnection({ userId, provider: "google" });
  if (!row) return null;
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token || undefined,
    expiry_date: fromIsoToExpiryMs(row.expires_at),
    scope: row.scopes || undefined,
  };
}

export async function storeGoogleTokensForUser(userId: string, t: GoogleTokens) {
  return upsertProviderConnection({
    userId,
    provider: "google",
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: toIsoFromExpiryMs(t.expiry_date),
    scopes: t.scope || null,
    metadata: {},
  });
}

export async function getSlackTokensForUser(userId: string): Promise<SlackTokens | null> {
  const row = await getProviderConnection({ userId, provider: "slack" });
  if (!row) return null;
  return {
    access_token: row.access_token,
    team_id: row.team_id || undefined,
    team_name: row.team_name || undefined,
    user_id: row.slack_user_id || undefined,
  };
}

export async function storeSlackTokensForUser(userId: string, t: SlackTokens) {
  return upsertProviderConnection({
    userId,
    provider: "slack",
    access_token: t.access_token,
    team_id: t.team_id || null,
    team_name: t.team_name || null,
    slack_user_id: t.user_id || null,
    metadata: {},
  });
}
