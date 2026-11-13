import { useEffect, useState } from "react";

// Snapshot age; turns into a warning once the server-side cache gives up on it.
export function Updated({ at, staleLimitMs }: { at?: number; staleLimitMs?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  if (!at) return <span className="updated">Loading…</span>;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (staleLimitMs && now - at >= staleLimitMs) return <span className="updated stale">Snapshot expired</span>;
  return <span className="updated">Updated {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`} ago</span>;
}
