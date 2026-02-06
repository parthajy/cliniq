// /Users/partha/Desktop/cliniq/apps/api/src/router.ts
import { emit } from "./runStore";

export type RouteDecision = {
  intent:
    | "gmail_triage"
    | "calendar_schedule"
    | "research_report"
    | "web_public_analysis"
    | "slack_open_loops"
    | "unknown";

  handler:
    | "gmail_triage_v1"
    | "calendar_schedule_v1"
    | "research_report_v1"
    | "web_public_analysis_v1"
    |"slack_open_loops_v1"
    | "fallback_chat_v1";

    required_permissions: Array<"google_gmail" | "google_calendar" | "web_search" | "slack_read">;

  plan: string[];
  confidence: number;
  extracted?: Record<string, any>;
};

function norm(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(p: string, words: string[]) {
  return words.some((w) => p.includes(w));
}

function scoreBySignals(p: string, signals: string[]) {
  let score = 0;
  for (const w of signals) if (p.includes(w)) score++;
  return score;
}

function scoreWeb(prompt: string) {
  const p = prompt.toLowerCase();
  let score = 0;

  if (p.includes("website") || p.includes("homepage")) score++;
  if (p.includes("compare") || p.includes("vs")) score++;
  if (p.includes(".com")) score++;
  if (p.includes("improve") || p.includes("audit")) score++;

  return score;
}

function scoreSlack(prompt: string) {
  const p = prompt.toLowerCase();
  let score = 0;
  if (/\bslack\b/.test(p)) score += 3;
  if (/\b(open loops|open-loop|follow[- ]?ups|pending|unanswered|stuck|blocked)\b/.test(p)) score += 2;
  if (/\b(workspace|channels|dms|threads)\b/.test(p)) score += 1;
  return score;
}

function confidenceFrom(scores: { gmail: number; cal: number; res: number }) {
  const arr = [
    { k: "gmail", v: scores.gmail },
    { k: "cal", v: scores.cal },
    { k: "res", v: scores.res },
  ].sort((a, b) => b.v - a.v);

  const top = arr[0].v;
  const second = arr[1].v;

  // If everything is 0 → low confidence
  if (top === 0) return 0.25;

  // Margin helps confidence
  const margin = top - second; // 0..N
  const base = 0.55 + Math.min(0.25, top * 0.06);
  const bonus = Math.min(0.20, margin * 0.08);
  return Math.min(0.92, base + bonus);
}

function extractUrls(prompt: string): string[] {
  return Array.from(
    prompt.matchAll(/https?:\/\/[^\s]+|[a-z0-9\-]+\.(com|io|ai)/gi)
  ).map(m => m[0].startsWith("http") ? m[0] : `https://${m[0]}`);
}

function looksLikeCalendar(prompt: string) {
  const p = prompt.toLowerCase();

  // strong verbs
  if (/\b(schedule|book|set up|setup|reschedule|meeting|call|sync|catch up)\b/.test(p)) return true;

  // date-ish signals
  if (/\b(\d{1,2})(st|nd|rd|th)\b/.test(p)) return true; // 13th
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/.test(p)) return true;
  if (/\b(20\d{2})\b/.test(p)) return true; // year

  // time-ish signals
  if (/\b(\d{1,2})(:\d{2})?\s?(am|pm)\b/.test(p)) return true;

  return false;
}

function looksLikeGmail(prompt: string) {
  const p = prompt.toLowerCase();
  return /\b(email|emails|inbox|reply|replies|gmail|messages)\b/.test(p);
}

export async function clawdRoute(runId: string, prompt: string): Promise<RouteDecision> {
  emit(runId, "info", "Clawd router: analyzing intent…");

  const p0 = norm(prompt);

  // very small typo tolerance for common keywords
  // (don’t do heavy fuzzy matching here; keep it deterministic & cheap)
  const p = p0
  .replace(/\btoda\b/g, "today")
  .replace(/\breplying\b/g, "reply")
  .replace(/\bemails\b/g, "email")
  .replace(/\bmails\b/g, "mail");


  // Signals
  const gmailSignals = [
  "email",
  "mail",
  "mails",
  "inbox",
  "gmail",
  "unread",
  "reply",
  "draft",
  "respond",
  "thread",
  "priority",
];

  const calSignals = ["schedule", "meeting", "calendar", "invite", "google meet", "gmeet", "availability"];
  const researchSignals = ["research", "report", "compare", "pricing", "strategy", "summarize", "analysis"];

  const gmailScore = scoreBySignals(p, gmailSignals);
  const calScore = scoreBySignals(p, calSignals);
  const resScore = scoreBySignals(p, researchSignals);
  const slackScore = scoreSlack(prompt);

  emit(runId, "info", "Clawd router: signal scores", { gmailScore, calScore, resScore, slackScore });

  // Hard intent hints (override low score)
  const gmailHints = [
    "top priority email",
    "top emails",
    "triage",
    "draft reply",
    "draft replies",
    "worth replying",
    "reply today",
    "inbox today",
  ];

  const calHints = ["schedule a meeting", "set up a meeting", "book a meeting", "calendar invite"];
  const resHints = ["write a report", "with citations", "compare", "do research"];

  const gmailHint = hasAny(p, gmailHints);
  const calHint = hasAny(p, calHints);
  const resHint = hasAny(p, resHints);

    // ✅ Slack override (if it smells like Slack)
  if (slackScore >= 3) {
    return {
      intent: "slack_open_loops",
      handler: "slack_open_loops_v1",
      required_permissions: ["slack_read"],
      plan: [
        "Request Slack access (per run)",
        "Pull recent messages across channels + DMs",
        "Detect open loops (commitments, unanswered Qs, stalled threads, ownership gaps)",
        "Rank by risk + age",
        "Return crisp action list with permalinks",
      ],
      confidence: 0.82,
      extracted: { normalizedPrompt: p0 },
    };
  }

    // ✅ Hard override: if prompt is clearly scheduling, route to calendar (unless explicitly about inbox/reply)
  const calLike = looksLikeCalendar(p);
  const gmailLike = looksLikeGmail(p);
  if (calLike && !gmailLike) {
    const conf = Math.max(0.75, confidenceFrom({ gmail: gmailScore, cal: calScore + 2, res: resScore }));
    return {
      intent: "calendar_schedule",
      handler: "calendar_schedule_v1",
      required_permissions: ["google_calendar"],
      plan: [
        "Request Calendar access (v1: per run)",
        "Parse date/time/attendees",
        "Check availability",
        "Propose event draft",
        "Ask approval",
        "Create meeting + Meet link",
      ],
     confidence: conf,
      extracted: { normalizedPrompt: p, forced: "looksLikeCalendar" },
    };
  }

  

  // Winner selection (deterministic)
  // Gmail should win if any of these are true:
  // - highest score and score >=1
  // - or strong hint exists and no competing strong hints
  const scores = { gmail: gmailScore, cal: calScore, res: resScore };
  const conf = confidenceFrom(scores);

  // 🌐 Web public analysis (no auth)
  const webScore = scoreWeb(prompt);
  if (webScore >= 2) {
    return {
      intent: "web_public_analysis",
      handler: "web_public_analysis_v1",
      required_permissions: [],
      plan: [
        "Fetch public pages",
        "Extract structure and copy",
        "Score UI and messaging",
        "Compare patterns (if multiple sites)",
        "Summarize improvements",
      ],
      confidence: 0.8,
      extracted: {
        urls: extractUrls(prompt),
        normalizedPrompt: p0,
      },
    };
  }

  const gmailWins =
        (gmailScore > Math.max(calScore, resScore) && gmailScore >= 1) ||
    (gmailHint && !calHint && !resHint);

  const calWins =
    (calScore > Math.max(gmailScore, resScore) && calScore >= 1) ||

    (calHint && !gmailHint && !resHint);

  const resWins = resScore >= 1 || resHint;

  // ✅ Tie-break: if gmail == cal and it looks like scheduling, prefer calendar
  if (!gmailWins && !calWins && gmailScore === calScore && gmailScore >= 1) {
    if (looksLikeCalendar(p) && !looksLikeGmail(p)) {
      return {
        intent: "calendar_schedule",
        handler: "calendar_schedule_v1",
        required_permissions: ["google_calendar"],
        plan: [
          "Request Calendar access (v1: per run)",
          "Parse date/time/attendees",
          "Check availability",
          "Propose event draft",
          "Ask approval",
          "Create meeting + Meet link",
        ],
        confidence: Math.max(0.65, conf),
        extracted: { normalizedPrompt: p, tieBreak: "calendar" },
      };
    }
  }

  if (gmailWins) {
    return {
      intent: "gmail_triage",
      handler: "gmail_triage_v1",
      required_permissions: ["google_gmail"],
      plan: [
        "Request Gmail access (v1: per run)",
        "Search emails for today",
        "Rank by urgency + reply-needed",
        "Pick top 3",
        "Draft replies",
        "Ask approval to send/copy",
      ],
      confidence: Math.max(0.6, conf),
      extracted: { normalizedPrompt: p },
    };
  }

  if (calWins) {
    return {
      intent: "calendar_schedule",
      handler: "calendar_schedule_v1",
      required_permissions: ["google_calendar"],
      plan: [
        "Request Calendar access (v1: per run)",
        "Parse date/time/attendees",
        "Check availability",
        "Propose event draft",
        "Ask approval",
        "Create meeting + Meet link",
      ],
      confidence: Math.max(0.6, conf),
      extracted: { normalizedPrompt: p },
    };
  }

  if (resWins) {
    return {
      intent: "research_report",
      handler: "research_report_v1",
      required_permissions: ["web_search"],
      plan: [
        "Clarify scope if needed",
        "Search sources",
        "Extract key points",
        "Synthesize",
        "Generate structured report with citations",
      ],
      confidence: Math.max(0.55, conf),
      extracted: { normalizedPrompt: p },
    };
  }

  return {
    intent: "unknown",
    handler: "fallback_chat_v1",
    required_permissions: [],
    plan: ["Ask 1 clarifying question OR provide best-effort guidance", "Suggest the next runnable command"],
    confidence: 0.3,
    extracted: { normalizedPrompt: p },
  };
}
