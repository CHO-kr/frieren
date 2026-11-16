// pixel-spaces' own size (pure, tested by `node fit.test.mjs`). With exactly one space the SPACES block shrinks to what
// it shows (one slim row); with two or more it gets back the size it had before it shrank (its weight then, else the
// layout's 0.6). The same approach as pixel-quest's "fit": layout.resize on the block holding this mod.
// The block's `min` in the layout still holds: layout.resize never makes it smaller than that.

export const H = { header: 28, padTop: 4, padBottom: 6, gap: 2, slim: 34 };
export const FALLBACK_WEIGHT = 0.6;

// The block's height for its list: the header, the rows (px each) with the gaps between them, the paddings, the frame.
export function fitHeight(rows, chrome = 0, h = H) {
  const list = (rows ?? []).map((r) => Number(r) || 0);
  return Math.round(h.header + h.padTop + list.reduce((n, r) => n + r, 0) + Math.max(0, list.length - 1) * h.gap + h.padBottom + chrome);
}

// What to do now. node: the block's layout node ({ id, size: { px } | { weight } }); count: how many spaces; want: its
// px with one space; mem: { weight, asked } (kept by the mod: the weight to give back, the px it last asked for).
// -> { resize: layout.resize args | null, mem }
export function plan(node, count, want, mem) {
  const m = { weight: typeof mem?.weight === "number" ? mem.weight : null, asked: typeof mem?.asked === "number" ? mem.asked : null };
  if (!node?.id) return { resize: null, mem: m };
  const weight = typeof node.size?.weight === "number" ? node.size.weight : null;
  const px = typeof node.size?.px === "number" ? node.size.px : null;
  if (count === 1 && typeof want === "number" && want > 0) {
    // Sized by weight: the person's (or the layout's) size. Keep it to give back, then shrink.
    if (weight != null) return { resize: { id: node.id, px: want }, mem: { weight, asked: want } };
    // Already this size, or asked for it and then dragged by hand: leave it.
    if (px === want || m.asked === want) return { resize: null, mem: m };
    return { resize: { id: node.id, px: want }, mem: { ...m, asked: want } };
  }
  // Two or more: grow back, only from a size this mod set.
  if (count >= 2 && px != null && (m.weight != null || px === m.asked)) {
    return { resize: { id: node.id, weight: m.weight ?? FALLBACK_WEIGHT }, mem: { weight: null, asked: null } };
  }
  return { resize: null, mem: m };
}
