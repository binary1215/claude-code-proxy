import { spawn } from "node:child_process";
import { CLAUDE_AUTH_AUTO_REFRESH } from "../config.js";

/** No provider calls here: the serialized helper runs only official auth status. */
export function startAuthRefreshScheduler(): () => void {
  if (!CLAUDE_AUTH_AUTO_REFRESH) return () => {};
  let running = false;
  let stopped = false;
  let activeStop: (() => void) | undefined;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    const child = spawn("claude-auth", ["refresh"], { stdio: "ignore", detached: process.platform !== "win32" });
    let forcedKill: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* exited */ }
    };
    activeStop = () => { kill("SIGTERM"); forcedKill = setTimeout(() => kill("SIGKILL"), 1000); };
    const timeout = setTimeout(() => { kill("SIGTERM"); forcedKill = setTimeout(() => kill("SIGKILL"), 1000); }, 75_000);
    let settled = false;
    const finished = () => { if (settled) return; settled = true; running = false; activeStop = undefined;
      clearTimeout(timeout); if (forcedKill) clearTimeout(forcedKill); };
    child.once("error", finished);
    child.once("close", finished);
  };
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); activeStop?.(); };
}
