// /Users/partha/Desktop/cliniq/apps/api/src/handlers/slackOpenLoopsV1.ts
import { emit } from "../runStore";
import type { RouteDecision } from "../router";
import { getSlackTokensForUser } from "../tokenStore";

type SlackMsg = {
  channel: string;
  channelName: string;
  ts: string;
  user?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  permalink?: string;
};

async function slackApi(token: string, method: string, params: Record<string, any>) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const json: any = await res.json();
  if (!json?.ok) throw new Error(json?.error || `slack api failed: ${method}`);
  return json;
}

function daysAgo(tsSec: number) {
  const now = Date.now();
  const then = tsSec * 1000;
  return Math.max(0, Math.floor((now - then) / (1000 * 60 * 60 * 24)));
}

function normalizeText(s: string) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function looksLikeQuestion(t: string) {
  const s = t.toLowerCase();
  return s.includes("?") || /\b(can we|should we|how do|why|what do we|what should)\b/.test(s);
}

function looksLikeCommitment(t: string) {
  const s = t.toLowerCase();
  return /\b(i('| a)m|i will|i'll|i’ll|let me|i can|i can do|i’ll do|i will do)\b/.test(s);
}

function looksLikeOwnershipGap(t: string) {
  const s = t.toLowerCase();
  return (
    /\b(someone should|we should|needs to be|it would be good to|can someone)\b/.test(s) &&
    !/@[a-z0-9._-]+/i.test(t)
  );
}

function looksLikeClosure(t: string) {
  const s = t.toLowerCase();
  return /\b(done|shipped|merged|fixed|resolved|closed|decided|approved|pushed)\b/.test(s);
}

async function getPermalink(token: string, channel: string, message_ts: string) {
  const j = await slackApi(token, "chat.getPermalink", { channel, message_ts });
  return j?.permalink as string;
}

async function listConversations(token: string) {
  const all: Array<{ id: string; name?: string; is_im?: boolean; is_mpim?: boolean }> = [];

  async function page(types: string) {
    let cursor: string | undefined = undefined;
    for (let i = 0; i < 20; i++) {
      const j = await slackApi(token, "conversations.list", {
        limit: 200,
        cursor,
        types,
        exclude_archived: true,
      });
      for (const c of j.channels || [])
        all.push({ id: c.id, name: c.name, is_im: c.is_im, is_mpim: c.is_mpim });
      cursor = j?.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  }

  await page("public_channel,private_channel");
  await page("im,mpim");

  return all;
}

async function fetchRecentMessages(
  token: string,
  convId: string,
  convName: string,
  oldestTsSec: number,
  cap: number
) {
  const out: SlackMsg[] = [];
  let cursor: string | undefined = undefined;

  for (let i = 0; i < 12; i++) {
    const j = await slackApi(token, "conversations.history", {
      channel: convId,
      limit: 200,
      cursor,
      oldest: oldestTsSec,
    });

    const msgs = Array.isArray(j.messages) ? j.messages : [];
    for (const m of msgs) {
      const text = normalizeText(m?.text || "");
      if (!text) continue;
      if (m?.subtype) continue;

      out.push({
        channel: convId,
        channelName: convName,
        ts: m.ts,
        user: m.user,
        text,
        thread_ts: m.thread_ts,
        reply_count: m.reply_count,
      });

      if (out.length >= cap) break;
    }

    if (out.length >= cap) break;
    cursor = j?.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  return out;
}

export async function slackOpenLoopsV1(
  runId: string,
  prompt: string,
  decision: RouteDecision,
  ctx: { userId: string }
) {
  const tok = await getSlackTokensForUser(ctx.userId);


  if (!tok || typeof (tok as any).access_token !== "string") {
    const authUrl = `/api/slack/oauth/start?runId=${encodeURIComponent(runId)}`;
    emit(runId, "warn", "Slack permission required", {
  kind: "slack_oauth",
  authUrl,
  perms: "slack_read",
});

    return {
      kind: "clarify" as const,
      prompt,
      question: "Connect Slack to analyze open loops, then run again.",
      suggested_commands: [
        "In Slack: what are my open loops across channels and DMs?",
        "In Slack: what are the top unanswered questions from the last 14 days?",
      ],
    };
  }

  const accessToken = (tok as any).access_token as string;
  const team_id = (tok as any).team_id as string | undefined;
  const team_name = (tok as any).team_name as string | undefined;

  const windowDays = 30;
  const oldestTsSec = Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000);

  emit(runId, "info", "Slack: listing conversations…");
  const convs = await listConversations(accessToken);

  emit(runId, "info", "Slack: pulling recent messages…", {
    conversations: convs.length,
    windowDays,
  });

  const MAX_CONVS = 35;
  const MAX_MSGS_PER_CONV = 220;

  const picked = convs.slice(0, MAX_CONVS);
  const allMsgs: SlackMsg[] = [];

  for (const c of picked) {
    const name = c.name ? `#${c.name}` : c.is_im ? "DM" : "Channel";
    try {
      const msgs = await fetchRecentMessages(accessToken, c.id, name, oldestTsSec, MAX_MSGS_PER_CONV);
      allMsgs.push(...msgs);
    } catch (e: any) {
      emit(runId, "warn", "Slack: conversation skipped", { conv: name, error: e?.message || "unknown" });
    }
  }

  allMsgs.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  const byThread = new Map<string, SlackMsg[]>();
  for (const m of allMsgs) {
    const threadKey = `${m.channel}:${m.thread_ts || m.ts}`;
    const arr = byThread.get(threadKey) || [];
    arr.push(m);
    byThread.set(threadKey, arr);
  }

  const items: Array<{
    type: "broken_commitment" | "unanswered_question" | "stalled_thread" | "ownership_gap";
    severity: "high" | "medium" | "low";
    title: string;
    where: string;
    ageDays: number;
    excerpt?: string;
    permalink?: string;
  }> = [];

  for (const msgs of byThread.values()) {
    const root = msgs[0];
    const last = msgs[msgs.length - 1];
    const lastTsSec = Math.floor(parseFloat(last.ts));
    const age = daysAgo(lastTsSec);

    const text = root.text;

    const hasClosure = msgs.some((x) => looksLikeClosure(x.text));
    const isQuestion = looksLikeQuestion(text);
    const isCommit = looksLikeCommitment(text);
    const isOwnership = looksLikeOwnershipGap(text);

    if (msgs.length >= 6 && age >= 5 && !hasClosure) {
      items.push({
        type: "stalled_thread",
        severity: age >= 10 ? "high" : "medium",
        title: "Stalled thread",
        where: root.channelName,
        ageDays: age,
        excerpt: text.slice(0, 160),
      });
    }

    const replyCount = root.reply_count || (msgs.length - 1);
    if (isQuestion && replyCount <= 1 && age >= 3 && !hasClosure) {
      items.push({
        type: "unanswered_question",
        severity: age >= 7 ? "high" : "medium",
        title: "Unanswered question",
        where: root.channelName,
        ageDays: age,
        excerpt: text.slice(0, 160),
      });
    }

    if (isCommit && age >= 2 && !hasClosure) {
      items.push({
        type: "broken_commitment",
        severity: age >= 7 ? "high" : "medium",
        title: "Possibly broken commitment",
        where: root.channelName,
        ageDays: age,
        excerpt: text.slice(0, 160),
      });
    }

    if (isOwnership && age >= 2 && !hasClosure) {
      items.push({
        type: "ownership_gap",
        severity: "low",
        title: "Ownership gap",
        where: root.channelName,
        ageDays: age,
        excerpt: text.slice(0, 160),
      });
    }
  }

  const sevW = { high: 30, medium: 18, low: 8 } as const;
  items.sort((a, b) => sevW[b.severity] + b.ageDays - (sevW[a.severity] + a.ageDays));

  const top = items.slice(0, 12);

  // Permalinks best-effort
  for (const it of top) {
    try {
      const match = allMsgs.find(
        (m) => m.channelName === it.where && m.text.startsWith((it.excerpt || "").slice(0, 40))
      );
      if (match) it.permalink = await getPermalink(accessToken, match.channel, match.ts);
    } catch {
      // ignore
    }
  }

  const summary =
    top.length === 0
      ? "No obvious open loops detected in the last 30 days (based on sampled channels)."
      : `Found ${top.length} high-leverage open loops to close (sampled ${picked.length} conversations).`;

  return {
    kind: "slack_open_loops" as const,
    plan: decision.plan,
    workspace: { id: team_id, name: team_name },
    windowDays,
    summary,
    items: top,
    note: convs.length > MAX_CONVS ? `Sampled ${MAX_CONVS} conversations for speed.` : undefined,
  };
}
