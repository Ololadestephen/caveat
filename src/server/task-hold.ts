import { existsSync } from "node:fs";
import { request } from "node:http";

// Keeps the sprite awake while a long run executes: PUT a task lease, refresh
// it every 60 s, DELETE when done. No-op where the sprite API socket is absent
// (local dev, tests).
const API_SOCK = "/.sprite/api.sock";
const EXPIRE = "5m";
const REFRESH_MS = 60000;

function apiCall(method: string, path: string, body?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: API_SOCK,
        method,
        path,
        headers:
          body !== undefined
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
            : {},
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export function startTaskHold(name: string): { stop: () => void } {
  if (!existsSync(API_SOCK)) return { stop: () => {} };
  const refresh = () => {
    apiCall("PUT", `/v1/tasks/${encodeURIComponent(name)}`, `{"expire":"${EXPIRE}"}`).catch(
      () => {},
    );
  };
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      apiCall("DELETE", `/v1/tasks/${encodeURIComponent(name)}`).catch(() => {});
    },
  };
}
