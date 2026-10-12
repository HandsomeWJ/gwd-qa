// Line diff for showing what the fixes change. Myers' algorithm runs on the lines between the
// common prefix and suffix, which stays fast because fixes touch few lines.

export interface DiffLine {
  kind: ' ' | '-' | '+';
  text: string;
  old?: number; // 1-based line in the original; absent for an added line
  new?: number; // 1-based line in the changed text; absent for a removed line
}

export interface Hunk {
  old: number; // where the hunk starts in the original
  new: number; // where it starts in the changed text
  lines: DiffLine[];
}

type Op = '=' | '-' | '+';

// Beyond this many changed lines, show the changed region as one replacement.
const MAX_CHANGES = 1500;

/** The shortest edit script from a to b, or null when it needs more than MAX_CHANGES edits. */
function editScript(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const off = n + m + 1;
  const v = new Int32Array(2 * off + 1);
  const trace: Int32Array[] = []; // trace[d][k + d] = furthest x on diagonal k after d edits
  for (let d = 0; d <= n + m; d++) {
    if (d > MAX_CHANGES) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1));
        return backtrack(trace, n, m);
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = (k: number) => trace[d - 1][k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && prev(k - 1) < prev(k + 1));
    const px = prev(down ? k + 1 : k - 1);
    const py = px - (down ? k + 1 : k - 1);
    while (x > px + (down ? 0 : 1) && y > py + (down ? 1 : 0)) {
      ops.push('=');
      x--;
      y--;
    }
    ops.push(down ? '+' : '-');
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    ops.push('=');
    x--;
    y--;
  }
  return ops.reverse();
}

/** Changed lines between two texts, grouped into hunks with `context` unchanged lines around each change. */
export function diffLines(before: string, after: string, context = 2): Hunk[] {
  if (before === after) return [];
  const a = before.split('\n');
  const b = after.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const mid = editScript(midA, midB) ?? [...midA.map((): Op => '-'), ...midB.map((): Op => '+')];
  const ops: Op[] = [...Array<Op>(pre).fill('='), ...mid, ...Array<Op>(suf).fill('=')];

  // `at` is where each line sits in both texts, so a hunk can start on any kind of line.
  const lines: (DiffLine & { at: [number, number] })[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    const at: [number, number] = [i + 1, j + 1];
    if (op === '=') lines.push({ kind: ' ', text: a[i++], old: i, new: ++j, at });
    else if (op === '-') lines.push({ kind: '-', text: a[i++], old: i, at });
    else lines.push({ kind: '+', text: b[j++], new: j, at });
  }
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, k) => {
    if (l.kind === ' ') return;
    for (let c = Math.max(0, k - context); c <= Math.min(lines.length - 1, k + context); c++) keep[c] = 1;
  });
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  lines.forEach(({ at, ...l }, k) => {
    if (!keep[k]) {
      current = null;
      return;
    }
    if (!current) {
      current = { old: at[0], new: at[1], lines: [] };
      hunks.push(current);
    }
    current.lines.push(l);
  });
  return hunks;
}

export function diffStats(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === '+') added++;
      else if (l.kind === '-') removed++;
    }
  }
  return { added, removed };
}
