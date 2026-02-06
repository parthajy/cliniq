import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import crypto from "crypto";
import { setApproval, getApproval, consumeApproval } from "./approvalStore";
import { google } from "googleapis";
import { oauthClient, scopesFor } from "./googleAuth";
import { setRunTokens, getRunTokens } from "./tokenStore";
import { setProviderToken } from "./tokenStore";
import { slackAuthUrl, slackExchangeCode } from "./slackAuth";
import { listApprovalsForRun, expectedApprovalKey } from "./debugApprovals";

import {
  createRun,
  emit,
  subscribe,
  finish,
  fail,
  getRun,
} from "./runStore";

import { clawdRoute } from "./router";
import { runHandler } from "./handlers";

const app = Fastify({ logger: false });
await app.register(cors, { origin: true, credentials: true });

/* -------------------- health -------------------- */
app.get("/health", async () => {
  console.log("[API][health] ok");
  return { ok: true };
});

/* -------------------- Slack OAuth (per run) -------------------- */
app.get("/slack/oauth/start", async (req: any, reply: any) => {
  try {
    const runId = String(req.query?.runId || "");
    if (!runId) return reply.code(400).send({ ok: false, error: "runId required" });

    const { url } = slackAuthUrl(runId);
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

    const runId = state.split(":")[0];
    if (!runId) return reply.code(400).send("Invalid state (runId missing)");

    const ex = await slackExchangeCode(code);
    setProviderToken(runId, "slack", {
      access_token: ex.token,
      team_id: ex.team?.id,
      team_name: ex.team?.name,
      user_id: ex.authed_user?.id,
    });

    // close window-friendly
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

app.get("/debug/approvals", async (req, reply) => {
  const runId = String((req.query as any)?.runId || "").trim();
  if (!runId) return reply.code(400).send({ ok: false, error: "runId required" });

  return reply.send({ ok: true, runId, keys: listApprovalsForRun(runId) });
});

/* -------------------- oauth -------------------- */
app.get("/auth/google/start", async (req, res) => {
  const runId = String((req.query as any)?.runId || "");
  const perms = String((req.query as any)?.perms || "google_gmail");

  if (!runId) return res.status(400).send("runId required");

  const requested = perms.split(",").map((s) => s.trim()) as any;
  const scopes = scopesFor(requested);

  console.log("[API][auth] start", { runId, scopes });

  const client = oauthClient();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state: runId,
  });

  return res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const code = String((req.query as any)?.code || "");
  const runId = String((req.query as any)?.state || "");

  if (!code || !runId) return res.status(400).send("missing code/state");

  console.log("[API][auth] callback", { runId });

  const client = oauthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) {
    console.error("[API][auth] no access_token", tokens);
    return res.status(400).send("no access_token");
  }

  setRunTokens(runId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || undefined,
    expiry_date: tokens.expiry_date || undefined,
    scope: tokens.scope || undefined,
  });

  return res.type("html").send(`
    <html>
      <body style="font-family: ui-sans-serif; padding: 24px;">
        <h2>Google connected ✅</h2>
        <p>You can close this window and go back to Cliniq.</p>
      </body>
    </html>
  `);
});

/* -------------------- create run -------------------- */
app.post("/run", async (req, res) => {
  const body = (req.body ?? {}) as any;
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return res.status(400).send({ ok: false, error: "prompt required" });

  const run = createRun(prompt);
  emit(run.id, "info", "Run created");
  emit(run.id, "info", "Starting router…");

  (async () => {
    try {
      const decision = await clawdRoute(run.id, prompt);
      emit(run.id, "info", "Router decision", decision);

      // ---- permission gate ----
      const needsGoogle =
        decision.required_permissions.includes("google_gmail") ||
        decision.required_permissions.includes("google_calendar");

      if (needsGoogle) {
        const perms = decision.required_permissions
          .filter((p) => p === "google_gmail" || p === "google_calendar")
          .join(",");

        const authUrl =
          `http://localhost:8787/auth/google/start?runId=${run.id}&perms=${encodeURIComponent(perms)}`;

        emit(run.id, "warn", "Permission required", {
          kind: "google_oauth",
          perms,
          authUrl,
        });

        emit(run.id, "info", "Waiting for permission…");
        await waitForTokens(run.id, 180_000);
        emit(run.id, "info", "Permission granted. Continuing…");
      }

      emit(run.id, "info", "Executing plan…", { plan: decision.plan });

      const output = await runHandler(run.id, prompt, decision);
      emit(run.id, "info", "Execution complete");
      finish(run.id, output);
    } catch (e: any) {
      fail(run.id, e?.message ?? "run failed");
    }
  })();

  return { ok: true, runId: run.id };
});

app.post("/run/:runId/approve", async (req, reply) => {
  const runId = String((req.params as any).runId || "");
  const body = (req.body || {}) as any;
  const action = String(body.action || "");

  if (!runId) return reply.code(400).send({ ok: false, error: "runId required" });
  if (!action) return reply.code(400).send({ ok: false, error: "action required" });

  // ✅ ONE canonical id (same rule everywhere)
  const approvalId = String(body.approvalId || body.id || body.draftId || body.messageId || "").trim();

  // store with canonical id so pickId can’t drift
  const stored = setApproval(runId, action, { ...body, id: approvalId });

  console.log("[API][approve] stored", { runId, action, approvalId, storedKey: stored.key, body });

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
  const boundary = "----cliniq_" + crypto.randomBytes(8).toString("hex");
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

app.post("/gmail/send", async (req, reply) => {
  const body = (req.body || {}) as any;
  const runId = String(body.runId || "");
  const messageId = String(body.messageId || "");
  const toEmail = String(body.toEmail || "");
  const subject = String(body.subject || "");
  const replyText = String(body.replyText || "");
    const threadId = String(body.threadId || "");
  const inReplyTo = String(body.inReplyTo || "");
  const references = String(body.references || "");

  if (!runId) return reply.code(400).send({ ok: false, error: "runId required" });
  if (!messageId) return reply.code(400).send({ ok: false, error: "messageId required" });
  if (!toEmail) return reply.code(400).send({ ok: false, error: "toEmail required" });
  if (!subject) return reply.code(400).send({ ok: false, error: "subject required" });
  if (!replyText) return reply.code(400).send({ ok: false, error: "replyText required" });

  // require explicit approval
    const approved = consumeApproval(runId, "gmail_send", messageId);
 if (!approved) return reply.code(403).send({ ok: false, error: "Not approved (or expired)" });

  const t = getRunTokens(runId);
  if (!t?.access_token) return reply.code(401).send({ ok: false, error: "Missing Gmail token" });

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

app.post("/calendar/create", async (req, reply) => {
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

  if (!runId) return reply.code(400).send({ ok: false, error: "runId required" });
  if (!draftId) return reply.code(400).send({ ok: false, error: "draftId required" });
  if (!title) return reply.code(400).send({ ok: false, error: "title required" });
  if (!start || !end) return reply.code(400).send({ ok: false, error: "start/end required" });

  // ✅ must match what /approve stored
  const approvalId = String(body.approvalId || "").trim() || draftId;

  console.log("[API][calendar_create] approval check", {
    runId,
    draftId,
    approvalId,
    expected: `${runId}:calendar_create:${approvalId}`,
  });

  const approved = consumeApproval(runId, "calendar_create", approvalId);

  if (!approved) {
  const keys = listApprovalsForRun(runId);

  console.log("[API][calendar_create] NOT APPROVED", {
    runId,
    draftId,
    approvalId,
    expected: `${runId}:calendar_create:${approvalId}`,
    keys,
  });

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

  const t = getRunTokens(runId);
  if (!t?.access_token) return reply.code(401).send({ ok: false, error: "Missing Calendar token" });

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
app.get("/run/:id/stream", async (req, reply) => {
  const runId = String((req.params as any).id || "");
  const run = getRun(runId);

  if (!run) return reply.code(404).send({ ok: false, error: "run not found" });

  console.log("[API][sse] connect", { runId });

  // IMPORTANT: use reply.raw but do NOT call reply.send after this
  const res = reply.raw;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Some proxies buffer SSE; this helps
  res.setHeader("X-Accel-Buffering", "no");

  // If supported
  (res as any).flushHeaders?.();

  let closed = false;
  const safeWrite = (eventName: string, data: any) => {
    if (closed) return;
    try {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      closed = true;
      try {
        res.end();
      } catch {}
    }
  };

  // initial hello + replay existing events
  safeWrite("hello", { runId, status: run.status });
  for (const evt of run.events) safeWrite("event", { runId, event: evt });

  const unsub = subscribe(runId, (msg) => {
    // absolutely never throw from here
    try {
      safeWrite(msg.type, msg);
    } catch (e) {
      // swallow
    }
  });

  req.raw.on("close", () => {
    closed = true;
    console.log("[API][sse] close", { runId });
    try {
      unsub();
    } catch {}
  });

  // Tell Fastify "we're handling the response"
  return reply.hijack();
});

/* -------------------- fetch run -------------------- */
app.get("/run/:id", async (req, res) => {
  const runId = (req.params as any).id as string;
  const run = getRun(runId);
  if (!run) return res.status(404).send({ ok: false, error: "run not found" });

  return {
    ok: true,
    run: {
      id: run.id,
      status: run.status,
      finalOutput: run.finalOutput,
      error: run.error,
    },
  };
});

/* -------------------- boot -------------------- */
app.listen({ port: Number(process.env.PORT || 8787), host: "0.0.0.0" })
  .then(() => console.log("[API][boot] listening", { port: process.env.PORT || 8787 }))
  .catch((e) => {
    console.error("[API][boot] failed", e);
    process.exit(1);
  });

/* -------------------- helpers -------------------- */
async function waitForTokens(runId: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = getRunTokens(runId);
    if (t?.access_token) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for Google permission");
}
