// /Users/partha/Desktop/cliniq/apps/api/src/slackAuth.ts
import crypto from "crypto";

const SCOPES = [
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
  "users:read.email",
].join(",");

function must(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function slackAuthUrl(runId: string) {
  const client_id = must("SLACK_CLIENT_ID");
  const redirect_uri = must("SLACK_REDIRECT_URL");
  const state = crypto
    .createHash("sha256")
    .update(`slack:${runId}:${Date.now()}:${Math.random()}`)
    .digest("hex");

  const url =
    "https://slack.com/oauth/v2/authorize" +
    `?client_id=${encodeURIComponent(client_id)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&state=${encodeURIComponent(`${runId}:${state}`)}`;

  return { url, state: `${runId}:${state}` };
}

export async function slackExchangeCode(code: string) {
  const client_id = must("SLACK_CLIENT_ID");
  const client_secret = must("SLACK_CLIENT_SECRET");
  const redirect_uri = must("SLACK_REDIRECT_URL");

  const body = new URLSearchParams();
  body.set("client_id", client_id);
  body.set("client_secret", client_secret);
  body.set("code", code);
  body.set("redirect_uri", redirect_uri);

  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json: any = await res.json();
  if (!json?.ok) throw new Error(json?.error || "slack oauth failed");

  // We prefer authed_user.access_token (user token) if present.
  const token = json?.authed_user?.access_token || json?.access_token;
  if (!token) throw new Error("slack oauth: missing access token");

  return {
    token,
    team: { id: json?.team?.id, name: json?.team?.name },
    authed_user: { id: json?.authed_user?.id },
  };
}
