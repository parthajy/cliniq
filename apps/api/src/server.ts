// /Users/partha/Desktop/cliniq/apps/api/src/server.ts
import "dotenv/config";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import crypto from "crypto";
import { google } from "googleapis";

import { setApproval, consumeApproval } from "./approvalStore";
import { oauthClient, scopesFor } from "./googleAuth";
import {
  storeGoogleTokensForUser,
  getGoogleTokensForUser,
  storeSlackTokensForUser,
  getSlackTokensForUser,
} from "./tokenStore";

import { slackAuthUrl, slackExchangeCode } from "./slackAuth";
import { listApprovalsForRun } from "./debugApprovals";

import { createRun, emit, subscribe, finish, fail, getRun } from "./runStore";
import { clawdRoute } from "./router";
import { runHandler } from "./handlers";

const app = Fastify({ logger: false });

/** ---- CORS (Netlify + local dev) ---- */
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:8787",
  "https://cliniqio.netlify.app",
]);

/** ---- Public base URL for emitting OAuth URLs to the UI ---- */
const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || "").trim() ||
  `http://localhost:${process.env.PORT || 8787}`;

await app.register(fastifyCors, {
  origin: (origin, cb) => {
    // allow curl/postman/no-origin
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Content-Type"],
});

/* -------------------- health -------------------- */
app.get("/health", async () => {
  console.log("[API][health] ok");
  return { ok: true };
});

/* -------------------- Slack OAuth (per run) -------------------- */
app.get("/slack/oauth/start", async (req: any, reply: any) => {
  try {
    const userId = String(req.query?.userId || "");
    const runId = String(req.query?.runId || ""); // optional
    if (!userId) return reply.code(400).send({ ok: false, error: "userId required" });

    const { url } = slackAuthUrl(`${userId}:${runId || "-"}`); // keep existing slackAuthUrl signature
    return reply.redirect(url);
  } catch (e: any) {
    return reply.code(400).send({ ok: false, error: e?.message || "slack oauth start failed" });
  }
});

app.get("/slack/oauth/callback", async (req: any, reply: any) => {
  try {
    const code = String(req.query?.code || "");
    const state = String(req.query?.state || "");
    if (!code) return reply.code(400).send("Missing code");
    if (!state || !state.includes(":")) return reply.code(400).send("Missing/invalid state");

    // state format we set: `${userId}:${runId}`
    const [userId] = state.split(":");
    if (!userId) return reply.code(400).send("Invalid state (userId missing)");

    const ex = await slackExchangeCode(code);

    await storeSlackTokensForUser(userId, {
      access_token: ex.token,
      team_id: ex.team?.id,
      team_name: ex.team?.name,
      user_id: ex.authed_user?.id,
    });

    return reply
      .type("text/html")
      .send(`<html><body style="font-family:system-ui;padding:24px">
        <h3>Slack connected ✅</h3>
        <p>You can close this tab and run again.</p>
        <script>window.close();</script>
      </body></html>`);
  } catch (e: any) {
    return reply.code(400).send(`Slack OAuth failed: ${e?.message || "unknown error"}`);
  }
});

app.get("/debug/approvals", async (req: any, reply: any) => {
  const runId = String(req.query?.runId || "").trim();
  if (!runId) return reply.code(400).send({ ok: false, error: "runId required" });
  return reply.send({ ok: true, runId, keys: listApprovalsForRun(runId) });
});

/* -------------------- Google OAuth -------------------- */
app.get("/auth/google/start", async (req: any, reply: any) => {
  const userId = String(req.query?.userId || "");
  const runId = String(req.query?.runId || ""); // optional (nice for UX)
  const perms = String(req.query?.perms || "google_gmail");

  if (!userId) return reply.code(400).send("userId required");

  const requested = perms.split(",").map((s: string) => s.trim()) as any;
  const scopes = scopesFor(requested);

  const client = oauthClient();
  const state = JSON.stringify({ userId, runId });

  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state,
  });

  return reply.redirect(url);
});

app.get("/auth/google/callback", async (req: any, reply: any) => {
  const code = String(req.query?.code || "");
  const stateRaw = String(req.query?.state || "");

  if (!code || !stateRaw) return reply.code(400).send("missing code/state");

  let state: { userId: string; runId?: string } | null = null;
  try {
    state = JSON.parse(stateRaw);
  } catch {
    return reply.code(400).send("invalid state");
  }

  const userId = String(state?.userId || "");
  if (!userId) return reply.code(400).send("invalid state (userId missing)");

  const client = oauthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) return reply.code(400).send("no access_token");

  await storeGoogleTokensForUser(userId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || undefined,
    expiry_date: tokens.expiry_date || undefined,
    scope: tokens.scope || undefined,
  });

  return reply.type("text/html").send(`
    <html>
      <body style="font-family: ui-sans-serif; padding: 24px;">
        <h2>Google connected ✅</h2>
        <p>You can close this window and go back to Cliniq.</p>
      </body>
    </html>
  `);
});

/* -------------------- create run -------------------- */
app.post("/run", async (req: any, reply: any) => {
  const body = (req.body ?? {}) as any;
  const prompt = String(body.prompt ?? "").trim();
  const userId = String(body.userId ?? "").trim();

  if (!prompt) return reply.code(400).send({ ok: false, error: "prompt required" });
  if (!userId) return reply.code(400).send({ ok: false, error: "userId required" });

  const run = createRun(prompt);
  emit(run.id, "info", "Run created");
  emit(run.id, "info", "Starting router…");

  (async () => {
    try {
      const decision = await clawdRoute(run.id, prompt);
      emit(run.id, "info", "Router decision", decision);

      // Google gate
      const needsGoogle =
        decision.required_permissions.includes("google_gmail") ||
        decision.required_permissions.includes("google_calendar");

      if (needsGoogle) {
        const hasGoogle = await getGoogleTokensForUser(userId);
        if (!hasGoogle) {
          const perms = decision.required_permissions
            .filter((p: string) => p === "google_gmail" || p === "google_calendar")
            .join(",");

          const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8787}`;
          const authUrl = `${BASE}/auth/google/start?userId=${encodeURIComponent(userId)}&runId=${run.id}&perms=${encodeURIComponent(perms)}`;

          emit(run.id, "warn", "Permission required", { kind: "google_oauth", perms, authUrl });
          finish(run.id, { kind: "clarify", question: "Connect Google, then run again." });
          return;
        }
      }

      // Slack gate
      const needsSlack = decision.required_permissions.includes("slack_read");
      if (needsSlack) {
        const hasSlack = await getSlackTokensForUser(userId);
        if (!hasSlack) {
          const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8787}`;
          const authUrl = `${BASE}/slack/oauth/start?userId=${encodeURIComponent(userId)}&runId=${run.id}`;

          emit(run.id, "warn", "Slack permission required", { kind: "slack_oauth", perms: "slack_read", authUrl });
          finish(run.id, {
            kind: "clarify",
            prompt,
            question: "Connect Slack to analyze open loops, then run again.",
            suggested_commands: [
              "In Slack: what are my open loops across channels and DMs?",
              "In Slack: what are the top unanswered questions from the last 14 days?",
            ],
          });
          return;
        }
      }

      emit(run.id, "info", "Executing plan…", { plan: decision.plan });

      // IMPORTANT: pass userId into handlers
      const output = await runHandler(run.id, prompt, decision, { userId });

      emit(run.id, "info", "Execution complete");
      finish(run.id, output);
    } catch (e: any) {
      fail(run.id, e?.message ?? "run failed");
    }
  })();

  return reply.send({ ok: true, runId: run.id });
});

/* -------------------- approvals -------------------- */
app.post("/run/:runId/approve", async (req: any, reply: any) => {
  const runId = String(req.params?.runId || "");
  const body = (req.body || {}) as any;
  const action = String(body.action || "");

  if (!runId) return reply.code(400).send({ ok: false, error: "runId required" });
  if (!action) return reply.code(400).send({ ok: false, error: "action required" });

  const approvalId = String(body.approvalId || body.id || body.draftId || body.messageId || "").trim();
  const stored = setApproval(runId, action, { ...body, id: approvalId });

  console.log("[API][approve] stored", { runId, action, approvalId, storedKey: stored.key });

  return reply.send({ ok: true, stored });
});

function base64UrlEncode(input: string) {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeReSubject(subject: string) {
  const s = String(subject || "").trim();
  if (!s) return "Re:";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

function makeRfc822Reply(args: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}) {
  const lines = [
    `To: ${args.to}`,
    `Subject: ${normalizeReSubject(args.subject)}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `MIME-Version: 1.0`,
  ];
  if (args.inReplyTo) lines.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references) lines.push(`References: ${args.references}`);
  lines.push("", args.body.trim() + "\r\n");
  return lines.join("\r\n");
}

/* -------------------- Gmail send -------------------- */
app.post("/gmail/send", async (req: any, reply: any) => {
  const body = (req.body || {}) as any;
  const runId = String(body.runId || "");
  const messageId = String(body.messageId || "");
  const toEmail = String(body.toEmail || "");
  const subject = String(body.subject || "");
  const replyText = String(body.replyText || "");
  const threadId = String(body.threadId || "");
  const inReplyTo = String(body.inReplyTo || "");
  const references = String(body.references || "");
  const userId = String(body.userId || "").trim();
if (!userId) return reply.code(400).send({ ok: false, error: "userId required" });


  if (!runId) return reply.code(400).send({ ok: false, error: "runId required" });
  if (!messageId) return reply.code(400).send({ ok: false, error: "messageId required" });
  if (!toEmail) return reply.code(400).send({ ok: false, error: "toEmail required" });
  if (!subject) return reply.code(400).send({ ok: false, error: "subject required" });
  if (!replyText) return reply.code(400).send({ ok: false, error: "replyText required" });

  const approved = consumeApproval(runId, "gmail_send", messageId);
  if (!approved) return reply.code(403).send({ ok: false, error: "Not approved (or expired)" });

  const t = await getGoogleTokensForUser(userId);
if (!t?.access_token) return reply.code(401).send({ ok: false, error: "Missing Google token" });


  const client = oauthClient();
  client.setCredentials({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expiry_date: t.expiry_date,
  });

  const gmail = google.gmail({ version: "v1", auth: client });

  const rawEmail = makeRfc822Reply({
    to: toEmail,
    subject,
    body: replyText,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
  });

  const raw = base64UrlEncode(rawEmail);

  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: threadId ? { raw, threadId } : { raw },
  });

  return reply.send({ ok: true, id: sent.data.id });
});

/* -------------------- Calendar create -------------------- */
app.post("/calendar/create", async (req: any, reply: any) => {
  const body = (req.body || {}) as any;
  const runId = String(body.runId || "").trim();
  const draftId = String(body.draftId || "").trim();
  const title = String(body.title || "").trim();
  const start = String(body.start || "").trim();
  const end = String(body.end || "").trim();
  const timezone = String(body.timezone || "Asia/Kolkata");
  const meet = Boolean(body.meet ?? true);
  const attendees = Array.isArray(body.attendees) ? body.attendees : [];
  const createWithoutInvite = Boolean(body.createWithoutInvite ?? false);
  const userId = String(body.userId || "").trim();
if (!userId) return reply.code(400).send({ ok: false, error: "userId required" });


  if (!runId) return reply.code(400).send({ ok: false, error: "runId required" });
  if (!draftId) return reply.code(400).send({ ok: false, error: "draftId required" });
  if (!title) return reply.code(400).send({ ok: false, error: "title required" });
  if (!start || !end) return reply.code(400).send({ ok: false, error: "start/end required" });

  const approvalId = String(body.approvalId || "").trim() || draftId;

  const approved = consumeApproval(runId, "calendar_create", approvalId);
  if (!approved) {
    const keys = listApprovalsForRun(runId);
    return reply.code(403).send({
      ok: false,
      error: "Not approved (or expired)",
      debug: {
        runId,
        draftId,
        approvalId,
        expected: `${runId}:calendar_create:${approvalId}`,
        keys,
      },
    });
  }

  const t = await getGoogleTokensForUser(userId);
if (!t?.access_token) return reply.code(401).send({ ok: false, error: "Missing Google token" });

  const client = oauthClient();
  client.setCredentials({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expiry_date: t.expiry_date,
  });

  const cal = google.calendar({ version: "v3", auth: client });

  const cleanAttendees = createWithoutInvite
    ? []
    : attendees
        .map((a: any) => ({
          email: String(a?.email || "").trim(),
          displayName: String(a?.name || "").trim() || undefined,
        }))
        .filter((a: any) => !!a.email);

  const requestId = `cliniq_${runId}_${Date.now()}`;

  const created = await cal.events.insert({
    calendarId: "primary",
    conferenceDataVersion: meet ? 1 : 0,
    requestBody: {
      summary: title,
      start: { dateTime: new Date(start).toISOString(), timeZone: timezone },
      end: { dateTime: new Date(end).toISOString(), timeZone: timezone },
      attendees: cleanAttendees.length ? cleanAttendees : undefined,
      conferenceData: meet
        ? {
            createRequest: {
              requestId,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          }
        : undefined,
    },
  });

  return reply.send({
    ok: true,
    event: {
      id: created.data.id,
      htmlLink: created.data.htmlLink,
      hangoutLink: created.data.hangoutLink,
      summary: created.data.summary,
    },
  });
});

/* -------------------- SSE stream -------------------- */
app.get("/run/:id/stream", async (req: any, reply: any) => {
  const runId = String(req.params?.id || "");
  const run = getRun(runId);
  if (!run) return reply.code(404).send({ ok: false, error: "run not found" });

  console.log("[API][sse] connect", { runId });

  const res = reply.raw;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // CORS for SSE (explicit helps proxies)
  const origin = String(req.headers.origin || "");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  (res as any).flushHeaders?.();

  let closed = false;
  const safeWrite = (eventName: string, data: any) => {
    if (closed) return;
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  safeWrite("hello", { runId, status: run.status });
  for (const evt of run.events) safeWrite("event", { runId, event: evt });

  const unsub = subscribe(runId, (msg: any) => {
    try {
      safeWrite(msg.type, msg);
    } catch {}
  });

  req.raw.on("close", () => {
    closed = true;
    console.log("[API][sse] close", { runId });
    try { unsub(); } catch {}
    try { res.end(); } catch {}
  });

  return reply.hijack();
});

/* -------------------- fetch run -------------------- */
app.get("/run/:id", async (req: any, reply: any) => {
  const runId = String(req.params?.id || "");
  const run = getRun(runId);
  if (!run) return reply.code(404).send({ ok: false, error: "run not found" });

  return reply.send({
    ok: true,
    run: {
      id: run.id,
      status: run.status,
      finalOutput: run.finalOutput,
      error: run.error,
    },
  });
});

/* -------------------- boot -------------------- */
app
  .listen({ port: Number(process.env.PORT || 8787), host: "0.0.0.0" })
  .then(() => console.log("[API][boot] listening", { port: process.env.PORT || 8787 }))
  .catch((e) => {
    console.error("[API][boot] failed", e);
    process.exit(1);
  });