// apps/api/src/googleAuth.ts
import { google } from "googleapis";

export type Permission = "google_gmail" | "google_calendar";

type ScopeKey = Permission;

const SCOPES: Record<ScopeKey, string[]> = {
  // read-only for triage (safer). when you add send, add gmail.send scope too.
  google_gmail: [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
],

    // calendar: need read for freebusy + write for event insert
  google_calendar: [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ],
};

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function oauthClient() {
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const clientSecret = mustEnv("GOOGLE_CLIENT_SECRET");
  const redirectUri = mustEnv("GOOGLE_REDIRECT_URI"); // e.g. http://localhost:8787/auth/google/callback

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function scopesFor(perms: Permission[]) {
  const out = new Set<string>();
  for (const p of perms) {
    for (const s of SCOPES[p] || []) out.add(s);
  }
  return Array.from(out);
}
