// Opt-in diagnostics only. No database/file writes, URLs, headers or lease tokens.
export const timingEnabled = process.env.CRAWLER_TIMING_LOGS === '1';
export const elapsedMs = (start: number) => Math.round((performance.now() - start) * 100) / 100;
export function timingLog(stage: string, fields: Record<string, unknown>) {
  if (!timingEnabled) return;
  // Diagnostics must never change the outcome of a request or transaction.
  try { console.log(JSON.stringify({ event: 'crawler_timing', at: new Date().toISOString(), stage, ...fields })); }
  catch { /* A broken logging sink must not interrupt crawling. */ }
}
