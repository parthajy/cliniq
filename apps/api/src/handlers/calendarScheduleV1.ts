// apps/api/src/handlers/calendarScheduleV1.ts
import { google } from "googleapis";
import { oauthClient } from "../googleAuth";
import { getGoogleTokensForUser } from "../tokenStore";
import { emit } from "../runStore";
import type { RouteDecision } from "../router";
import type { HandlerOutput } from "./index";
import { llmJson } from "../openai";

type DraftAttendee = { name?: string; email?: string };

type DraftEvent = {
  draftId: string;
  title: string;
  start: string; // ISO with tz offset
  end: string;   // ISO with tz offset
  timezone: string;
  meet: boolean;
  attendees: DraftAttendee[];
  createWithoutInvite: boolean;
  notes?: string[];
};

function addMinutes(iso: string, mins: number) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + mins);
  return d.toISOString();
}

function safeIsoWithOffset(dateIso: string) {
  // If model returns full ISO with offset, keep it.
  // If it returns "YYYY-MM-DDTHH:mm:ss" (no offset), assume Asia/Kolkata (+05:30).
  if (/[+-]\d\d:\d\d$/.test(dateIso)) return dateIso;
  if (dateIso.endsWith("Z")) return dateIso;
  return `${dateIso}+05:30`;
}

function normName(s: string) {
  return (s || "").trim();
}

function extractEmailMaybe(s: string) {
  const m = String(s || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m?.[0] || "";
}

function monthToNum(m: string) {
  const k = m.toLowerCase().slice(0, 3);
  const map: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  return map[k] || "";
}

function parseDateFromPrompt(prompt: string): string {
  const p = prompt.toLowerCase();

  // 13th October 2026 / 13 October 2026
  let m = p.match(/\b(\d{1,2})(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(20\d{2})\b/i);
  if (m) {
    const dd = String(m[1]).padStart(2, "0");
    const mm = monthToNum(m[3]);
    const yyyy = m[4];
    if (mm) return `${yyyy}-${mm}-${dd}`;
  }

  // 2026-10-13
  m = p.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  return "";
}

export async function calendarScheduleV1(
  runId: string,
  prompt: string,
  decision: RouteDecision,
  ctx: { userId: string }
): Promise<HandlerOutput> {
  emit(runId, "info", "Calendar: parsing prompt…", { prompt });

  const dateHint = parseDateFromPrompt(prompt);
  const system = `You extract calendar event details for a busy founder in India.

Return JSON only.

Rules:
- timezone must be "Asia/Kolkata"
- If time is missing, choose a sensible default time: 11:00 AM local.
- durationMins default 30 if missing.
- If attendee email is not present in the prompt, leave attendee.email empty and set createWithoutInvite=true.
- Title should be short and human. Use "Meeting with <Name>" if attendee exists.

Return fields:
- title
- date (YYYY-MM-DD) if mentioned, else empty string
- time (HH:mm) 24h if mentioned, else empty string
- durationMins (number)
- attendeeName (string, may be empty)
- attendeeEmail (string, may be empty)
`;

  const schemaHint = `{
  "title": "string",
  "date": "string",
  "time": "string",
  "durationMins": 30,
  "attendeeName": "string",
  "attendeeEmail": "string"
}`;

  const parsed = await llmJson<{
    title: string;
    date: string;
    time: string;
    durationMins: number;
    attendeeName: string;
    attendeeEmail: string;
  }>({
    system,
    user: prompt,
    schemaHint,
    temperature: 0.2,
  });

  const timezone = "Asia/Kolkata";
  const date = (dateHint || parsed.date || "").trim();
  let time = (parsed.time || "").trim();
  const durationMins = Number(parsed.durationMins || 30) || 30;

  if (!date) {
    // Production-safe: we can’t create without a date.
    emit(runId, "warn", "Calendar: missing date in prompt. Need a date to proceed.");
    return {
      kind: "clarify" as const,
      prompt,
      question: "Which date should I schedule this on? (e.g., 3 March, 10 AM)",
      suggested_commands: [
        "Schedule a meeting with Prajwalita on 3rd March at 11 AM",
        "Schedule a 30-min meeting tomorrow at 4 PM",
      ],
    };
  }

  if (!time) time = "11:00";

  const startLocal = safeIsoWithOffset(`${date}T${time}:00`);
  const endLocal = safeIsoWithOffset(addMinutes(startLocal, durationMins));

  const attendeeName = normName(parsed.attendeeName);
  const attendeeEmail = extractEmailMaybe(parsed.attendeeEmail);

  const attendees: DraftAttendee[] =
    attendeeName || attendeeEmail ? [{ name: attendeeName || undefined, email: attendeeEmail || undefined }] : [];

  const createWithoutInvite = attendees.length > 0 && !attendeeEmail;

  const title =
    (parsed.title || "").trim() ||
    (attendeeName ? `Meeting with ${attendeeName}` : "Meeting");

  const draft: DraftEvent = {
    draftId: `draft_${runId}_${Date.now()}`,
    title,
    start: startLocal,
    end: endLocal,
    timezone,
    meet: true,
    attendees,
    createWithoutInvite,
    notes: createWithoutInvite
      ? [
          "Attendee email is missing — I can create the event without an invite.",
          "You can add the attendee later once you have the email.",
        ]
      : [],
  };

  // OPTIONAL: availability check (best-effort)
  try {
    const t = await getGoogleTokensForUser(ctx.userId);
    if (!t?.access_token) throw new Error("Missing Calendar token");

    const client = oauthClient();
    client.setCredentials({
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expiry_date: t.expiry_date,
    });

    const cal = google.calendar({ version: "v3", auth: client });

    emit(runId, "info", "Calendar: checking availability…");
    const fb = await cal.freebusy.query({
      requestBody: {
        timeMin: new Date(startLocal).toISOString(),
        timeMax: new Date(endLocal).toISOString(),
        timeZone: timezone,
        items: [{ id: "primary" }],
      },
    });

    const busy = fb.data.calendars?.primary?.busy || [];
    if (busy.length > 0) {
      draft.notes = [
        ...(draft.notes || []),
        "Your calendar looks busy in that window. You can still create it, but you may want to adjust the time.",
      ];
      emit(runId, "warn", "Calendar: time conflicts detected", { busy });
    } else {
      emit(runId, "info", "Calendar: time looks free.");
    }
  } catch (e: any) {
    emit(runId, "warn", "Calendar: availability check skipped/failed", { error: e?.message || String(e) });
  }

  emit(runId, "info", "Calendar: draft prepared", { draft });

  return {
    kind: "calendar_schedule" as const,
    plan: decision.plan,
    draftEvent: draft,
    note: "Ready for approval to create the event.",
  };
}
