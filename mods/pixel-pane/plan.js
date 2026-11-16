// What the session header's scene shows (pure: no herdr / gpui-kit calls, so build/plan_test.mjs can run it in node).
// build/scene_preview.py draws the same rules.
import { familyOf, frames } from "./lib.js";
import { SCENE } from "./scene.js";

const MONSTERS = `FrierenDot${SCENE.version} Monsters`;
const PROPS = `FrierenDot${SCENE.version} Props`;
export const MAX_PARTY = SCENE.slots.length;
export const isNight = (d = new Date()) => d.getHours() >= 22 || d.getHours() < 7;

// party: [{ ch, st, anim, own }] -> { mode, monster, items: [{ key, family, cps | list, ms, x, w }] }, x and w in art
// pixels, in drawing order. While any member works: battle (the background's monster, or the golem for 3+); else if one
// is done: a treasure chest; else camp (by day a meal on the fire, by night asleep by the embers).
export function plan(members, sceneId, night) {
  const st = members.map((m) => m.st);
  const mode = st.includes("working") ? "battle" : st.includes("done") ? "victory" : "camp";
  const items = [];
  const prop = (n, x) => { const p = SCENE.props[n]; items.push({ key: n, family: PROPS, cps: p.cps, ms: p.ms, x, w: p.w }); };
  let monster = null;
  if (mode === "camp") {
    prop("signpost", SCENE.places.signpost);
    prop("backpack", SCENE.places.backpack);
    prop("tent", SCENE.places.tent);
    if (night) prop("bedroll", SCENE.places.bedroll);
    const fire = night ? "embers" : st.includes("idle") ? "cook" : "fire";
    prop(fire, SCENE.fireX - Math.floor(SCENE.props[fire].w / 2));
  } else {
    monster = members.length >= 3 ? SCENE.boss : SCENE.scenes[sceneId] ?? SCENE.scenes.night;
    if (mode === "battle") {
      const m = SCENE.monsters[monster];
      items.push({ key: "monster", family: MONSTERS, cps: members.some((x) => x.anim === "cast") ? m.battle : m.idle, ms: 90, x: SCENE.hit - 2, w: 40 });
    } else prop("treasure", SCENE.hit - 4);
  }
  const ownAt = members.findIndex((m) => m.own);
  if (members.length > 1 && ownAt >= 0) prop("ring", (mode === "camp" ? SCENE.camp[ownAt][0] : SCENE.slots[ownAt]) - 11);
  members.forEach((m, i) => {
    const fam = familyOf(m.ch);
    if (mode === "camp") {
      const [head, flip] = SCENE.camp[i];
      const a = (m.st === "blocked" ? "alert" : m.st === "idle" ? (night ? "rest" : "eat") : "stand") + (flip ? "_l" : "");
      const f = frames(a, false);
      items.push({ key: `m${i}`, family: fam, list: f.list, ms: f.ms, x: head - (flip ? SCENE.stageWidth - 1 - SCENE.sx : SCENE.sx), w: SCENE.stageWidth });
    } else {
      const a = m.st === "working" ? m.anim : m.st === "blocked" ? "alert" : m.st === "done" ? "victory" : "stand";
      if (a === "cast") items.push({ key: `m${i}`, family: fam, cps: SCENE.cast[i], ms: 90, x: 0, w: SCENE.width });
      else { const f = frames(a, false); items.push({ key: `m${i}`, family: fam, list: f.list, ms: f.ms, x: SCENE.slots[i] - SCENE.sx, w: SCENE.stageWidth }); }
    }
  });
  return { mode, monster, items };
}

export const glyphs = (it) => it.list ?? it.cps.map((c) => String.fromCodePoint(c));
