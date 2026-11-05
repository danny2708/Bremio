const UNITS = { h: 3600, m: 60, s: 1 };

/** Parse "1h30m"-style durations into seconds. Throws on invalid input. */
export function parseDuration(text) {
  const re = /(\d+)([hms])/g;
  let total = 0;
  let matched = "";
  let m;
  while ((m = re.exec(text)) !== null) {
    total += Number(m[1]) * UNITS[m[2]];
    matched += m[0];
  }
  if (matched !== text) throw new Error(`invalid duration: ${text}`);
  return total;
}
