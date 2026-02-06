// /Users/partha/Desktop/cliniq/apps/api/src/handlers/index.ts
import { emit } from "../runStore";
import type { RouteDecision } from "../router";
import { gmailTriageV1 } from "./gmailTriageV1";
import { calendarScheduleV1 } from "./calendarScheduleV1";
import { webPublicAnalysisV1 } from "./webPublicAnalysisV1";
import { slackOpenLoopsV1 } from "./slackOpenLoopsV1";

/* -------------------- output types -------------------- */

export type WebPublicAnalysisOutput = {
  kind: "web_public_analysis";
  sites: Array<
    | { url: string; ok: true; extract?: any; signals?: any }
    | { url: string; ok: false; error: string }
  >;
  comparison: any | null;
  question?: string;
  summary?: string;
  note?: string;
};

export type SlackOpenLoopsOutput = {
  kind: "slack_open_loops";
  plan: string[];
  workspace?: { id?: string; name?: string };
  windowDays: number;
  summary: string;
  items: Array<{
    type: "broken_commitment" | "unanswered_question" | "stalled_thread" | "ownership_gap";
    severity: "high" | "medium" | "low";
    title: string;
    where: string;
    ageDays: number;
    excerpt?: string;
    permalink?: string;
  }>;
  note?: string;
};

export type HandlerOutput =
  | { kind: "gmail_triage"; plan: string[]; query: string; top: any[] }
  | { kind: "calendar_schedule"; plan: string[]; draftEvent: any; note?: string }
  | { kind: "research_report"; plan: string[]; title: string; sections: any[]; note?: string }
  | { kind: "clarify"; prompt: string; question: string; suggested_commands?: string[] }
  | WebPublicAnalysisOutput
  | SlackOpenLoopsOutput
  | { kind: "error"; error: string; handler?: string; intent?: string };

/* -------------------- dispatcher -------------------- */

export async function runHandler(
  runId: string,
  prompt: string,
  decision: RouteDecision
): Promise<HandlerOutput> {
  const handler = decision.handler;

  emit(runId, "info", `Handler selected: ${handler}`, {
    intent: decision.intent,
    confidence: decision.confidence,
  });

  try {
    switch (handler) {
      case "gmail_triage_v1": {
        emit(runId, "info", "Handler: gmail_triage_v1 starting…");
        const out = await gmailTriageV1(runId);
        emit(runId, "info", "Handler: gmail_triage_v1 done");
        return { kind: "gmail_triage", plan: decision.plan, query: out.query, top: out.top };
      }

      case "calendar_schedule_v1": {
        emit(runId, "info", "Handler: calendar_schedule_v1 starting…");
        const out = await calendarScheduleV1(runId, prompt, decision);
        emit(runId, "info", "Handler: calendar_schedule_v1 done");
        return out as any;
      }

      case "research_report_v1": {
        emit(runId, "info", "Handler: research_report_v1 starting…");
        const out = await researchReportV1(runId, prompt, decision);
        emit(runId, "info", "Handler: research_report_v1 done");
        return out;
      }

      case "web_public_analysis_v1": {
        emit(runId, "info", "Handler: web_public_analysis_v1 starting…");

        const urls = decision.extracted?.urls;
        if (!Array.isArray(urls) || urls.length === 0) {
          return { kind: "error", error: "No URLs found to analyze", handler, intent: decision.intent };
        }

        // ✅ webPublicAnalysisV1 expects (runId, { prompt, urls })
const out = await webPublicAnalysisV1(runId, {
  prompt: decision.extracted?.normalizedPrompt || prompt,
  urls,
});

        emit(runId, "info", "Handler: web_public_analysis_v1 done");
        return out as any;
      }

      case "slack_open_loops_v1": {
        emit(runId, "info", "Handler: slack_open_loops_v1 starting…");
        const out = await slackOpenLoopsV1(runId, prompt, decision);
        emit(runId, "info", "Handler: slack_open_loops_v1 done");
        return out as any;
      }

      case "fallback_chat_v1": {
        emit(runId, "info", "Handler: fallback_chat_v1 starting…");
        const out = await fallbackChatV1(runId, prompt);
        emit(runId, "info", "Handler: fallback_chat_v1 done");
        return out;
      }

      default: {
        emit(runId, "warn", "Unknown handler requested. Forcing clarify.", { handler });
        return {
          kind: "clarify",
          prompt,
          question:
            "I can triage emails, schedule calendar events, analyze websites, or scan Slack. What should I do?",
          suggested_commands: [
            "Check top priority emails today and draft replies",
            "Schedule a meeting with Partha at 3 PM tomorrow",
            "Analyze a public website and suggest improvements",
            "In Slack: what are my open loops?",
          ],
        };
      }
    }
  } catch (e: any) {
    const msg = e?.message ?? "handler failed";
    emit(runId, "error", "Handler error", { handler, error: msg });
    return { kind: "error", error: msg, handler, intent: decision.intent };
  }
}

/* -------------------- stubs -------------------- */

async function researchReportV1(runId: string, prompt: string, decision: RouteDecision): Promise<HandlerOutput> {
  emit(runId, "info", "Research handler is stubbed.", { prompt });

  return {
    kind: "research_report",
    plan: decision.plan,
    title: "Research report (stub)",
    sections: [{ heading: "Next steps", bullets: ["Wire web search", "Extract sources", "Generate report"] }],
    note: "Web search tool not wired yet.",
  };
}

async function fallbackChatV1(runId: string, prompt: string): Promise<HandlerOutput> {
  emit(runId, "info", "Need a quick clarification to route correctly…");
  return {
    kind: "clarify",
    prompt,
    question: "Do you want Gmail triage, calendar scheduling, website analysis, or Slack scan?",
  };
}
