/** Minimal ANSI SGR parser for notebook tracebacks and stream output: colours, bold, italic, underline. */
export interface Segment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const BASIC = ["var(--ansi-0)", "var(--ansi-1)", "var(--ansi-2)", "var(--ansi-3)", "var(--ansi-4)", "var(--ansi-5)", "var(--ansi-6)", "var(--ansi-7)"];
const BRIGHT = ["var(--ansi-8)", "var(--ansi-9)", "var(--ansi-10)", "var(--ansi-11)", "var(--ansi-12)", "var(--ansi-13)", "var(--ansi-14)", "var(--ansi-15)"];

function color256(n: number): string | undefined {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const c = n - 16;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(Math.floor(c / 36))},${v(Math.floor(c / 6) % 6)},${v(c % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const SGR = /\u001b\[([0-9;]*)m/g;
const OTHER_ESC = /\u001b\[[0-9;?]*[A-Za-ln-zA-Z]|\u001b\][^\u0007]*\u0007/g; // cursor moves, OSC titles: dropped

/** Apply carriage returns the way a terminal does (a lone \r returns to column 0 and later characters overwrite). Same rule as the server. */
export function applyCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const buf: string[] = [];
      let col = 0;
      for (const ch of line) {
        if (ch === "\r") col = 0;
        else {
          buf[col] = ch;
          col += 1;
        }
      }
      return buf.join("");
    })
    .join("\n");
}

export function parseAnsi(input: string): Segment[] {
  const text = input.replace(OTHER_ESC, "");
  const out: Segment[] = [];
  let st: Omit<Segment, "text"> = {};
  let last = 0;
  const push = (s: string) => s && out.push({ text: s, ...st });
  for (const m of text.matchAll(SGR)) {
    push(text.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const codes = m[1] === "" ? [0] : m[1]!.split(";").map((x) => Number(x) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) st = {};
      else if (c === 1) st = { ...st, bold: true };
      else if (c === 3) st = { ...st, italic: true };
      else if (c === 4) st = { ...st, underline: true };
      else if (c === 22) st = { ...st, bold: false };
      else if (c >= 30 && c <= 37) st = { ...st, fg: BASIC[c - 30] };
      else if (c >= 90 && c <= 97) st = { ...st, fg: BRIGHT[c - 90] };
      else if (c >= 40 && c <= 47) st = { ...st, bg: BASIC[c - 40] };
      else if (c >= 100 && c <= 107) st = { ...st, bg: BRIGHT[c - 100] };
      else if (c === 39) st = { ...st, fg: undefined };
      else if (c === 49) st = { ...st, bg: undefined };
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        st = { ...st, [c === 38 ? "fg" : "bg"]: color256(codes[i + 2] ?? 0) };
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        st = { ...st, [c === 38 ? "fg" : "bg"]: `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})` };
        i += 4;
      }
    }
  }
  push(text.slice(last));
  return out;
}
