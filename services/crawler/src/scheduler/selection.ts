import type { DiscoveryScheduling } from '../../../../packages/core/src/types.js';

// One persistent turn per charged request, including retries and redirects.
// If a queue is empty its turn is borrowed without accumulating unlimited debt.
export function nextTurn(turn: number, kind: 'article' | 'discovery', weights: DiscoveryScheduling): number {
  const { articleWeight, discoveryWeight } = weights;
  if (kind === 'article') return Math.min(turn + 1, articleWeight);
  return turn >= articleWeight ? (turn + 1) % (articleWeight + discoveryWeight) : 0;
}
