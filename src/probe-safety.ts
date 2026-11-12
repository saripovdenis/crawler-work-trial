// The deployed v0 worker has an in-process limiter. Sidecar probes must only
// run while that site's worker has no possible work for the whole experiment.
export function assertProbeWindow(state: {
  sources: number; healthy: number; nextPoll: number | null;
  pending: number; unfinished: number;
}, now: number, deadline: number) {
  if (deadline <= now + 30_000) throw new Error('Probe deadline reached');
  if (!state.sources || state.healthy || state.nextPoll === null || state.nextPoll <= deadline + 60_000)
    throw new Error('Site is not in a sufficiently long failure backoff');
  if (state.pending || state.unfinished) throw new Error('Site has queued or in-flight work');
}
