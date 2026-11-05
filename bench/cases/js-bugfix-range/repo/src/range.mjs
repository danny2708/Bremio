/** Integers from start to end, inclusive. range(1, 3) -> [1, 2, 3]. */
export function range(start, end, step = 1) {
  const out = [];
  for (let i = start; i < end; i += step) out.push(i);
  return out;
}
