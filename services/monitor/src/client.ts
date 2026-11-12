import { domainFor } from "../../../packages/core/src/policy.js";
const allowed = new Map([
  ["news.google.com", "/rss/search"],
  ["api.exa.ai", "/search"],
]);
export function validateProviderUrl(raw: string) {
  const u = new URL(raw);
  if (
    domainFor(raw) ||
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    allowed.get(u.hostname) !== u.pathname
  )
    throw new Error("Provider client refused destination");
  return u;
}
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: number | null = null,
  ) {
    super(`Provider HTTP ${status}`);
  }
}
export async function providerRequest(raw: string, init: RequestInit = {}) {
  validateProviderUrl(raw);
  const response = await fetch(raw, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const retry = response.headers.get("retry-after");
    throw new ProviderError(
      response.status,
      retry
        ? /^\d+$/.test(retry)
          ? Date.now() + Number(retry) * 1000
          : Date.parse(retry)
        : null,
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader)
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Provider response too large");
      }
      chunks.push(value);
    }
  return Buffer.concat(chunks).toString("utf8");
}
