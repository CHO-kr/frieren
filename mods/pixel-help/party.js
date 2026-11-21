// Who a terminal is in the Frieren party: pure functions only (no herdr / gpui-kit calls).
// Copied from pixel-party/lib.js (ROSTER, character, facePath, isAgentPane, agentKey, alpha, mix), which pixel-party,
// pixel-tabs and pixel-pane each keep whole (a mod can't import outside its folder). Keep these in step with it.
// Character picks are shared("journey.party"): `tab:<tabId>` for a tab's first agent, `agent:<address>` for later ones.

export const ROSTER = [
  { id: "frieren", name: "Frieren", role: "Great Mage", color: "#7fe0b8", style: "bolt" },
  { id: "fern", name: "Fern", role: "Mage", color: "#c49bff", style: "bolt" },
  { id: "stark", name: "Stark", role: "Warrior", color: "#ff7a6b", style: "slash" },
  { id: "himmel", name: "Himmel", role: "Hero", color: "#86b4ff", style: "slash" },
  { id: "heiter", name: "Heiter", role: "Priest", color: "#aef0b6", style: "holy" },
  { id: "eisen", name: "Eisen", role: "Warrior", color: "#ffd36a", style: "slash" },
  { id: "sein", name: "Sein", role: "Priest", color: "#e0b48a", style: "holy" },
  { id: "ubel", name: "Ubel", role: "First-Class Mage", color: "#8fe39b", style: "slash" },
  { id: "land", name: "Land", role: "First-Class Mage", color: "#e6dca6", style: "bolt" },
  { id: "denken", name: "Denken", role: "First-Class Mage", color: "#e0b48a", style: "bolt" },
  { id: "methode", name: "Methode", role: "First-Class Mage", color: "#ffb0dc", style: "bolt" },
  { id: "flamme", name: "Flamme", role: "Great Mage", color: "#ffc25c", style: "bolt" },
  { id: "serie", name: "Serie", role: "Great Mage", color: "#ffe39a", style: "bolt" },
  { id: "kanne", name: "Kanne", role: "Mage", color: "#ffa070", style: "bolt" },
  { id: "lawine", name: "Lawine", role: "Mage", color: "#a8f2ff", style: "bolt" },
  { id: "wirbel", name: "Wirbel", role: "First-Class Mage", color: "#cbd5e8", style: "bolt" },
];
const BY_ID = new Map(ROSTER.map((c) => [c.id, c]));
export const character = (id) => BY_ID.get(id) ?? null;
export const facePath = (c) => (c ? `mods/pixel-party/faces/${c.id}.png` : null);

export const isAgentPane = (q) => /claude|codex/i.test(`${q?.app ?? ""} ${q?.program?.key ?? ""}`);

export function agentKey(a, agents) {
  const first = (agents ?? []).find((x) => x.tab === a.tab);
  return first && first.address !== a.address ? `agent:${a.address}` : `tab:${a.tab}`;
}

export const alpha = (c, a) => `${String(c ?? "#000000").slice(0, 7)}${a}`;
export function mix(a, b, k) {
  const ch = (c, i) => parseInt(String(c).slice(1 + i * 2, 3 + i * 2), 16) || 0;
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) * (1 - k) + ch(b, i) * k).toString(16).padStart(2, "0")).join("")}`;
}
