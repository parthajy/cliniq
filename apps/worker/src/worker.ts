import "dotenv/config";
import { log } from "./log.js";

async function tick() {
  log("tick", "heartbeat");
  // v1: connect supabase, claim queued task, create run, emit run_events
  // keep it simple initially; we’ll wire DB next.
}

setInterval(() => {
  tick().catch((e) => log("tick", "error", { message: e?.message, stack: e?.stack }));
}, 1500);

log("boot", "worker started");
