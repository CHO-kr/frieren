// Runs pixel-pane's plan() in node for preview cases and prints what the stage would draw, as JSON (glyph strings as
// code point lists), for stage_preview.py.
// usage: node stage_dump.mjs <pixel-pane dir> <cases.json> > plans.json
//   cases.json: [{ "scene": "night", "night": false, "W": 512, "pick": 0,
//                  "members": [["frieren", "working", "cast", true, 1, ["read", "cast"]], ...] }]
//   a member: [id, status, kind, focused, subagents, kinds done lately (its turns go through them; default [kind])]
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const { plan, STEP } = await import(pathToFileURL(`${dir}/plan.js`).href);
const { character } = await import(pathToFileURL(`${dir}/lib.js`).href);
const cases = JSON.parse(readFileSync(process.argv[3], "utf8").trim()); // trim: also a byte order mark
const cps = (s) => [...s].map((c) => c.codePointAt(0));
const out = cases.map((c) => {
  const members = c.members.map(([id, st, anim, own, summons, kinds], i) =>
    ({ ch: character(id), st, anim, own, key: `t${i}`, summons, kinds: kinds ?? [anim] }));
  const p = plan(members, c.scene, Boolean(c.night), c.W, c.pick ?? 0);
  return {
    ...c, step: STEP, mode: p.mode, activity: p.activity, monster: p.monster, L: p.L, log: p.log, title: p.title,
    turns: p.turns, boxes: p.items.length,
    items: p.items.map((it) => ({ family: it.family, x: it.x, y: it.y, w: it.w, ms: it.ms, frames: it.frames.map(cps) })),
  };
});
process.stdout.write(JSON.stringify(out));
