/** Deterministic PRNG (mulberry32) so re-running db:reset always produces the same demo numbers. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeHelpers(rand) {
  function pick(arr) {
    return arr[Math.floor(rand() * arr.length)];
  }
  function weightedKey(items) {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = rand() * total;
    for (const it of items) {
      r -= it.weight;
      if (r <= 0) return it.key;
    }
    return items[items.length - 1].key;
  }
  function int(min, max) {
    return Math.floor(rand() * (max - min + 1)) + min;
  }
  function chance(p) {
    return rand() < p;
  }
  return { pick, weightedKey, int, chance };
}
