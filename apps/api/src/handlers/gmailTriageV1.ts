// /Users/partha/Desktop/cliniq/apps/api/src/handlers/gmailTriageV1.ts
import { google } from "googleapis";
import { oauthClient } from "../googleAuth";
import { getRunTokens } from "../tokenStore";
import { emit } from "../runStore";
import type { RouteDecision } from "../router";
import { llmJson } from "../openai";

function getHeader(headers: any[], name: string) {
  const h = headers?.find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

function looksAutomated(from: string, subject: string, snippet: string) {
  const t = `${from} ${subject} ${snippet}`.toLowerCase();

  if (t.includes("no-reply") || t.includes("noreply") || t.includes("do not reply")) return true;
  if (t.includes("unsubscribe") || t.includes("newsletter") || t.includes("marketing")) return true;
    // common newsletter sources that still slip through categories
  if (t.includes("medium.com") || t.includes("medium <hello@medium.com>")) return true;
  if (t.includes("substack") || t.includes("beehiiv") || t.includes("convertkit")) return true;
  if (t.includes("digest") && t.includes("your")) return true;

  const autoSubjects = [
    "receipt",
    "order summary",
    "invoice",
    "payment received",
    "security alert",
    "login attempt",
    "verification code",
    "otp",
    "sign-in",
    "new device",
    "password reset",
  ];
  if (autoSubjects.some((k) => t.includes(k))) return true;

  const autoSenders = ["notifications@", "alert@", "updates@", "receipts@", "billing@", "noreply@"];
  if (autoSenders.some((k) => t.includes(k))) return true;

  return false;
}

function extractEmailAddress(from: string) {
  const m = from.match(/<([^>]+)>/);
  return (m?.[1] || from || "").trim();
}

function buildSafeFallbackDraftBody(from: string, subject: string, snippet: string) {
  const short = snippet?.trim()?.slice(0, 180) || "";

    return `Hi — thanks for reaching out.

I saw your note${short ? ` (“${short}${short.length >= 180 ? "…" : ""}”)` : ""}.

Can you share the specific next step you want from me, and by when?

– Partha`;
}

  async function pickTopNWithDrafts(
  input: Array<{ id: string; from: string; subject: string; snippet: string }>,
  n: number
) {
  const system = `You triage emails for a busy founder.

Goal: pick the ${n} emails most worth replying to TODAY.

Return JSON only.`;

  const schemaHint = `{
  "top": [
    { "messageId": "string", "why": "string", "suggestedReply": "string" }
  ]
}`;

  const user = `Emails:\n${JSON.stringify(input, null, 2)}`;

  const out = await llmJson<{ top: Array<{ messageId: string; why: string; suggestedReply: string }> }>({
    system,
    user,
    schemaHint,
    temperature: 0.2,
  });

  const ids = new Set(input.map((x) => x.id));
  return (out.top || []).filter((x) => ids.has(x.messageId)).slice(0, n);
}

export async function gmailTriageV1(runId: string, _prompt?: string, _decision?: RouteDecision) {
  emit(runId, "info", "Gmail triage: preparing…");

  const t = getRunTokens(runId);
  if (!t?.access_token) throw new Error("Missing Gmail token (did OAuth complete?)");

  const client = oauthClient();
  client.setCredentials({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expiry_date: t.expiry_date,
  });

  const gmail = google.gmail({ version: "v1", auth: client });

  // Candidate query (fast + relevant)
  const q = "newer_than:1d in:inbox is:unread -category:promotions -category:social -category:forums";
  emit(runId, "info", "Gmail triage: listing candidate emails…", { query: q });

  const list = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: 50,
  });

  const ids = (list.data.messages || []).map((m) => m.id).filter(Boolean) as string[];
  emit(runId, "info", "Gmail triage: fetched message ids", { count: ids.length });

  type Candidate = {
    id: string;
    threadId?: string;
    from: string;
    toEmail: string;
    subject: string;
    snippet: string;
    rfcMessageId?: string; // Message-ID header (for proper reply headers)
  };

  const candidates: Candidate[] = [];

  // Pull metadata for first N emails
  const N = 40;
  for (const id of ids.slice(0, N)) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Reply-To", "Subject", "Date", "Message-ID", "References"],
    });

    const headers = (msg.data.payload?.headers || []) as any[];
    const from = getHeader(headers, "From");
    const subject = getHeader(headers, "Subject");
    const replyTo = getHeader(headers, "Reply-To");
    const snippet = msg.data.snippet || "";
    const rfcMessageId = getHeader(headers, "Message-ID") || undefined;

    if (!from || !subject) continue;
    if (looksAutomated(from, subject, snippet)) continue;

    candidates.push({
      id,
      threadId: msg.data.threadId || undefined,
      from,
      toEmail: extractEmailAddress(replyTo || from),
      subject,
      snippet,
      rfcMessageId,
    });
  }

  if (candidates.length === 0) {
    emit(runId, "info", "Gmail triage: no reply-worthy candidates after filtering.");
    return {
      kind: "gmail_triage",
      query: q,
      top: [],
      note: "No unread inbox emails in last 24h looked reply-worthy (after filtering newsletters/receipts/automation).",
    };
  }

  emit(runId, "info", "Gmail triage: ranking + drafting with model…", { candidates: candidates.length });

    const LIMIT = 5; // user asked Top 5

  // LLM pick top N + drafts, fallback to safe heuristics if model fails/empty
  let picked: Array<{ messageId: string; why: string; suggestedReply: string }> = [];
  try {
    picked = await pickTopNWithDrafts(
      candidates.map((c) => ({ id: c.id, from: c.from, subject: c.subject, snippet: c.snippet }))
          , LIMIT
    );

    // If model returns nothing, treat as failure and fall back.
    if (!picked || picked.length === 0) {
      emit(runId, "warn", "Gmail triage: model returned empty selection, using fallback.", {});
      picked = candidates.slice(0, LIMIT).map((c) => ({
        messageId: c.id,
        why: "Fallback selection (model returned empty).",
        suggestedReply: buildSafeFallbackDraftBody(c.from, c.subject, c.snippet),
      }));
    }
  } catch (e: any) {
    emit(runId, "warn", "Gmail triage: model failed, using safe fallback drafts.", {
      error: e?.message || String(e),
    });
    picked = candidates.slice(0, LIMIT).map((c) => ({
      messageId: c.id,
      why: "Fallback selection (model unavailable).",
      suggestedReply: buildSafeFallbackDraftBody(c.from, c.subject, c.snippet),
    }));
  }

  const top = picked
    .map((p) => {
      const base = candidates.find((c) => c.id === p.messageId);
      if (!base) return null;
      return {
        messageId: base.id,
        threadId: base.threadId,
        from: base.from,
        toEmail: base.toEmail,
        subject: base.subject,
        snippet: base.snippet,
        why: p.why,
        rfcMessageId: base.rfcMessageId,
        suggestedReply:
          (p.suggestedReply || "").trim() ||
          buildSafeFallbackDraftBody(base.from, base.subject, base.snippet),
      };
    })
    .filter(Boolean) as any[];

  emit(runId, "info", "Gmail triage: top candidates selected", {
    top: top.map((x) => ({ from: x.from, subject: x.subject })),
  });

  return {
    kind: "gmail_triage",
    query: q,
    top,
  };
}
