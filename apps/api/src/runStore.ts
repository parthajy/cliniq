import type { RunEventLevel } from "@cliniq/core";

export type RunStatus = "running" | "done" | "failed";

export type RunEvent = {
  ts: number;
  level: RunEventLevel;
  message: string;
  data?: any;
};

export type Run = {
  id: string;
  prompt: string;
  status: RunStatus;
  createdAt: number;
  events: RunEvent[];
  finalOutput?: any;
  error?: string;
  // SSE subscribers
  subs: Set<(evt: any) => void>;
};

const runs = new Map<string, Run>();

function uid() {
  // good enough for dev; replace with uuid later
  return "run_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}

export function createRun(prompt: string): Run {
  const id = uid();
  const run: Run = {
    id,
    prompt,
    status: "running",
    createdAt: Date.now(),
    events: [],
    subs: new Set(),
  };
  runs.set(id, run);
  console.log("[API][runStore] createRun", { id, promptLen: prompt.length });
  return run;
}

export function getRun(id: string) {
  return runs.get(id) || null;
}

export function subscribe(runId: string, cb: (evt: any) => void) {
  const run = runs.get(runId);
  if (!run) return () => {};
  run.subs.add(cb);
  console.log("[API][runStore] subscribe", { runId, subs: run.subs.size });
  return () => {
    run.subs.delete(cb);
    console.log("[API][runStore] unsubscribe", { runId, subs: run.subs.size });
  };
}

export function emit(runId: string, level: RunEventLevel, message: string, data?: any) {
  const run = runs.get(runId);
  if (!run) return;
  const evt: RunEvent = { ts: Date.now(), level, message, data };
  run.events.push(evt);
  for (const cb of run.subs) cb({ type: "event", runId, event: evt });
  console.log("[API][event]", { runId, level, message });
}

export function finish(runId: string, output: any) {
  const run = runs.get(runId);
  if (!run) return;
  run.status = "done";
  run.finalOutput = output;
  for (const cb of run.subs) cb({ type: "done", runId, output });
  console.log("[API][runStore] finish", { runId });
}

export function fail(runId: string, error: string) {
  const run = runs.get(runId);
  if (!run) return;
  run.status = "failed";
  run.error = error;
  for (const cb of run.subs) cb({ type: "failed", runId, error });
  console.error("[API][runStore] fail", { runId, error });
}
