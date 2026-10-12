import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, type Hunk } from '../src/diff';

/** Rebuilds the changed text from the original and the hunks, to prove the diff is exact. */
function patch(before: string, hunks: Hunk[]): string {
  const a = before.split('\n');
  const out: string[] = [];
  let i = 0;
  for (const h of hunks) {
    while (i < h.old - 1) out.push(a[i++]);
    expect(out.length).toBe(h.new - 1);
    for (const l of h.lines) {
      if (l.kind === ' ') {
        out.push(a[i++]);
      } else if (l.kind === '-') {
        i++;
      } else {
        out.push(l.text);
      }
    }
  }
  while (i < a.length) out.push(a[i++]);
  return out.join('\n');
}

describe('diffLines', () => {
  it('shows inserted and removed lines with context and line numbers', () => {
    const before = ['a {', '  top: 0px;', '  left: 0px;', '}', 'b {', '  opacity: 0;', '}'].join('\n');
    const after = ['a {', '  top: 0px;', '  left: 0px;', '  line-height: 19px;', '}', 'b {', '  opacity: 0.001;', '}'].join('\n');
    const hunks = diffLines(before, after, 1);
    expect(hunks.map((h) => h.lines.map((l) => `${l.kind}${l.old ?? '_'}/${l.new ?? '_'} ${l.text.trim()}`))).toEqual([
      [' 3/3 left: 0px;', '+_/4 line-height: 19px;', ' 4/5 }', ' 5/6 b {', '-6/_ opacity: 0;', '+_/7 opacity: 0.001;', ' 7/8 }'],
    ]);
    expect([hunks[0].old, hunks[0].new]).toEqual([3, 3]);
    expect(diffStats(hunks)).toEqual({ added: 2, removed: 1 });
  });

  it('returns nothing for equal texts and splits far-apart changes', () => {
    expect(diffLines('x\ny', 'x\ny')).toEqual([]);
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[2] = 'changed 2';
    changed[30] = 'changed 30';
    expect(diffLines(lines.join('\n'), changed.join('\n')).length).toBe(2);
  });

  it('reproduces the changed text exactly, for random edits', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 200; run++) {
      const a = Array.from({ length: 1 + rand(30) }, () => `l${rand(6)}`);
      const b = [...a];
      for (let e = rand(6); e > 0; e--) {
        const at = rand(b.length + 1);
        if (rand(2)) b.splice(at, 1);
        else b.splice(at, 0, `n${rand(6)}`);
      }
      const before = a.join('\n');
      const after = b.join('\n');
      expect(patch(before, diffLines(before, after, 0)), `${before} -> ${after}`).toBe(after);
    }
  });
});
