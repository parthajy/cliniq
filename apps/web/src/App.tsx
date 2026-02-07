// /Users/partha/Desktop/cliniq/apps/web/src/App.tsx
import { useEffect, useMemo, useRef, useState } from "react";

type FeedEvt = { ts: number; level: "info" | "warn" | "error"; message: string; data?: any };

type Status = "idle" | "running" | "done" | "failed";

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function App() {
  const API = useMemo(() => import.meta.env.VITE_API_BASE || "/api", []);

  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [events, setEvents] = useState<FeedEvt[]>([]);
  const [finalOutput, setFinalOutput] = useState<any>(null);

  const esRef = useRef<EventSource | null>(null);
  const viewportBottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const userId = useMemo(() => getOrCreateUserId(), []);

    async function finalizeFromApi(id: string) {
    try {
      const r = await fetch(`${API}/run/${id}`);
      const j = await r.json();
      if (!j?.ok) return;

      const s = j.run?.status as string;
      if (s === "done") {
        setFinalOutput(j.run.finalOutput);
        setStatus("done");
      } else if (s === "failed") {
        setStatus("failed");
      }
    } catch (e) {
      console.error("[WEB] finalizeFromApi failed", e);
    }
  }

  useEffect(() => {
    viewportBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length, finalOutput]);

  // derive "permission required" from the latest event that contains authUrl
    const permissionEvt = useMemo(() => {
    // show the latest auth request only if we haven't seen "Permission granted" AFTER it
    let authIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.data?.authUrl) {
        authIdx = i;
        break;
      }
    }
    if (authIdx === -1) return null;
    for (let j = authIdx + 1; j < events.length; j++) {
      if (events[j]?.message?.toLowerCase?.().includes("permission granted")) return null;
    }
    return events[authIdx];
  }, [events]);

  async function startRun() {
    const p = prompt.trim();
    if (!p || status === "running") return;

    console.log("[WEB] startRun", { promptLen: p.length });

    setStatus("running");
    setEvents([]);
    setFinalOutput(null);

    const res = await fetch(`${API}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: p, userId }),
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      console.error("[WEB] non-JSON response", { status: res.status, text });
      setStatus("failed");
      return;
    }
    if (!res.ok || !json?.ok) {
      console.error("[WEB] run create failed", { status: res.status, json });
      setStatus("failed");
      return;
    }

    const id = json.runId as string;
    setRunId(id);

    if (esRef.current) esRef.current.close();

    const es = new EventSource(`${API}/run/${id}/stream`);
    esRef.current = es;

    es.addEventListener("event", (e: MessageEvent) => {
  const payload = JSON.parse(e.data);
  const evt: FeedEvt = payload.event;
  setEvents((prev) => [...prev, evt]);

  // 🔒 Fallback: some runs may not deliver "done" event reliably.
  // When we see the final trace line, fetch finalOutput from /run/:id.
        if (evt?.message === "Execution complete") {
        finalizeFromApi(id);
  }
});

    es.addEventListener("done", (e: MessageEvent) => {
      const payload = JSON.parse(e.data);
      setFinalOutput(payload.output);
      setStatus("done");
      es.close();
    });

    es.addEventListener("failed", (e: MessageEvent) => {
      const payload = JSON.parse(e.data);
      console.error("[WEB][sse] failed", payload);
      setStatus("failed");
      es.close();
    });

    es.onerror = (err) => {
      console.error("[WEB][sse] error", err);
    };
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl + Enter to run
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      startRun();
    }
  }

  function getOrCreateUserId() {
  const k = "cliniq_user_id";
  const existing = localStorage.getItem(k);
  if (existing) return existing;

  const id =
    (crypto as any)?.randomUUID?.() ||
    `u_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  localStorage.setItem(k, id);
  return id;
}

  return (
    <div className="h-screen w-screen bg-white text-zinc-950">
      <TopBar status={status} runId={runId} />

      {/* Main: viewport + right rail */}
      <div className="mx-auto flex h-[calc(100vh-64px)] max-w-[1200px] gap-6 px-6 py-6">
        {/* Viewport column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Viewport */}
          <div className="min-h-0 flex-1 overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
              <div>
                <div className="text-sm font-semibold tracking-tight">Viewport</div>
                <div className="mt-1 text-xs text-zinc-500">
                  One prompt. Live execution. Ephemeral output.
                </div>
              </div>

              <div className="hidden items-center gap-2 md:flex">
                <kbd className="rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-600">
                  ⌘ / Ctrl
                </kbd>
                <span className="text-xs text-zinc-400">+</span>
                <kbd className="rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-600">
                  Enter
                </kbd>
                <span className="text-xs text-zinc-500">to run</span>
              </div>
            </div>

            <div className="h-full overflow-auto px-5 py-5">
              {/* Trace */}
              <div className="space-y-3">
                {events.length === 0 && status !== "running" ? (
                  <EmptyState onExample={(v) => setPrompt(v)} focus={() => textareaRef.current?.focus()} />
                ) : null}

                {events.map((e, idx) => (
                  <EventRow key={idx} evt={e} />
                ))}

                {/* Output */}
                {finalOutput ? (
                  <div className="pt-2">
                    <OutputRenderer
                      output={finalOutput}
                      runId={runId}
                      apiBase={API}
                      copyToClipboard={copyToClipboard}
                      userId={userId}
                    />
                  </div>
                ) : null}

                <div ref={viewportBottomRef} />
              </div>
            </div>
          </div>

          {/* Composer (sticky bottom) */}
          <div className="mt-5 rounded-3xl border border-zinc-200 bg-white shadow-sm">
            <div className="px-5 pt-4">
              <div className="text-xs font-medium text-zinc-600">Command</div>
            </div>

            <div className="px-3 pb-3 pt-2">
              <div className="rounded-2xl border border-zinc-200 bg-white focus-within:border-zinc-400">
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder='Ask: “Top priority emails today, draft replies.”'
                  className="h-24 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none"
                />

                <div className="flex items-center justify-between px-4 pb-3">
                  <div className="text-xs text-zinc-500">
  Try:{" "}
  {prompt.toLowerCase().includes("slack")
    ? "“In Slack: what are my open loops across channels and DMs?”"
    : "“Schedule a meeting with Partha at 3 PM on 3rd Feb (Google Meet)”"}
</div>

                  <button
                    onClick={startRun}
                    disabled={status === "running"}
                    className="inline-flex items-center gap-2 rounded-2xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {status === "running" ? (
                      <>
                        <span className="h-2 w-2 animate-pulse rounded-full bg-white/80" />
                        Running…
                      </>
                    ) : (
                      "Run"
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right rail */}
        <div className="hidden w-[340px] shrink-0 flex-col gap-4 lg:flex">
          <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold">Approvals</div>
            <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-3">
              <div className="text-sm font-medium">Next</div>
              <div className="mt-1 text-xs text-zinc-500">
                Gmail send + Calendar create will require explicit approval.
              </div>
            </div>
          </div>

          {permissionEvt ? (
  <PermissionBox evt={permissionEvt} apiBase={API} />
) : (

            <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="text-sm font-semibold">Connections</div>
              <div className="mt-3 text-xs text-zinc-500">
                When a run needs access (Gmail/Calendar), a permission request will appear here.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TopBar({ status, runId }: { status: Status; runId: string | null }) {
  const dot =
    status === "running"
      ? "bg-amber-500"
      : status === "done"
      ? "bg-emerald-500"
      : status === "failed"
      ? "bg-red-500"
      : "bg-zinc-300";

  return (
    <header className="sticky top-0 z-10 h-16 border-b border-zinc-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1200px] items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-2xl border border-zinc-200 bg-white shadow-sm" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Cliniq</div>
            <div className="text-xs text-zinc-500">Prompt → Router → Handler → Output</div>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-zinc-600">
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1">
            <span className={`h-2 w-2 rounded-full ${dot}`} />
            {String(status).toUpperCase()}
          </span>
          {runId ? <span className="max-w-[320px] truncate text-zinc-400">{runId}</span> : null}
        </div>
      </div>
    </header>
  );
}

function EmptyState({ onExample, focus }: { onExample: (v: string) => void; focus: () => void }) {
  return (
    <div className="rounded-3xl border border-dashed border-zinc-200 bg-white p-5">
      <div className="text-sm font-semibold">No activity yet</div>
      <div className="mt-1 text-xs text-zinc-500">Run something and the live trace will appear here.</div>

      <div className="mt-4 grid gap-2 md:grid-cols-2">
        <button
          onClick={() => {
            onExample("Check the top 3 emails worth replying today and draft replies");
            focus();
          }}
          className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-left text-sm hover:bg-zinc-50"
        >
          <div className="font-medium">Gmail triage</div>
          <div className="mt-1 text-xs text-zinc-500">Find top 3 reply-worthy emails + drafts</div>
        </button>

        <button
          onClick={() => {
            onExample("Schedule a meeting with Partha at 3 PM on 3rd Feb (Google Meet)");
            focus();
          }}
          className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-left text-sm hover:bg-zinc-50"
        >
          <div className="font-medium">Calendar scheduling</div>
          <div className="mt-1 text-xs text-zinc-500">Draft an event (approval required)</div>
        </button>
      </div>
            <div className="mt-2">
        <button
          onClick={() => {
            onExample("In Slack: what are my open loops across channels and DMs?");
            focus();
          }}
          className="w-full rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-left text-sm hover:bg-zinc-50"
        >
          <div className="font-medium">Slack open loops</div>
          <div className="mt-1 text-xs text-zinc-500">Broken commitments • unanswered questions • stalled threads</div>
        </button>
      </div>
    </div>
  );
}

function PermissionBox({ evt, apiBase }: { evt: FeedEvt; apiBase: string }) {
  const raw = evt?.data?.authUrl as string | undefined;

  // If backend emits absolute URL, keep it.
  // If backend emits relative "/slack/oauth/start?...",
  // prefix with apiBase (Fly root), and also strip accidental "/api" prefix.
  const normalizePath = (p: string) => {
    if (!p) return p;
    if (p.startsWith("/api/")) return p.slice(4); // "/api/foo" -> "/foo"
    if (p === "/api") return "/";
    return p;
  };

  const authUrl =
    raw && /^https?:\/\//i.test(raw)
      ? raw
      : raw
      ? `${apiBase}${normalizePath(raw).startsWith("/") ? "" : "/"}${normalizePath(raw)}`
      : "";


  const perms = String(evt?.data?.perms || "");
  const kind = String(evt?.data?.kind || "");

  const isSlack =
    kind === "slack_oauth" ||
    perms.toLowerCase().includes("slack") ||
    evt.message.toLowerCase().includes("slack");

  const providerLabel = isSlack ? "Slack" : "Google";
  const buttonLabel = isSlack ? "Connect Slack" : "Connect Google";
  const badge = isSlack ? "Slack OAuth" : "OAuth";

  const resolvedAuthUrl = authUrl;

  return (
    <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-900">Permission required</div>
          <div className="mt-1 text-xs text-zinc-700">
            This run needs {providerLabel} access{perms ? ` (${perms})` : ""}.
          </div>
        </div>
        <span className="rounded-full bg-white px-2 py-1 text-[11px] font-medium text-amber-700">
          {badge}
        </span>
      </div>

      <div className="mt-3 rounded-2xl border border-amber-200 bg-white p-3">
        <div className="text-xs text-zinc-600">Action</div>
        <div className="mt-2 flex items-center gap-2">
          <a
            href={resolvedAuthUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center rounded-xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800"
          >
            {buttonLabel}
          </a>
          <div className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">{resolvedAuthUrl}</div>
        </div>
      </div>
    </div>
  );
}

function EventRow({ evt }: { evt: FeedEvt }) {
  const dot =
    evt.level === "info" ? "bg-zinc-400" : evt.level === "warn" ? "bg-amber-500" : "bg-red-500";

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex gap-3">
        <div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm">{evt.message}</div>

          {evt.data ? (
            <pre className="mt-2 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
              {JSON.stringify(evt.data, null, 2)}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function OutputRenderer({
  output,
  runId,
  apiBase,
  copyToClipboard,
  userId,
}: {
  output: any;
  runId: string | null;
  apiBase: string;
  copyToClipboard: (text: string) => Promise<boolean>;
  userId: string;
}) {

    if (output?.kind === "slack_open_loops" && Array.isArray(output?.items)) {
    const items = output.items as any[];
    const ws = output.workspace?.name ? ` · ${output.workspace.name}` : "";

    const badge =
      items.some((x) => x.severity === "high")
        ? "bg-red-50 text-red-700 border-red-200"
        : items.some((x) => x.severity === "medium")
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-emerald-50 text-emerald-700 border-emerald-200";

    return (
      <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Output</div>
          <span className={`rounded-full border px-2 py-1 text-[11px] ${badge}`}>
            Slack open loops{ws}
          </span>
        </div>

        <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="text-sm font-semibold text-zinc-900">{output.summary}</div>
          <div className="mt-1 text-xs text-zinc-500">
            Window: last {output.windowDays} days{output.note ? ` • ${output.note}` : ""}
          </div>

          <div className="mt-4 space-y-3">
            {items.length === 0 ? (
              <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                Nothing actionable detected. Try: “In Slack: what are the top unanswered questions from the last 14 days?”
              </div>
            ) : null}

            {items.map((it, idx) => {
              const sevDot =
                it.severity === "high"
                  ? "bg-red-500"
                  : it.severity === "medium"
                  ? "bg-amber-500"
                  : "bg-zinc-400";
              const typeLabel =
                it.type === "broken_commitment"
                  ? "Broken commitment"
                  : it.type === "unanswered_question"
                  ? "Unanswered question"
                  : it.type === "stalled_thread"
                  ? "Stalled thread"
                  : "Ownership gap";

              return (
                <div key={idx} className="rounded-2xl border border-zinc-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${sevDot}`} />
                        <div className="text-sm font-semibold text-zinc-900">{typeLabel}</div>
                        <span className="rounded-full bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-600">
                          {it.where}
                        </span>
                        <span className="rounded-full bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-600">
                          {it.ageDays}d open
                        </span>
                      </div>
                      {it.excerpt ? (
                        <div className="mt-2 text-sm text-zinc-700">{it.excerpt}</div>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      onClick={async () => {
                        const txt = `[${typeLabel}] ${it.where} (${it.ageDays}d)\n${it.excerpt || ""}\n${it.permalink || ""}`.trim();
                        await copyToClipboard(txt);
                      }}
                      className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
                    >
                      Copy
                    </button>

                    {it.permalink ? (
                      <a
                        href={it.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center justify-center rounded-xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800"
                      >
                        Open in Slack
                      </a>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }
  const [showTech, setShowTech] = useState(false);

      if (output?.kind === "calendar_schedule" && output?.draftEvent) {
    const d = output.draftEvent;
    const when = `${d.start} → ${d.end}`;
    const notes: string[] = Array.isArray(d.notes) ? d.notes : [];

    return (
      <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Output</div>
          <span className="rounded-full border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-600">
            Calendar
          </span>
        </div>

        <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="text-sm font-semibold">{d.title}</div>
          <div className="mt-1 text-xs text-zinc-500">{when}</div>

          {d.attendees?.length ? (
            <div className="mt-3 text-xs text-zinc-600">
              Attendees:{" "}
              <span className="font-medium text-zinc-800">
                {d.attendees.map((a: any) => a.email || a.name || "Unknown").join(", ")}
              </span>
              {d.createWithoutInvite ? (
                <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                  will create without invite
                </span>
              ) : null}
            </div>
          ) : null}

          {notes.length ? (
            <div className="mt-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
              {notes.map((n, i) => (
                <div key={i}>• {n}</div>
              ))}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              onClick={async () => {
                const txt = `Event: ${d.title}\nWhen: ${when}\nMeet: ${d.meet ? "Yes" : "No"}`;
                await copyToClipboard(txt);
              }}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
            >
              Copy details
            </button>

            <button
              onClick={async () => {
                if (!runId) return;

                const ar = await fetch(`${apiBase}/run/${runId}/approve`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    action: "calendar_create",
                    approvalId: d.draftId,
                     draftId: d.draftId,
                 id: d.draftId,
                  }),
                });

                 const at = await ar.text();
 let aj: any = null;
 try { aj = at ? JSON.parse(at) : null; } catch {}
 if (!ar.ok || !aj?.ok) {
   alert(`Approve failed: ${aj?.error || ar.status}\n${at?.slice(0, 200) || ""}`);
   return;
 }
 console.log("[WEB] approve ok", aj);

                const res = await fetch(`${apiBase}/calendar/create`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    runId,
                    draftId: d.draftId,
                    approvalId: d.draftId,
                    title: d.title,
                    start: d.start,
                    end: d.end,
                    timezone: d.timezone,
                    meet: d.meet,
                    attendees: d.attendees || [],
                    createWithoutInvite: !!d.createWithoutInvite,
                    userId,
                  }),
                });

                const text = await res.text();
                let j: any = null;
                try { j = text ? JSON.parse(text) : null; } catch {}

                if (!res.ok || !j?.ok) {
                  alert(`Create failed: ${j?.error || res.status}`);
                  return;
                }

                const link = j?.event?.htmlLink || "";
                alert(link ? `Created ✅\n${link}` : "Created ✅");
              }}
              className="rounded-xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800"
            >
              Approve & Create
            </button>
          </div>
        </div>
      </div>
    );
  }



  if (output?.kind === "gmail_triage" && Array.isArray(output?.top)) {
    return (
      <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Output</div>
          <span className="rounded-full border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-600">
            Gmail triage
          </span>
        </div>

        <div className="mt-3 space-y-3">
          {output.top.map((m: any) => (
            <div key={m.messageId} className="rounded-2xl border border-zinc-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{m.subject}</div>
                  <div className="mt-1 truncate text-xs text-zinc-500">{m.from}</div>
                </div>
                <span className="shrink-0 rounded-full bg-zinc-50 px-2 py-1 text-[11px] text-zinc-600">
                  draft ready
                </span>
              </div>

              {m.snippet ? (
                <div className="mt-3 line-clamp-3 text-sm text-zinc-700">{m.snippet}</div>
              ) : null}

              {m.suggestedReply ? (
  <div className="mt-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-3">
    <div className="text-xs font-medium text-zinc-600">Suggested reply</div>
    <pre className="mt-2 whitespace-pre-wrap text-xs text-zinc-800">{m.suggestedReply}</pre>

    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        onClick={async () => {
          await copyToClipboard(m.suggestedReply);
        }}
        className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
      >
        Copy
      </button>

      <button
        onClick={async () => {
          if (!runId) return;

          // 1) approve
          await fetch(`${apiBase}/run/${runId}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "gmail_send",
              messageId: m.messageId,
            }),
          });

          // 2) send
          const res = await fetch(`${apiBase}/gmail/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              runId,
              messageId: m.messageId,
              toEmail: m.toEmail || m.from,
              subject: m.subject,
              replyText: m.suggestedReply,
              threadId: m.threadId,
              inReplyTo: m.rfcMessageId,
              userId,
            }),
          });

          const text = await res.text();
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}

          if (!res.ok || !json?.ok) {
            alert(`Send failed: ${json?.error || res.status}`);
            return;
          }

          alert("Sent ✅");
        }}
        className="rounded-xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800"
      >
        Approve & Send
      </button>
    </div>
  </div>
) : null}

            </div>
          ))}
        </div>

        <div className="mt-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
          Query: <span className="font-mono text-[11px]">{output.query}</span>
        </div>
      </div>
    );
  }

    if (output?.kind === "web_public_analysis") {
    const focus = String(output?.focus || "general");
    const question = String(output?.question || "");
    const answer = String(output?.answer || "");
    const recs = Array.isArray(output?.recommendations) ? output.recommendations : [];
    const sites = Array.isArray(output?.sites) ? output.sites : [];
    const note = output?.note ? String(output.note) : "";

    const focusLabel =
      focus === "copy" ? "Copy & messaging" : focus === "color" ? "Brand & color" : focus === "ux" ? "UX & conversion" : "General";

    return (
      <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Output</div>
          <span className="rounded-full border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-600">
            Web analysis · {focusLabel}
          </span>
        </div>

        {/* Answer */}
        <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-4">
          {question ? (
            <div className="text-xs text-zinc-500">
              Question
              <div className="mt-1 text-sm font-medium text-zinc-900">{question}</div>
            </div>
          ) : null}

          <div className="mt-3">
            <div className="text-xs font-medium text-zinc-600">Verdict</div>
            <div className="mt-2 text-sm leading-relaxed text-zinc-800">{answer || "No answer generated."}</div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              onClick={async () => {
                const txt = answer || JSON.stringify(output, null, 2);
                await copyToClipboard(txt);
              }}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
            >
              Copy verdict
            </button>

            <button
              onClick={() => setShowTech((v) => !v)}
              className="rounded-xl bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800"
            >
              {showTech ? "Hide technical" : "Show technical"}
            </button>
          </div>

          {note ? (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              {note}
            </div>
          ) : null}
        </div>

        {/* Recommendations */}
        <div className="mt-3">
          <div className="mb-2 text-xs font-medium text-zinc-600">Recommendations</div>

          {recs.length === 0 ? (
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700">
              No actionable recommendations found. (This likely means the pages were too hard to parse or didn’t expose enough HTML.)
            </div>
          ) : (
            <div className="space-y-3">
              {recs.map((r: any, idx: number) => {
                const applies = String(r?.appliesTo || "both");
                const pill =
                  applies === "site_a" ? "Site A" : applies === "site_b" ? "Site B" : "Both";

                const actions: string[] = Array.isArray(r?.actions) ? r.actions : [];
                const evidence: string[] = Array.isArray(r?.evidence) ? r.evidence : [];
                const rationale = String(r?.rationale || "");
                const title = String(r?.title || `Recommendation ${idx + 1}`);

                return (
                  <div key={idx} className="rounded-2xl border border-zinc-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-zinc-900">{title}</div>
                        {rationale ? (
                          <div className="mt-1 text-sm text-zinc-700">{rationale}</div>
                        ) : null}
                      </div>
                      <span className="shrink-0 rounded-full bg-zinc-50 px-2 py-1 text-[11px] text-zinc-600">
                        {pill}
                      </span>
                    </div>

                    {actions.length ? (
                      <div className="mt-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-3">
                        <div className="text-xs font-medium text-zinc-600">Actions</div>
                        <div className="mt-2 space-y-1 text-sm text-zinc-800">
                          {actions.map((a, i) => (
                            <div key={i}>• {a}</div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {evidence.length ? (
                      <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-3">
                        <div className="text-xs font-medium text-zinc-600">Evidence</div>
                        <div className="mt-2 space-y-1 text-xs text-zinc-700">
                          {evidence.map((ev, i) => (
                            <div key={i}>• {String(ev)}</div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Technical */}
        {showTech ? (
          <div className="mt-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-zinc-600">Technical extract</div>
              <button
                onClick={async () => {
                  await copyToClipboard(JSON.stringify(output, null, 2));
                }}
                className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
              >
                Copy JSON
              </button>
            </div>
            <pre className="mt-3 overflow-auto rounded-2xl border border-zinc-200 bg-white p-4 text-xs text-zinc-800">
              {JSON.stringify({ sites, focus, question }, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    );
  }

  // fallback: show raw JSON
  return (
    <div className="rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-semibold">Output</div>
      <pre className="mt-2 overflow-auto rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-xs">
        {JSON.stringify(output, null, 2)}
      </pre>
    </div>
  );
}
