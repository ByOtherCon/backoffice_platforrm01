// Splitting money by weights without losing a cent (largest-remainder method).
export function splitCents(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((n, w) => n + w, 0);
  if (!(sum > 0)) throw new Error('Weights must add up to more than zero.');
  const exact = weights.map((w) => (totalCents * w) / sum), out = exact.map(Math.floor);
  let left = totalCents - out.reduce((n, c) => n + c, 0);
  exact.map((x, i) => [x - out[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach(([, i]) => { if (left-- > 0) out[i]++; });
  return out;
}
