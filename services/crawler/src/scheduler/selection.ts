import type { DiscoveryScheduling } from '../../../../packages/core/src/types.js';

// Persistent weighted credit per charged request, including retries and redirects.
// Articles earn discoveryWeight; discoveries spend articleWeight (normally 3:1).
// An early discovery borrows article slots; negative credit repays that debt.
// Clamp idle borrowing so an empty queue cannot accumulate unlimited credit/debt.
export function nextTurn(turn: number, kind: 'article' | 'discovery', weights: DiscoveryScheduling, articleWaiting: boolean): number {
  const { articleWeight, discoveryWeight } = weights;
  if (kind === 'article') return Math.min(turn + discoveryWeight, articleWeight + discoveryWeight - 1);
  // Idle discovery borrows freely; only queued articles can be owed a turn.
  return Math.max(turn - articleWeight, articleWaiting ? -articleWeight : 0);
}
