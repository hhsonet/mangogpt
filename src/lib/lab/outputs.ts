import { applyCarriageReturns } from "./ansi";
import { textOf } from "./notebook";
import type { NbOutput } from "./types";

/** Adds one output the way a notebook shows it: consecutive text on the same stream joins into one block (folding progress-bar updates). */
export function mergeOutput(outputs: NbOutput[], out: NbOutput): NbOutput[] {
  const last = outputs[outputs.length - 1];
  if (out.output_type === "stream" && last?.output_type === "stream" && last.name === out.name) {
    return [...outputs.slice(0, -1), { ...last, text: applyCarriageReturns(textOf(last.text) + textOf(out.text)) }];
  }
  if (out.output_type === "stream") return [...outputs, { ...out, text: applyCarriageReturns(textOf(out.text)) }];
  return [...outputs, out];
}

/** Replaces a display_data output in place (IPython's `display(..., display_id=)` followed by `handle.update(...)`, tqdm, ...). `index` is its position in the cell's output list. */
export function replaceDisplay(outputs: NbOutput[], index: number, data: Record<string, unknown>, metadata: Record<string, unknown>): NbOutput[] {
  const o = outputs[index];
  if (!o || (o.output_type !== "display_data" && o.output_type !== "execute_result")) return outputs;
  return outputs.map((x, i) => (i === index ? { ...x, data, metadata } : x));
}
