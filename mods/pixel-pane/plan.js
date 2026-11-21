// What the battle stage shows (pure: no herdr / gpui-kit calls, so build/stage_dump.mjs runs it in node and
// build/stage_preview.py draws exactly this).
//
// The stage is one strip of the background, W art pixels wide (2 screen pixels each), where the shown tab's party
// stands: one member per pane, up to 4, plus up to 2 allies a summoning member calls in (other characters).
//   battle   any member works: a long fight in three waves (the scene's monster, another one, then the Stone Golem as
//            the boss, who gets enraged halfway). Working members take turns; each turn plays one of the kinds of work
//            its agent did lately (lib.js classify, `kinds`), with a normal attack in between:
//              attack   fighters slash, slash twice, leap or dash in; mages fire a bolt, two bolts, a charged bolt or
//                       Zoltraak; priests throw holy orbs or rain holy light and heal
//              think    an attack, a pause to think it over, or gathering mana first
//              read     scans for a weak point, then strikes it      write    a rune circle erupts under the monster
//              search   tracks the monster's trail with a lens       plan     a map and arrows: the next strike crits
//              test     a combo of quick hits                        build    forges a blade at an anvil, drops it on it
//              git      plants the banner, the whole party charges   install  drinks a potion: attack up
//              delete   a meteor storm                               wait     stands guard with an hourglass, counters
//              fly      an aerial dive (the web)                     media    conjures illusions of itself, three strike
//              summon   a sub-agent: a summoning circle, an ally (another character) joins the fight
//            Every turn fills the member's SP gauge; a full gauge (and the last blow of every wave) is its special
//            move (필살기): the stage dims, the move's name unfurls on a banner and the character's own finisher plays
//            (Frieren's Zoltraak at full power, Stark's Sky Splitter, Himmel's Hero's Flash, …). Every two turns the
//            monster strikes back: a shot, a charge, or a blast at the whole party; members block, dodge or are hurt
//            (and healed by a priest). A member waiting for the person calls HELP!.
//   victory  one is done and none works: a treasure chest, a rare grimoire, or a mimic.
//   camp     otherwise, a pastime that changes every 20 minutes: a meal by the fire, a walk in a field of flowers,
//            training on straw dummies, studying grimoires, fishing (by water); at night (22:00-07:00) asleep by the
//            embers or watching shooting stars.
// Every element is an absolutely placed glyph box whose frames run on the one clock all views share, STEP ms each, so
// a beam reaches the monster on the step the monster flinches. Moving is done by boxes at each spot, blank (" ") when
// nobody is there.
import { familyOf, frames, ROSTER } from "./lib.js";
import { STAGE } from "./stage.js";

export const STEP = 90;
export const MAX_PARTY = 4;
export const SLOT_MS = 20 * 60 * 1000; // the camp's pastime and the victory scene change this often
const MAX_ALLIES = 2;
const SP_MAX = 4;
const BLANK = " ";
const Y0 = STAGE.spriteTop;
const FAMILY = {
  monsters: `FrierenDot${STAGE.version} Monsters`,
  fx: `FrierenDot${STAGE.version} Fx`,
  props: `FrierenDot${STAGE.version} Props`,
  special: `FrierenDot${STAGE.version} Special`,
};
const MELEE = { stark: "axe", eisen: "axe", himmel: "sword" }; // they run up and strike; the rest fight from afar
const FOES = Object.keys(STAGE.monsters).filter((k) => k !== STAGE.boss);
export const isNight = (d = new Date()) => d.getHours() >= 22 || d.getHours() < 7;
export const glyphs = (it) => it.frames;

const S = (cp) => String.fromCodePoint(cp);
const B = (key, i = 0) => S(STAGE.battle[key].cps[i % STAGE.battle[key].cps.length]);
const FX = (key, i = 0) => S(STAGE.fx[key].cps[Math.min(i, STAGE.fx[key].cps.length - 1)]);
const ANIM = new Map(); // name -> frames(name): the same every time
const animAt = (name, t) => {
  let f = ANIM.get(name);
  if (!f) ANIM.set(name, (f = frames(name, false)));
  return f.list[Math.floor((t * STEP) / f.ms) % f.list.length];
};
const number = (n, color, rise) => String(n).split("").map((d) => S(STAGE.fx.num[color][rise][d === "+" ? 10 : Number(d)])).join("");
export const hash = (s) => [...String(s)].reduce((h, c) => (Math.imul(h, 31) + c.codePointAt(0)) >>> 0, 7);
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Something drawn over time: at step t it is at (x, y) showing glyph g, or absent. `ambient(t)` fills the steps a turn
// didn't set (a member standing ready at home).
class Actor {
  constructor(family, w, ambient = null) {
    this.family = family;
    this.w = w;
    this.ambient = ambient;
    this.at = new Map();
  }
  set(t, x, y, g) { this.at.set(t, g == null ? null : [Math.round(x), Math.round(y), g]); }
  play(t, x, y, list) { list.forEach((g, i) => this.set(t + i, x, y, g)); }
}

// actors -> boxes: one per (font, place, width), its frames blank where nobody is. Only an actor with an ambient
// pose is walked step by step; the rest (hundreds of short effects) only where they were set: the app's script
// engine is far slower than node, and a render that runs too long is cut off.
function boxes(actors, L) {
  const out = new Map();
  let last = null; // the box the previous step went to: an actor mostly stays put
  const put = (a, t, s) => {
    const [x, y, g] = s;
    if (last && last.a === a && last.x === x && last.y === y) {
      last.b.frames[t] = g;
      return;
    }
    const key = `${a.family}|${x}|${y}|${a.w}`;
    let b = out.get(key);
    if (!b) {
      b = { key, family: a.family, x, y, w: a.w, frames: Array(L).fill(BLANK), ms: STEP };
      out.set(key, b);
    }
    b.frames[t] = g;
    last = { a, x, y, b };
  };
  for (const a of actors) {
    if (a.ambient) {
      for (let t = 0; t < L; t++) {
        const s = a.at.has(t) ? a.at.get(t) : a.ambient(t);
        if (s) put(a, t, s);
      }
    } else {
      for (const [t, s] of a.at) if (s && t >= 0 && t < L) put(a, t, s);
    }
  }
  return [...out.values()];
}

// Allies a summoning member calls in: characters not in the party, the same ones for the same member.
function alliesFor(members) {
  const taken = new Set(members.map((m) => m.ch.id));
  const out = [];
  for (const m of members) {
    if (m.st !== "working" || !(m.kinds ?? [m.anim]).includes("summon")) continue;
    const n = Math.max(1, Math.min(MAX_ALLIES - out.length, m.summons ?? 1));
    const pool = ROSTER.filter((c) => !taken.has(c.id));
    let i = hash(m.key ?? m.ch.id) % Math.max(1, pool.length);
    for (let k = 0; k < n && pool.length; k++) {
      const c = pool.splice(i % pool.length, 1)[0];
      taken.add(c.id);
      out.push({ ch: c, by: m });
      i += 7;
    }
    if (out.length >= MAX_ALLIES) break;
  }
  return out;
}

// what a member does turn by turn: its recent kinds of work, a normal attack after each
function rotation(kinds) {
  const out = [];
  for (const k of kinds.length ? kinds : ["think"]) {
    if (k === "cast" || k === "attack") out.push("attack");
    else if (k === "think") out.push("think");
    else out.push(k, "attack");
  }
  return out.filter((k, i) => !(k === "attack" && out[i - 1] === "attack"));
}

// ---------------------------------------------------------------- battle
function battle(members, sceneId, W, seed) {
  const rand = rng(seed);
  const SPX = STAGE.sp;
  const first = STAGE.scenes[sceneId] ?? STAGE.scenes.night;
  const others = FOES.filter((k) => k !== first);
  const waves = [
    { key: first, label: "WAVE 1" },
    { key: others[Math.floor(rand() * others.length)], label: "WAVE 2" },
    { key: STAGE.boss, label: "BOSS", boss: true },
  ];
  const gx = W - 70; // the monster glyph's left edge
  let M, foe, front, centre, monTop, monMid, numRow, meleeHead, wave = 0;
  const useMonster = (key) => {
    M = STAGE.monsters[key];
    foe = M.name;
    front = gx + M.x0 + 2; // where hits land
    centre = gx + M.x0 + Math.round(M.w / 2);
    monTop = Y0 + M.top;
    monMid = Y0 + M.mid;
    numRow = Math.max(9, monTop + 5); // damage numbers start here (under the HP bar) and rise
    meleeHead = front - 13;
  };
  useMonster(first);
  const allies = alliesFor(members);
  const count = members.length + allies.length;
  const start = Math.max(24, Math.min(64, Math.round(W * 0.08)));
  const gap = Math.max(16, Math.min(34, Math.floor((meleeHead - 44 - start) / Math.max(1, count - 1))));
  const log = [], titles = [], turnLog = []; // turnLog: [step, member, kind or "special"] (for previews)
  const say = (t, text) => log.push([t, text]);
  const hits = [];
  const bodies = [], fxs = [];

  const makeBody = (ch, head, extra) => {
    const b = {
      ch, head, x: head - STAGE.sx, fam: familyOf(ch), tip: STAGE.chars[ch.id]?.tip ?? [14, 18],
      style: STAGE.chars[ch.id]?.style ?? ch.style, fighter: Boolean(MELEE[ch.id]), ...extra,
    };
    const idle = b.st === "blocked" ? "alert" : b.st === "done" ? "victory" : "stand";
    b.actor = new Actor(b.fam, STAGE.stageWidth, (t) => (b.present && !b.present(t) ? null : [b.x, Y0, animAt(idle, t)]));
    bodies.push(b.actor);
    return b;
  };
  // wounds / streak / hit / tests: what the member's agent really did lately (pixel-chronicle), see plan() below
  const party = members.map((m, i) => makeBody(m.ch, start + i * gap,
    { st: m.st, anim: m.anim, own: m.own, key: m.key, kinds: m.kinds ?? [m.anim], wounds: m.wounds ?? 0, streak: m.streak ?? 0,
      hit: m.hit ?? null, tests: m.tests ?? null }));
  const allyBodies = allies.map((a, i) => makeBody(a.ch, start + (members.length + i) * gap,
    { st: "working", anim: "think", ally: true, by: party[members.indexOf(a.by)], stays: [] }));
  allyBodies.forEach((b) => { b.present = (t) => b.stays.some(([a, z]) => t >= a && t < z); });
  const here = (o, t) => !o.present || o.present(t);

  // ----- the monster: what turns set (place and glyph), else its idle bob while alive
  const monAt = new Map();
  const monSet = (t, g, x = gx) => monAt.set(t, [x, g]);
  const flinch = (t) => { monSet(t, S(M.hurt[0])); monSet(t + 1, S(M.hurt[1])); };

  // ----- drawing helpers
  const fx = (w, family = FAMILY.fx) => { const a = new Actor(family, w); fxs.push(a); return a; };
  const own = (b, key) => fx(STAGE.battle[key].w, b.fam); // an effect in b's own colors
  const fxPlay = (t, key, x, y, seq) => {
    const a = fx(STAGE.fx[key].w);
    seq.forEach((f, i) => a.set(t + i, x, y, f == null ? null : FX(key, f)));
    return a;
  };
  const sp = (b, key) => SPX.chars[b.ch.id]?.[key];
  const spPlay = (t, g, x, y, seq) => {
    const a = fx(g.w, FAMILY.special);
    seq.forEach((f, i) => a.set(t + i, x, y, f == null ? null : S(g.cps[Math.min(f, g.cps.length - 1)])));
    return a;
  };
  const num = (t, n, color, x, rowTop, rises = [0, 1, 2, 3, 3, 3]) => {
    const s = String(n);
    const a = fx(Math.max(3, s.length) * STAGE.fx.numAdvance + 2); // one width for all, so numbers share boxes
    rises.forEach((r, i) => a.set(t + i, x, rowTop - STAGE.fx.numTop, number(s, color, r)));
  };
  const word = (t, wd, x, rowTop, rises = [0, 0, 1, 1, 1, 1]) => {
    const a = fx(STAGE.fx.word[wd].w);
    rises.forEach((r, i) => a.set(t + i, x, rowTop - STAGE.fx.numTop, S(STAGE.fx.word[wd].cps[r])));
  };
  const banner = (t, wd, n = 14) => {
    const g = SPX.title[wd];
    const seq = Array.from({ length: n }, (_, i) => (i === 3 || i === 4 ? 1 : 0));
    spPlay(t, g, Math.round(W / 2 - g.w / 2), 0, seq);
  };
  const overHead = () => Y0 + 1; // a word over a member
  const pose = (b, t, list, x = b.x, y = Y0) => b.actor.play(t, x, y, list);
  const hold = (b, t, n, g, x = b.x, y = Y0) => pose(b, t, Array(n).fill(g), x, y);
  const anim = (b, t, name, n, from = 0) => pose(b, t, Array.from({ length: n }, (_, i) => animAt(name, from + i)));
  // a beam of n 16-pixel segments in one box (the glyphs advance by their width): from step `from` it grows over
  // `grow` steps, segment k showing from from + floor(k * grow / n), until `to`
  const beamRow = (a, from, to, x, y, n, grow, glyph) => {
    for (let s = from; s < to; s++) {
      let k = 0;
      while (k < n && from + Math.floor((k * grow) / n) <= s) k++;
      a.set(s, x, y, glyph(s).repeat(k));
    }
  };
  const toMid = (b) => monMid - b.tip[1]; // an effect at b's tip row, moved to the monster's middle
  const tipX = (b) => b.head + b.tip[0];
  const tipY = (b) => Y0 + b.tip[1] - 16; // where a 32-row effect centred on row 16 sits to be at b's tip
  const projKey = (b) => (b.style === "bolt" ? "head" : b.style === "slash" ? "wave" : "orb");
  const charge = (b, t) => pose(b, t, frames("cast", false).list.slice(1, 4));
  const burstAt = (b, t) => own(b, "burst").play(t, front - 10, toMid(b), [B("burst", 0), B("burst", 1), B("burst", 2)]);
  const impactAt = (b, t, dx = 0, dy = 0) => spPlay(t, sp(b, "impact"), centre - 24 + dx, monMid - 16 + dy, [0, 1, 2]);

  // the dimmed stage while a special plays, flashing white as its big hits land
  const tiles = Math.ceil(W / 64);
  const shade = new Actor(FAMILY.special, W), shadeTop = new Actor(FAMILY.special, W);
  const shadeStr = (key, f) => S(SPX[key].cps[f]).repeat(tiles);
  const dim = (t, n, flashes = []) => {
    for (let s = t; s < t + n; s++) {
      const f = flashes.includes(s) ? 1 : 0;
      shade.set(s, 0, Y0, shadeStr("shade", f));
      shadeTop.set(s, 0, 0, shadeStr("shadeTop", f));
    }
  };

  // a hit lands on the monster at step t
  let weak = false, jitter = 0;
  const strikeMon = (t, { crit = false, big = false, small = false, special = false } = {}) => {
    const isCrit = crit || weak;
    weak = false;
    const n = special ? 120 + Math.floor(rand() * 140)
      : isCrit ? 50 + Math.floor(rand() * 49) : big ? 38 + Math.floor(rand() * 40) : small ? 6 + Math.floor(rand() * 14) : 9 + Math.floor(rand() * 30);
    hits.push([t, n, wave]);
    flinch(t);
    const x = centre - 6 + [0, -12, 12, -24][jitter++ % 4];
    num(t, n, isCrit || special ? "crit" : "dmg", x, numRow);
    if (isCrit && !special) word(t, "CRIT!", x - 22, numRow, [0, 0, 1, 1, 1]);
    return n;
  };
  // b's projectile flies from x0 to the monster over n steps from t; returns the step it lands
  const shoot = (b, t, n, x0 = tipX(b), dy = 0, burst = true) => {
    const key = projKey(b);
    const p = own(b, key);
    for (let s = 0; s < n; s++) p.set(t + s, x0 + ((front - 8 - x0) * (s + 1)) / (n + 1), Y0 + dy, B(key, s));
    const at = t + n;
    if (burst) own(b, "burst").play(at, front - 10, toMid(b) + dy, [B("burst", 0), B("burst", 1), B("burst", 2)]);
    return at;
  };
  const weapon = (b) => MELEE[b.ch.id] ?? "blade";
  const shotName = (b) => (b.style === "holy" ? "holy orb" : b.style === "slash" ? "blade of wind" : "bolt");

  // ----- normal attacks and skills: each draws from step t and returns its length in steps
  const T = {};
  T.quick = (b, t, silent = false, off = 0) => {
    if (b.fighter) return T.melee(b, t, 1, { silent, off });
    hold(b, t, 5, B("attack"));
    const at = shoot(b, t + 1, 3);
    const n = strikeMon(at);
    if (!silent) say(at, `${b.ch.name} attacks: a ${shotName(b)}! ${n}`);
    return at - t + 2;
  };
  T.double = (b, t) => {
    hold(b, t, 8, B("attack"));
    const a1 = shoot(b, t + 1, 3, tipX(b), -2);
    const a2 = shoot(b, t + 3, 3, tipX(b), 2);
    const d = [strikeMon(a1), strikeMon(a2)];
    say(a1, `${b.ch.name} attacks: two ${shotName(b)}s! ${d.join(" · ")}`);
    return a2 - t + 2;
  };
  T.charged = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 6, B("attack"));
    spPlay(t, sp(b, "circle"), tipX(b) - 4, tipY(b), [0, 1, 2, 2, 2, 2]);
    const at = shoot(b, t + 4, 3);
    own(b, "burst").play(at + 1, front - 6, toMid(b) - 3, [B("burst", 0), B("burst", 2)]);
    const n = strikeMon(at, { big: true });
    say(t + 1, `${b.ch.name} charges up…`);
    say(at, `${b.ch.name} attacks: a charged ${shotName(b)}! ${n}`);
    return at - t + 3;
  };
  T.beam = (b, t) => {
    charge(b, t);
    const x0 = tipX(b), from = t + 3, grow = 4;
    hold(b, from, grow + 3, B("attack"));
    let at;
    if (b.style === "bolt") {
      const n = Math.max(1, Math.ceil((front - x0) / 16));
      beamRow(fx(n * 16, b.fam), from, from + grow + 2, x0, Y0, n, grow, (s) => B("beam", s));
      at = from + grow;
      burstAt(b, at);
    } else at = shoot(b, from, grow, x0);
    const n = strikeMon(at);
    say(at, `${b.ch.name} attacks: ${b.style === "slash" ? "a blade of magic" : b.style === "holy" ? "holy light" : "Zoltraak"}! ${n}`);
    return at - t + 3;
  };
  T.holy = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 9, B("attack"));
    let total = 0;
    for (let k = 0; k < 3; k++) {
      const orb = own(b, "orb");
      const x = front - 4 + (k - 1) * 7;
      const t0 = t + 3 + k * 2;
      [-14, -9, -4].forEach((dy, i) => orb.set(t0 + i, x, toMid(b) + dy, B("orb", i)));
      own(b, "burst").play(t0 + 3, x - 6, toMid(b), [B("burst", 0), B("burst", 2)]);
      total += strikeMon(t0 + 3, { small: true });
    }
    say(t + 9, `${b.ch.name} attacks: holy rain! ${total}`);
    const t1 = t + 11;
    for (const o of [...party, ...allyBodies]) if (here(o, t1)) fxPlay(t1, "heal", o.head - 12, Y0 + 2, [0, 1, 2]);
    const n = 6 + Math.floor(rand() * 10);
    num(t1, `+${n}`, "heal", b.head - 6, Y0 + 2, [0, 1, 2, 2]);
    say(t1, `${b.ch.name} heals the party +${n}`);
    return 15;
  };
  // run up, strike (a combo when fast), leap back
  T.melee = (b, t, swings, { fast = false, silent = false, off = 0, label = null } = {}) => {
    const dist = meleeHead - off - b.head;
    const n = Math.max(3, Math.min(8, Math.round(dist / 26)));
    for (let k = 1; k <= n; k++) b.actor.set(t + k - 1, b.x + (dist * k) / n, Y0, B("run", k));
    let s = t + n;
    const mx = meleeHead - off - STAGE.sx;
    const dmg = [];
    for (let k = 0; k < swings; k++) {
      const seq = fast ? [B("swing", 1), B("swing", 2)] : [B("swing", 0), B("swing", 1), B("swing", 2)];
      pose(b, s, seq, mx);
      const at = s + (fast ? 0 : 1);
      own(b, "arc").play(at, centre - 16, monMid - 18, [B("arc", 0), B("arc", 1)]);
      dmg.push(strikeMon(at, { crit: !fast && swings > 1 && k === swings - 1 && rand() < 0.5, small: fast }));
      s += seq.length;
    }
    if (fast) word(s - 2, "COMBO!", meleeHead - off - 14, Y0 + 1, [0, 0, 1, 1]);
    if (!silent) {
      say(t + n + 1, fast ? `${b.ch.name} unleashes a ${swings}-hit combo! ${dmg.join(" · ")}`
        : `${b.ch.name} attacks: ${label ?? (swings > 1 ? `${swings} swings of the ${weapon(b)}` : `a swing of the ${weapon(b)}`)}! ${dmg.join(" · ")}`);
    }
    [[-6, 0.66], [-8, 0.33], [-3, 0]].forEach(([dy, k], i) => b.actor.set(s + i, b.x + dist * k, Y0 + dy + 6, B("jump")));
    return s + 3 - t;
  };
  // a fighter's leaping strike: half the way on foot, then up and down onto the monster
  T.leap = (b, t) => {
    const dist = meleeHead - b.head;
    const half = Math.round(dist * 0.5);
    const n = Math.max(2, Math.min(5, Math.round(half / 26)));
    for (let k = 1; k <= n; k++) b.actor.set(t + k - 1, b.x + (half * k) / n, Y0, B("run", k));
    const mx = meleeHead - STAGE.sx;
    [[0.65, -6], [0.85, -8], [1, -6]].forEach(([k, dy], i) => b.actor.set(t + n + i, b.x + half + (dist - half) * (k - 0.5) * 2, Y0 + dy, B(i < 2 ? "jump" : "swing", 0)));
    const s = t + n + 3;
    pose(b, s, [B("swing", 1), B("swing", 2)], mx, Y0 - 2);
    own(b, "arc").play(s, centre - 16, monMid - 16, [B("arc", 0), B("arc", 1)]);
    spPlay(s + 1, SPX.shock, centre - 32, Y0, [0, 1, 2]);
    const d = strikeMon(s, { crit: rand() < 0.5 });
    say(s, `${b.ch.name} attacks: a leaping strike! ${d}`);
    [[-6, 0.66], [-8, 0.33], [-3, 0]].forEach(([dy, k], i) => b.actor.set(s + 2 + i, b.x + dist * k, Y0 + dy + 6, B("jump")));
    return s + 5 - t;
  };
  T.dash = (b, t) => {
    const dist = meleeHead - b.head;
    for (let k = 1; k <= 3; k++) b.actor.set(t + k - 1, b.x + (dist * k) / 3, Y0, B("run", k));
    const mx = meleeHead - STAGE.sx;
    pose(b, t + 3, [B("swing", 1), B("swing", 2), B("swing", 2)], mx);
    own(b, "arc").play(t + 3, centre - 16, monMid - 18, [B("arc", 0), B("arc", 1)]);
    const d = strikeMon(t + 3);
    say(t + 3, `${b.ch.name} attacks: a dashing ${weapon(b) === "axe" ? "axe blow" : "thrust"}! ${d}`);
    [[-6, 0.66], [-8, 0.33], [-3, 0]].forEach(([dy, k], i) => b.actor.set(t + 6 + i, b.x + dist * k, Y0 + dy + 6, B("jump")));
    return 9;
  };
  // a normal attack: each member goes through its own four
  const normalNo = new Map();
  T.attack = (b, t) => {
    const v = (normalNo.get(b) ?? hash(b.ch.id) % 4);
    normalNo.set(b, v + 1);
    const k = v % 4;
    if (b.fighter) return [() => T.melee(b, t, 1), () => T.melee(b, t, 2), () => T.leap(b, t), () => T.dash(b, t)][k]();
    if (b.style === "holy") return [() => T.quick(b, t), () => T.holy(b, t), () => T.double(b, t), () => T.charged(b, t)][k]();
    return [() => T.quick(b, t), () => T.double(b, t), () => T.charged(b, t), () => T.beam(b, t)][k]();
  };
  T.cast = (b, t) => T.attack(b, t);
  // test: a combo of quick hits (a volley from afar)
  T.combo = (b, t) => {
    if (b.fighter) return T.melee(b, t, 4, { fast: true });
    const shots = 5;
    pose(b, t, frames("cast", false).list.slice(1, 3));
    hold(b, t + 2, shots * 2 + 3, B("attack"));
    const dmg = [];
    for (let k = 0; k < shots; k++) dmg.push(strikeMon(shoot(b, t + 2 + k * 2, 3), { small: true }));
    const end = t + 2 + (shots - 1) * 2 + 3;
    word(end, "COMBO!", b.head - 12, overHead(b), [0, 0, 1, 1]);
    say(t + 5, `${b.ch.name} fires a ${shots}-shot volley! ${dmg.join(" · ")}`);
    return end - t + 3;
  };
  // build: hammers a blade at an anvil, it flies over and falls on the monster
  T.forge = (b, t) => {
    const ax = b.head + 10;
    const anv = fx(STAGE.fx.anvil.w);
    [0, 1, 2, 1, 2, 1, 2, 0, 0, 0, 0].forEach((f, i) => anv.set(t + i, ax, Y0, FX("anvil", f)));
    pose(b, t, [B("swing", 0), B("swing", 1), B("swing", 0), B("swing", 1), B("swing", 0), B("swing", 1), B("attack"), B("attack")]);
    word(t + 6, "FORGED!", b.head - 14, overHead(b), [0, 0, 1, 1]);
    const bl = fx(STAGE.fx.blade.w);
    const bx0 = ax + 7, tx = centre - 6;
    const path = [[bx0, Y0 - 6], [bx0, Y0 - 10]];
    for (let k = 1; k <= 4; k++) path.push([bx0 + ((tx - bx0) * k) / 4, Y0 - 12]);
    path.push([tx, Y0 - 8], [tx, Y0 - 3]);
    path.forEach(([x, y], i) => bl.set(t + 7 + i, x, y, FX("blade", i % 2)));
    const at = t + 7 + path.length - 1;
    bl.set(at + 1, tx, Y0 - 3, FX("blade", 1));
    fxPlay(at, "pillar", centre - 10, Y0, [1, 2]);
    const n = strikeMon(at, { crit: true });
    say(t + 1, `${b.ch.name} forges a blade at the anvil`);
    say(at, `The forged blade falls on the ${foe}! ${n}`);
    return at - t + 3;
  };
  // git: plants the banner, everyone charges together
  T.rally = (b, t) => {
    const bx = b.head + 6;
    fxPlay(t, "poof", bx - 14, Y0 - 4, [0, 1]);
    hold(b, t, 4, B("attack"));
    word(t + 1, "RALLY!", bx - 8, Y0 + 1, [0, 0, 1, 1, 1]);
    const crew = [...party, ...allyBodies].filter((o) => o.st !== "blocked" && here(o, t));
    crew.forEach((o) => fxPlay(t + 2, "aura", o.head - 14, Y0, [0, 1, 2, 0, 1]));
    say(t + 1, `${b.ch.name} raises the banner! The party charges together`);
    let end = t + 7;
    crew.forEach((o, i) => { end = Math.max(end, t + 7 + i + T.quick(o, t + 7 + i, true, i * 7)); });
    const fl = fx(STAGE.fx.banner.w);
    for (let s = t; s < end; s++) fl.set(s, bx, Y0, FX("banner", Math.floor(s / 3) % 2));
    return end - t + 1;
  };
  // install: drinks a potion, attack up, a critical strike
  T.supply = (b, t) => {
    const px = b.head - 4;
    fxPlay(t, "poof", px - 12, Y0 - 8, [0, 1]);
    const p = fx(STAGE.fx.potion.w);
    [[Y0 - 8, 0], [Y0 - 9, 1], [Y0 - 9, 0], [Y0 - 8, 1], [Y0 - 3, 0]].forEach(([y, f], i) => p.set(t + i, px, y, FX("potion", f)));
    fxPlay(t + 5, "aura", b.head - 14, Y0, [0, 1, 2, 0]);
    word(t + 5, "ATK UP", b.head - 12, overHead(b), [0, 0, 1, 1]);
    say(t + 1, `${b.ch.name} restocks and drinks a potion. Attack up!`);
    weak = true;
    return 9 + T.quick(b, t + 9);
  };
  // delete: a meteor storm
  T.meteor = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 13, B("attack"));
    const dmg = [];
    [centre - 8, centre + 4, centre - 2].forEach((ix, k) => {
      const t0 = t + 3 + k * 3, iy = Y0 + 26;
      const m = fx(STAGE.fx.meteor.w);
      for (let s = 0; s < 4; s++) m.set(t0 + s, ix - 15 - 30 * (1 - s / 3), iy - 24 - 30 * (1 - s / 3), FX("meteor", s));
      fxPlay(t0 + 4, "blast", ix - 22, Y0, [0, 1, 2]);
      dmg.push(strikeMon(t0 + 4, { big: true }));
    });
    const end = t + 3 + 6 + 4;
    word(end + 1, "BOOM!", centre - 10, overHead(b), [0, 0, 1, 1]);
    say(t + 2, `${b.ch.name} calls down a meteor storm!`);
    say(end, `Meteors crash into the ${foe}! ${dmg.join(" · ")}`);
    return end - t + 4;
  };
  // search: follows the trail with a lens, finds the weak spot, strikes it
  T.track = (b, t) => {
    const bub = fx(STAGE.fx.bubble.w);
    for (let i = 0; i < 3; i++) bub.set(t + i, b.head + 4, Y0 - 4, FX("bubble", 0));
    const x0 = b.head + 14, x1 = centre - 7, n = 7;
    anim(b, t, "read", n + 3);
    const lens = fx(STAGE.fx.lens.w);
    for (let k = 0; k < n; k++) {
      const x = x0 + ((x1 - x0) * k) / (n - 1);
      lens.set(t + 3 + k, x, Y0 + 6 - (k % 2), FX("lens", k % 2));
      const pr = fx(STAGE.fx.prints.w);
      for (let s = t + 3 + k; s < t + n + 7; s++) pr.set(s, x + 2, Y0, FX("prints"));
    }
    const at = t + 3 + n;
    for (let i = 0; i < 3; i++) bub.set(at + i, b.head + 4, Y0 - 4, FX("bubble", 1));
    word(at, "FOUND!", centre - 14, numRow, [0, 0, 1, 1]);
    say(t + 1, `${b.ch.name} tracks the ${foe}'s trail…`);
    say(at, "Found its weak spot!");
    weak = true;
    return n + 6 + T.quick(b, at + 3);
  };
  // plan: a map and arrows on the ground; the next strike crits
  T.tactics = (b, t, solo) => {
    const mp = fx(STAGE.fx.map.w);
    [0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2].forEach((f, i) => mp.set(t + i, b.head + 2, Y0 - 3, FX("map", f)));
    anim(b, t, "read", 11);
    const a0 = b.head + 34, gapA = Math.max(28, Math.floor((front - 30 - a0) / 2));
    for (let k = 0; k < 3; k++) {
      const x = a0 + k * gapA;
      if (x + 26 > front - 2) break;
      const a = fx(STAGE.fx.arrow.w);
      for (let s = t + 3 + k; s < t + 12; s++) a.set(s, x, Y0, FX("arrow", (s - k) % 2));
    }
    word(t + 4, "TACTICS", a0, Y0 + 16, [0, 0, 1, 1, 1, 1]);
    say(t + 2, `${b.ch.name} studies the map and plans the attack`);
    say(t + 4, "Tactics! The next strike will crit");
    weak = true;
    return 12 + (solo ? T.quick(b, t + 12) : 0);
  };
  // wait: stands guard with an hourglass, blocks the monster, counters
  T.guard = (b, t) => {
    const len = strike(b, t + 1, "block");
    const end = t + 1 + len;
    for (let s = t; s <= end; s++) if (!b.actor.at.has(s)) b.actor.set(s, b.x, Y0, B("guard", s % 2));
    const hg = fx(STAGE.fx.hourglass.w);
    for (let s = t; s <= end; s++) hg.set(s, b.head + 6, Y0 - 3, FX("hourglass", Math.floor((s - t) / 3) % 3));
    word(end, "COUNTER", b.head - 14, overHead(b), [0, 0, 1, 1]);
    say(t, `${b.ch.name} stands guard and waits…`);
    return end - t + 1 + T.quick(b, end + 1);
  };
  // media: illusions of itself; all three strike
  T.illusion = (b, t) => {
    const spots = [[b.x - 12, -2], [b.x + 14, 0]];
    spots.forEach(([x], i) => fxPlay(t + i, "poof", x + STAGE.sx - 16, Y0 - 4, [0, 1]));
    charge(b, t);
    hold(b, t + 3, 8, B("attack"));
    spots.forEach(([x, dy], i) => {
      const a = fx(STAGE.stageWidth, b.fam);
      for (let s = t + 1 + i; s < t + 11; s++) a.set(s, x, Y0 + dy, (s + i) % 3 === 2 ? null : B("attack"));
    });
    const dmg = [[b.x, 0], ...spots].map(([x, dy]) => strikeMon(shoot(b, t + 4, 3, x + STAGE.sx + b.tip[0], dy)));
    spots.forEach(([x]) => fxPlay(t + 11, "poof", x + STAGE.sx - 16, Y0 - 4, [0, 1]));
    say(t + 1, `${b.ch.name} conjures illusions of ${b.ch.name}!`);
    say(t + 8, `Three ${b.ch.name}s strike at once! ${dmg.join(" · ")}`);
    return 13;
  };
  // read: scans for the weak point, then strikes it
  T.scan = (b, t) => {
    anim(b, t, "read", 10);
    fxPlay(t + 2, "scan", centre - 14, monMid - 16, [0, 1, 0, 1, 0, 1]);
    word(t + 5, "WEAK!", centre - 12, numRow, [0, 0, 1, 1]);
    say(t + 5, `${b.ch.name} reads the ${foe}'s weak point!`);
    weak = true;
    return 10 + T.quick(b, t + 10);
  };
  // write: a rune circle erupts under the monster
  T.runes = (b, t) => {
    anim(b, t, "write", 10);
    fxPlay(t + 2, "runes", centre - 22, Y0, [0, 1, 2, 2, 1, 2]);
    fxPlay(t + 8, "pillar", centre - 10, Y0, [0, 1, 1, 2]);
    const n = strikeMon(t + 8, { crit: true });
    say(t + 8, `${b.ch.name}'s rune circle erupts! ${n}`);
    return 11;
  };
  // fly (the web): an aerial dive
  T.dive = (b, t) => {
    [-2, -4, -7].forEach((dy, i) => b.actor.set(t + i, b.x, Y0 + dy, animAt("fly", i)));
    const dist = meleeHead - b.head;
    for (let k = 1; k <= 4; k++) b.actor.set(t + 2 + k, b.x + (dist * k) / 4, Y0 - 9, animAt("fly", k));
    const mx = meleeHead - STAGE.sx;
    b.actor.set(t + 7, mx, Y0 - 5, B("attack"));
    pose(b, t + 8, [B("swing", 1), B("swing", 2)], mx);
    own(b, "arc").play(t + 8, centre - 16, monMid - 18, [B("arc", 0), B("arc", 1)]);
    const n = strikeMon(t + 8, { crit: true });
    say(t + 8, `${b.ch.name} dives from the sky! ${n}`);
    for (let k = 1; k <= 3; k++) b.actor.set(t + 9 + k, b.x + dist * (1 - k / 3), Y0 - 6 + k * 2, animAt("fly", k));
    return 13;
  };
  // summon: a circle, allies appear (once a wave) and attack
  T.summon = (b, t) => {
    const mine = allyBodies.filter((a) => a.by === b);
    const fresh = mine.filter((a) => !here(a, t));
    pose(b, t, [...frames("cast", false).list.slice(1, 4), B("attack"), B("attack"), B("attack")]);
    fresh.forEach((a, i) => {
      fxPlay(t + 1 + i, "circle", a.head - 18, Y0, [0, 1, 2, 3, 3]);
      fxPlay(t + 5 + i, "poof", a.head - 16, Y0 - 4, [0, 1]);
      a.stays.push([t + 5 + i, Infinity]);
    });
    say(t + 5, fresh.length ? `${b.ch.name} summons ${fresh.map((a) => a.ch.name).join(" and ")}!` : `${b.ch.name} commands the summoned allies!`);
    let len = 7;
    for (const a of mine) len += T.quick(a, t + len) + 1;
    return len;
  };
  // think: an attack, a pause to think it over, or gathering mana first
  let thinkNo = 0;
  T.think = (b, t) => {
    const v = (thinkNo++ + (seed % 3)) % 3;
    if (v === 0) return T.attack(b, t);
    if (v === 1) {
      const bub = fx(STAGE.fx.bubble.w);
      for (let i = 0; i < 5; i++) bub.set(t + i, b.head + 4, Y0 - 4, FX("bubble", 2));
      say(t, `${b.ch.name} thinks it over…`);
      return 5 + T.attack(b, t + 5);
    }
    fxPlay(t, "aura", b.head - 14, Y0, [0, 1, 2, 0]);
    hold(b, t, 4, B("attack"));
    say(t, `${b.ch.name} gathers mana…`);
    weak = true;
    return 4 + T.attack(b, t + 4);
  };

  // ----- specials (필살기): each character's own finisher, with the stage dimmed and its name on a banner
  const SPC = {};
  const circleAt = (b, t, n) => spPlay(t, sp(b, "circle"), tipX(b) - 4, tipY(b), [0, 1, ...Array(Math.max(0, n - 2)).fill(2)]);
  const finish = (b, at) => { impactAt(b, at); return strikeMon(at, { special: true }); };
  SPC.beam = (b, t) => { // Zoltraak at full power: a great circle, a beam as thick as the monster
    charge(b, t);
    hold(b, t + 3, 18, B("attack"));
    circleAt(b, t, 20);
    const x0 = tipX(b) + 6, from = t + 5, seg = sp(b, "mbeam");
    const n = Math.max(1, Math.ceil((front + 6 - x0) / 16));
    beamRow(fx(n * 16, FAMILY.special), from, from + 14, x0, tipY(b), n, 3, (s) => S(seg.cps[s % 2]));
    const d = [from + 3, from + 6, from + 9].map((s) => { flinch(s); return strikeMon(s, { big: true }); });
    impactAt(b, from + 3);
    const big = finish(b, from + 12);
    return { len: from + 16 - t, flashes: [from + 3, from + 12], hit: from + 12, dmg: [...d, big] };
  };
  SPC.barrage = (b, t) => { // a storm of bolts
    charge(b, t);
    hold(b, t + 3, 18, B("attack"));
    circleAt(b, t, 18);
    const dys = [-4, 3, -1, 5, -4, 3, -1, 5, -4, 3, -1, 5]; // four lanes: fewer boxes
    const d = dys.map((dy, k) => strikeMon(shoot(b, t + 4 + k, 3, tipX(b), dy, k % 3 === 2), { small: true }));
    const big = finish(b, t + 4 + 11 + 4);
    return { len: 23, flashes: [t + 19], hit: t + 19, dmg: [...d.slice(0, 4), "…", big] };
  };
  SPC.rain = (b, t, key = "spear", count = 8) => { // light falling from the sky
    charge(b, t);
    hold(b, t + 3, 16, B("attack"));
    circleAt(b, t, 6);
    const xs = [-18, 6, -6, 14, -12, 2, 10, -2];
    const d = [];
    xs.slice(0, count).forEach((dx, k) => {
      spPlay(t + 4 + k, sp(b, key), centre + dx - 4, Y0, [0, 1, 2, 3]);
      if (k % 2) d.push(strikeMon(t + 7 + k, { small: true }));
    });
    const big = finish(b, t + 4 + count + 4);
    return { len: count + 12, flashes: [t + 4 + count + 4], hit: t + 4 + count + 4, dmg: [...d, big] };
  };
  SPC.inferno = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 14, B("attack"));
    circleAt(b, t, 6);
    spPlay(t + 4, sp(b, "inferno"), centre - 28, Y0, [0, 1, 2, 1, 2, 1, 2, 2, 1, 3, 3]);
    const d = [t + 5, t + 8].map((s) => strikeMon(s, { big: true }));
    const big = finish(b, t + 11);
    return { len: 16, flashes: [t + 6, t + 11], hit: t + 11, dmg: [...d, big] };
  };
  SPC.tornado = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 16, B("attack"));
    circleAt(b, t, 6);
    spPlay(t + 4, sp(b, "tornado"), centre - 20, Y0, [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
    const d = [t + 6, t + 9, t + 12].map((s) => strikeMon(s, { small: true }));
    const big = finish(b, t + 15);
    return { len: 19, flashes: [t + 15], hit: t + 15, dmg: [...d, big] };
  };
  SPC.ice = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 14, B("attack"));
    circleAt(b, t, 6);
    const g = sp(b, "icespike");
    const x0 = b.head + 24, n = Math.max(2, Math.min(7, Math.floor((centre - 12 - x0) / 22)));
    for (let k = 0; k <= n; k++) spPlay(t + 4 + k, g, x0 + ((centre - 12 - x0) * k) / n - 8, Y0, [0, 1, 1, 2]);
    const at = t + 4 + n + 1;
    spPlay(at, g, centre - 14, Y0, [0, 1, 1, 1, 2]);
    spPlay(at + 1, g, centre - 2, Y0, [0, 1, 1, 1, 2]);
    const big = finish(b, at + 2);
    return { len: at + 6 - t, flashes: [at + 2], hit: at + 2, dmg: [big] };
  };
  SPC.tide = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 14, B("attack"));
    circleAt(b, t, 6);
    const g = sp(b, "tide"), x0 = tipX(b), x1 = centre - 34, n = 8;
    for (let k = 0; k < n; k++) spPlay(t + 4 + k, g, x0 + ((x1 - x0) * k) / (n - 1), Y0, [k % 3]);
    const at = t + 4 + n;
    spPlay(at, sp(b, "splash"), centre - 20, Y0, [0, 1, 1]);
    const big = finish(b, at);
    return { len: at + 4 - t, flashes: [at], hit: at, dmg: [big] };
  };
  SPC.chains = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 16, B("attack"));
    circleAt(b, t, 6);
    spPlay(t + 4, sp(b, "chains"), centre - 24, Y0, [0, 0, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]);
    for (let s = t + 6; s < t + 12; s++) monSet(s, S(M.hurt[1]));
    say(t + 6, `The ${foe} is bound!`);
    const d = [0, 1, 2].map((k) => strikeMon(shoot(b, t + 8 + k * 2, 3, tipX(b), (k - 1) * 3), { small: true }));
    const big = finish(b, t + 17);
    return { len: 21, flashes: [t + 17], hit: t + 17, dmg: [...d, big] };
  };
  SPC.thunder = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 14, B("attack"));
    circleAt(b, t, 6);
    const d = [-8, 6, 0].map((dx, k) => {
      spPlay(t + 4 + k * 3, sp(b, "lightning"), centre - 12 + dx, Y0, [0, 1, 2]);
      return k < 2 ? strikeMon(t + 5 + k * 3) : finish(b, t + 5 + k * 3);
    });
    return { len: 17, flashes: [t + 5, t + 8, t + 11], hit: t + 11, dmg: d };
  };
  SPC.mirror = (b, t) => {
    const spots = [[b.x - 18, -2], [b.x + 18, 1], [b.x - 6, -4], [b.x + 30, -1]];
    charge(b, t);
    hold(b, t + 3, 15, B("attack"));
    spots.forEach(([x], i) => fxPlay(t + i, "poof", x + STAGE.sx - 16, Y0 - 4, [0, 1]));
    spots.forEach(([x, dy], i) => {
      const a = fx(STAGE.stageWidth, b.fam);
      for (let s = t + 1 + i; s < t + 16; s++) a.set(s, x, Y0 + dy, (s + i) % 4 === 3 ? null : B("attack"));
    });
    const d = [];
    [[b.x, 0], ...spots].forEach(([x, dy], i) => {
      d.push(strikeMon(shoot(b, t + 5 + i, 3, x + STAGE.sx + b.tip[0], dy, false), { small: true }));
      d.push(strikeMon(shoot(b, t + 8 + i, 3, x + STAGE.sx + b.tip[0], dy, i === 2), { small: true }));
    });
    spots.forEach(([x]) => fxPlay(t + 16, "poof", x + STAGE.sx - 16, Y0 - 4, [0, 1]));
    const big = finish(b, t + 16);
    return { len: 20, flashes: [t + 16], hit: t + 16, dmg: [...d.slice(0, 4), "…", big] };
  };
  SPC.cuts = (b, t) => {
    hold(b, t, 14, B("attack"));
    spPlay(t + 2, sp(b, "cuts"), centre - 24, monMid - 16, [0, 0, 1, 1, 2, 2, 3, 3]);
    const d = [t + 2, t + 4, t + 6].map((s) => strikeMon(s));
    const big = finish(b, t + 9);
    return { len: 14, flashes: [t + 8], hit: t + 9, dmg: [...d, big] };
  };
  SPC.skysplit = (b, t) => { // up into the sky, and one blow straight down
    const dist = meleeHead - 10 - b.head;
    for (let k = 1; k <= 4; k++) b.actor.set(t + k - 1, b.x + (dist * k) / 4, Y0, B("run", k));
    const mx = meleeHead - 10 - STAGE.sx;
    [[-4, "jump"], [-7, "jump"], [-8, "swing"], [-8, "swing"]].forEach(([dy, p], i) => b.actor.set(t + 4 + i, mx, Y0 + dy, B(p, 0)));
    const at = t + 8;
    pose(b, at, [B("swing", 1), B("swing", 2), B("swing", 2), B("swing", 2)], mx + 6, Y0);
    spPlay(at, sp(b, "bigslash"), centre - 20, Y0, [0, 1, 2]);
    spPlay(at + 1, SPX.shock, centre - 32, Y0, [0, 1, 2]);
    const big = finish(b, at);
    [[-6, 0.66], [-8, 0.33], [-3, 0]].forEach(([dy, k], i) => b.actor.set(at + 5 + i, b.x + dist * k, Y0 + dy + 6, B("jump")));
    return { len: at + 8 - t, flashes: [at], hit: at, dmg: [big] };
  };
  SPC.quake = (b, t) => { // the axe into the ground: rocks erupt all the way to the monster
    hold(b, t, 4, B("swing", 0));
    fxPlay(t, "aura", b.head - 14, Y0, [0, 1, 2, 0]);
    pose(b, t + 4, [B("swing", 1), B("swing", 2), B("swing", 2), B("swing", 2), B("swing", 2), B("swing", 2)]);
    spPlay(t + 5, SPX.shock, b.head - 20, Y0, [0, 1, 2]);
    const g = sp(b, "rocks"), x0 = b.head + 28, n = Math.max(2, Math.min(7, Math.floor((centre - 10 - x0) / 22)));
    for (let k = 0; k <= n; k++) spPlay(t + 5 + k, g, x0 + ((centre - 10 - x0) * k) / n - 10, Y0, [0, 1, 2]);
    const at = t + 6 + n;
    spPlay(at, g, centre - 20, Y0, [0, 1, 1, 2]);
    spPlay(at, g, centre - 2, Y0, [0, 1, 1, 2]);
    const big = finish(b, at + 1);
    return { len: at + 5 - t, flashes: [t + 5, at + 1], hit: at + 1, dmg: [big] };
  };
  SPC.flash = (b, t) => { // gone in a flash, across to the monster; the cuts open a moment later
    fxPlay(t, "poof", b.head - 16, Y0 - 4, [0, 1]);
    const back = meleeHead + 2;
    for (let s = t + 1; s < t + 3; s++) b.actor.set(s, b.x, Y0, null);
    const fl = sp(b, "flashline"), tiles = Math.max(1, Math.ceil((front + 24 - b.head) / 64));
    const line = fx(tiles * 64, FAMILY.special);
    [0, 1].forEach((f, i) => line.set(t + 1 + i, b.head, Y0, S(fl.cps[f]).repeat(tiles)));
    pose(b, t + 3, Array(7).fill(B("swing", 2)), back - STAGE.sx);
    spPlay(t + 6, sp(b, "xcut"), centre - 20, monMid - 16, [0, 1, 2]);
    const d = [t + 6, t + 7].map((s) => strikeMon(s));
    const big = finish(b, t + 8);
    fxPlay(t + 10, "poof", back - 16, Y0 - 4, [0, 1]);
    fxPlay(t + 11, "poof", b.head - 16, Y0 - 4, [0, 1]);
    return { len: 13, flashes: [t + 1, t + 8], hit: t + 8, dmg: [...d, big] };
  };
  SPC.judgment = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 12, B("attack"));
    spPlay(t + 3, sp(b, "judgment"), centre - 20, Y0, [0, 0, 1, 1, 2, 2, 2, 3, 3]);
    const d = [t + 6].map((s) => strikeMon(s, { big: true }));
    const big = finish(b, t + 8);
    const t1 = t + 12;
    for (const o of [...party, ...allyBodies]) if (here(o, t1)) fxPlay(t1, "heal", o.head - 12, Y0 + 2, [0, 1, 2]);
    const n = 20 + Math.floor(rand() * 20);
    num(t1, `+${n}`, "heal", b.head - 6, Y0 + 2, [0, 1, 2, 2]);
    say(t1, `The holy light heals the party +${n}`);
    return { len: 16, flashes: [t + 5, t + 8], hit: t + 8, dmg: [...d, big] };
  };
  SPC.sanctuary = (b, t) => {
    charge(b, t);
    hold(b, t + 3, 18, B("attack"));
    spPlay(t + 2, sp(b, "sanct"), Math.max(0, start - 30), Y0, [0, 1, 2, 1, 2, 1, 2, 2]);
    for (const o of [...party, ...allyBodies]) if (here(o, t + 4)) fxPlay(t + 4, "heal", o.head - 12, Y0 + 2, [0, 1, 2]);
    const n = 20 + Math.floor(rand() * 20);
    num(t + 4, `+${n}`, "heal", b.head - 6, Y0 + 2, [0, 1, 2, 2]);
    say(t + 4, `The sanctuary heals the party +${n}`);
    const r = SPC.rain(b, t + 6, "spear", 6);
    return { len: r.len + 6, flashes: r.flashes, hit: r.hit, dmg: r.dmg };
  };
  const special = (b, t) => {
    const mv = SPX.moves[b.ch.id] ?? { name: "SPECIAL", how: b.fighter ? "skysplit" : "beam" };
    const play = SPC[mv.how] && sp(b, "impact") ? SPC[mv.how] : null;
    say(t, `★ ${b.ch.name}'s special move: ${mv.name}!`);
    const r = play ? play(b, t) : { len: T.charged(b, t), flashes: [], hit: t + 6, dmg: [] };
    dim(t, r.len, r.flashes);
    banner(t, SPX.title[mv.name] ? mv.name : "SPECIAL");
    fxPlay(t, "aura", b.head - 14, Y0, [0, 1, 2]);
    say(r.hit, `${mv.name}! ${r.dmg.join(" · ")} damage`);
    return r.len;
  };

  const act = (b, t, kind, solo) => {
    switch (kind) {
      case "summon": return T.summon(b, t);
      case "read": return T.scan(b, t);
      case "write": return T.runes(b, t);
      case "fly": return T.dive(b, t);
      case "test": return T.combo(b, t);
      case "build": return T.forge(b, t);
      case "git": return T.rally(b, t);
      case "install": return T.supply(b, t);
      case "delete": return T.meteor(b, t);
      case "search": return T.track(b, t);
      case "plan": return T.tactics(b, t, solo);
      case "wait": return T.guard(b, t);
      case "media": return T.illusion(b, t);
      case "think": return T.think(b, t);
      default: return T.attack(b, t);
    }
  };

  // ----- the monster's turn: a shot at one, a charge at the front, or a blast at everyone
  let turnNo = 0;
  const targetsAt = (t) => [...party.filter((b) => b.st !== "blocked"), ...allyBodies.filter((a) => here(a, t))];
  // how `target` takes a hit landing at ti: blocks, dodges or is hurt (and a priest heals it); returns the step it's over
  const react = (target, ti, toY, force) => {
    const ready = target.st === "working" || target.ally;
    const reaction = force ?? (!ready ? "hurt" : target.fighter || target.style === "holy" ? "block" : turnNo % 2 ? "dodge" : "hurt");
    turnNo++;
    if (reaction === "block") {
      pose(target, ti - 2, [B("guard", 0), B("guard", 1), B("guard", 0), B("guard", 1), B("guard", 0)]);
      fxPlay(ti, "spark", target.head + 2, toY, [0, 1]);
      word(ti, "BLOCK", target.head - 10, overHead(target));
      say(ti, `${target.ch.name} blocks!`);
      return ti + 4;
    }
    if (reaction === "dodge") {
      pose(target, ti - 1, [B("jump"), B("jump"), B("jump")]);
      word(ti, "MISS", target.head - 8, overHead(target));
      say(ti, `${target.ch.name} dodges!`);
      return ti + 4;
    }
    pose(target, ti, [B("hurt", 0), B("hurt", 1), B("hurt", 1)]);
    const n = 5 + Math.floor(rand() * 18);
    num(ti, n, "hurt", target.head - 4, Y0 + 2, [0, 1, 2, 2, 2]);
    say(ti, `${target.ch.name} takes ${n} damage`);
    const healer = party.find((o) => o.style === "holy" && o.st !== "blocked" && o !== target) ?? (target.style === "holy" ? target : null);
    if (!healer) return ti + 4;
    const th = ti + 3;
    hold(healer, th, 3, B("attack"));
    fxPlay(th, "heal", target.head - 12, Y0 + 2, [0, 1, 2]);
    num(th, `+${n + 4}`, "heal", target.head - 6, Y0 + 2, [0, 1, 2, 2]);
    say(th, `${healer.ch.name} heals ${target.ch.name} +${n + 4}`);
    return th + 4;
  };
  const shotAt = (target, t, delay = 0) => {
    const k = M.kind;
    const mouthX = gx + M.mouth[0] - 10;
    const mouthY = Y0 + M.mouth[1] - STAGE.fx.y;
    const toX = target.head + 4;
    const toY = Y0 + 16 - STAGE.fx.y;
    const steps = Math.max(3, Math.min(6, Math.round((mouthX - toX) / 50)));
    const p = fx(STAGE.fx.mon[k].proj.w);
    for (let s = 0; s < steps; s++) {
      const f = (s + 1) / (steps + 1);
      p.set(t + 3 + delay + s, mouthX + (toX - mouthX) * f, mouthY + (toY - mouthY) * f, S(STAGE.fx.mon[k].proj.cps[s % 2]));
    }
    const ti = t + 3 + delay + steps;
    const h = fx(STAGE.fx.mon[k].hit.w);
    h.set(ti, target.head - 11, toY, S(STAGE.fx.mon[k].hit.cps[0]));
    h.set(ti + 1, target.head - 11, toY, S(STAGE.fx.mon[k].hit.cps[1]));
    return [ti, toY];
  };
  function strike(target, t, force) {
    [0, 0, 1, 2, 3].forEach((f, i) => monSet(t + i, S(M.attack[f])));
    say(t + 2, `The ${foe} attacks ${target.ch.name}!`);
    const [ti, toY] = shotAt(target, t);
    return react(target, ti, toY, force) - t;
  }
  const blastAll = (t) => {
    const pool = targetsAt(t);
    [0, 0, 1, 2, 2, 2, 3].forEach((f, i) => monSet(t + i, S(M.attack[f])));
    say(t + 1, `The ${foe} lashes out at the whole party!`);
    let end = t;
    pool.forEach((o, i) => { const [ti, toY] = shotAt(o, t, i); end = Math.max(end, react(o, ti, toY)); });
    return end - t;
  };
  const chargeAt = (target, t) => {
    const to = target.head + 12 - M.x0;
    monSet(t, S(M.attack[0]));
    monSet(t + 1, S(M.attack[0]));
    for (let k = 1; k <= 3; k++) monSet(t + 1 + k, S(M.attack[1]), gx + ((to - gx) * k) / 3);
    const ti = t + 4;
    say(t + 1, `The ${foe} charges at ${target.ch.name}!`);
    const end = react(target, ti, Y0 + 16 - STAGE.fx.y);
    monSet(ti + 1, S(M.attack[2]), to);
    for (let k = 1; k <= 3; k++) monSet(ti + 1 + k, S(M.idle[k % M.idle.length]), to + ((gx - to) * k) / 3);
    return Math.max(end, ti + 5) - t;
  };
  let monTurns = 0, rage = false;
  // a member whose agent failed 3 times in a row enrages the monsters from the first wave
  const furious = party.filter((b) => b.streak >= 3).sort((a, b) => b.streak - a.streak)[0] ?? null;
  const shortly = (s) => (String(s ?? "").length > 40 ? `${String(s).slice(0, 39)}…` : String(s ?? ""));
  const monsterTurn = (t, boss) => {
    const pool = targetsAt(t);
    // every other turn the monster goes for a member whose commands really failed lately: it can't block or dodge
    const wounded = pool.filter((b) => b.wounds > 0 && !b.ally);
    if (wounded.length && monTurns % 2 === 0) {
      const target = wounded[monTurns++ % wounded.length];
      const len = strike(target, t, "hurt");
      say(t + len - 1, `${target.ch.name} is wounded: ${target.hit?.what === "edit" ? "an edit failed" : "a command failed"} (${shortly(target.hit?.detail)})`);
      return len;
    }
    const target = pool[(turnNo + hash(foe) + monTurns) % pool.length];
    const kinds = boss ? ["blast", "charge", "shot", "blast"] : ["shot", "charge", "shot", "blast"];
    const kind = kinds[monTurns++ % kinds.length];
    let len = kind === "blast" && pool.length > 1 ? blastAll(t) : kind === "charge" ? chargeAt(pool.reduce((a, o) => (o.head > a.head ? o : a), pool[0]), t) : strike(target, t);
    if ((boss || furious) && rage) len += 1 + strike(pool[(turnNo + 1) % pool.length], t + len + 1);
    return len;
  };

  // ----- the timeline: three waves, the last a boss; every working member takes turns; the monster strikes back
  const acting = party.filter((b) => b.st === "working");
  const rotations = new Map(acting.map((b) => [b, rotation(b.kinds)]));
  const rotAt = new Map(acting.map((b) => [b, hash(b.ch.id) % rotations.get(b).length]));
  const spLevel = new Map(acting.map((b, i) => [b, i % 2]));
  const gauge = new Map(acting.map((b) => [b, [[0, spLevel.get(b)]]]));
  const spans = [];
  let t = 0;
  for (let w = 0; w < waves.length; w++) {
    wave = w;
    const W_ = waves[w];
    useMonster(W_.key);
    const spawn = t;
    [0, 0, 1, 1].forEach((f, i) => monSet(t + i, S(M.spawn[f])));
    banner(t, W_.label, 12);
    titles.push([t, `BATTLE · ${W_.boss ? "Boss" : `Wave ${w + 1}/3`} · vs ${foe}`]);
    say(t, W_.boss ? `The boss appears: the ${foe}!` : `Wave ${w + 1}: a ${foe} appears!`);
    t += 5;
    if (w === 0) {
      // what really happened lately opens the fight: test runs (ALL CLEAR / WOUNDED) and a streak of failures (RAGE)
      for (const b of party) {
        if (!b.tests) continue;
        if (b.tests.ok) {
          word(t, "COMBO!", b.head - 12, overHead(b), [0, 0, 1, 1, 1, 1, 1]);
          say(t, `ALL CLEAR! ${b.ch.name}'s tests passed${b.tests.passed ? ` (${b.tests.passed})` : ""}`);
          titles.push([t, `ALL CLEAR · ${b.ch.name}'s tests passed`]);
        } else {
          pose(b, t, [B("hurt", 0), B("hurt", 1), B("hurt", 1), B("hurt", 0)]);
          num(t, b.tests.failed || 1, "hurt", b.head - 4, Y0 + 2, [0, 1, 2, 2, 2]);
          say(t, `WOUNDED! ${b.ch.name}'s tests failed${b.tests.failed ? ` (${b.tests.failed} failed)` : ""}`);
          titles.push([t, `WOUNDED · ${b.ch.name}'s tests failed`]);
        }
        t += 7;
      }
      if (furious) {
        rage = true;
        banner(t, "RAGE!", 10);
        for (let s = t; s < t + 4; s++) monSet(s, S(M.hurt[s % 2]));
        say(t, `The ${foe} is enraged: ${furious.ch.name} failed ${furious.streak} times in a row`);
        titles.push([t, `RAGE · ${furious.ch.name} failed ${furious.streak} times in a row`]);
        t += 6;
      }
    }
    const turns = W_.boss ? Math.max(7, 3 * acting.length) : Math.max(5, 2 * acting.length);
    let since = 0;
    for (let k = 0; k < turns; k++) {
      const b = acting[k % acting.length];
      const last = k === turns - 1;
      const lv = spLevel.get(b);
      let len;
      if (lv >= SP_MAX || (last && (W_.boss || lv >= 2))) {
        turnLog.push([t, b.ch.id, "special"]);
        len = special(b, t);
        spLevel.set(b, 0);
      } else {
        const rot = rotations.get(b);
        const i = rotAt.get(b);
        rotAt.set(b, i + 1);
        turnLog.push([t, b.ch.id, rot[i % rot.length]]);
        len = act(b, t, rot[i % rot.length], acting.length === 1);
        spLevel.set(b, Math.min(SP_MAX, lv + 1));
      }
      gauge.get(b).push([t + len, spLevel.get(b)]);
      t += len + 1;
      since++;
      if (W_.boss && !rage && k >= Math.floor(turns / 2)) {
        rage = true;
        banner(t, "RAGE!", 10);
        for (let s = t; s < t + 4; s++) monSet(s, S(M.hurt[s % 2]));
        say(t, `The ${foe} is enraged!`);
        t += 5;
      }
      if (!last && since >= 2) {
        t += monsterTurn(t, W_.boss) + 1;
        since = 0;
      }
    }
    // knocked out
    const ko = t;
    fxPlay(ko, "smoke", centre - 20, monMid - 20, [0, 0, 1, 1, 2, 2]);
    word(ko + 1, "KO!", centre - 7, numRow, [0, 0, 1, 1, 2, 2]);
    say(ko, `The ${foe} is defeated!`);
    spans.push({ spawn, ko, M, centre, monTop });
    const cheer = W_.boss ? 16 : 7;
    for (const b of [...party, ...allyBodies]) {
      if (!here(b, ko) || b.st === "blocked") continue;
      pose(b, ko + 1, Array.from({ length: cheer }, (_, i) => animAt("victory", i * 2)));
    }
    allyBodies.forEach((a) => {
      const open = a.stays.find((s) => s[1] === Infinity);
      if (!open) return;
      open[1] = ko + cheer + 1;
      fxPlay(ko + cheer + 1, "poof", a.head - 16, Y0 - 4, [0, 1]);
    });
    if (W_.boss) {
      banner(ko + 2, "VICTORY!", 16);
      titles.push([ko, "VICTORY · the boss is down"]);
      say(ko + 2, `Victory! The party cleared all three waves`);
      const tr = STAGE.props.treasure;
      const chest = new Actor(FAMILY.props, tr.w);
      fxs.push(chest);
      for (let s = ko + 4; s < ko + cheer + 2; s++) chest.set(s, centre - Math.round(tr.w / 2), Y0, S(tr.cps[Math.floor((s * STEP) / tr.ms) % tr.cps.length]));
    }
    t = ko + cheer + 3;
  }
  const L = t;
  // a member waiting for the person calls for help now and then
  party.filter((b) => b.st === "blocked").forEach((b, i) => {
    for (let s = 6 + i * 5; s + 6 < L; s += 26) word(s, "HELP!", b.head - 10, overHead(b), [0, 0, 0, 1, 1, 1]);
  });

  // the monster of each wave: what turns set, else its idle bob while alive; its HP bar drains hit by hit
  const mon = new Actor(FAMILY.monsters, STAGE.monsterWidth);
  const bar = new Actor(FAMILY.fx, STAGE.fx.hp.w);
  spans.forEach((sp_, w) => {
    for (let s = sp_.spawn; s < sp_.ko; s++) {
      const [x, g] = monAt.get(s) ?? [gx, S(sp_.M.idle[Math.floor(s / 3) % sp_.M.idle.length])];
      mon.set(s, x, Y0, g);
    }
    const mine = hits.filter(([, , hw]) => hw === w);
    const max = mine.reduce((a, [, n]) => a + n, 0) || 1;
    const byStep = new Map();
    mine.forEach(([s, n]) => byStep.set(s, (byStep.get(s) ?? 0) + n));
    let left = max;
    for (let s = sp_.spawn; s < sp_.ko; s++) {
      left -= byStep.get(s) ?? 0;
      if (s >= sp_.spawn + 2) bar.set(s, sp_.centre - 15, Math.max(0, sp_.monTop - 7) - 1, FX("hp", Math.max(left > 0 ? 1 : 0, Math.ceil((10 * left) / max))));
    }
  });
  // each working member's SP gauge over its head (blinking when full)
  const gauges = acting.map((b) => {
    const a = new Actor(FAMILY.special, SPX.gauge.w);
    const ev = gauge.get(b);
    for (let s = 0, i = 0; s < L; s++) {
      while (i + 1 < ev.length && ev[i + 1][0] <= s) i++;
      const lv = ev[i][1];
      a.set(s, b.head - 7, 0, S(SPX.gauge.cps[lv >= SP_MAX ? (Math.floor(s / 3) % 2 ? 5 : 4) : lv]));
    }
    return a;
  });
  const props = [];
  const ownAt = party.findIndex((b) => b.own);
  if (party.length > 1 && ownAt >= 0) {
    const p = STAGE.props.ring;
    props.push({ key: "ring", family: FAMILY.props, x: party[ownAt].head - 11, y: Y0, w: p.w, frames: p.cps.map(S), ms: p.ms });
  }
  const items = [...props, ...boxes([shade, shadeTop, mon, bar, ...bodies, ...gauges, ...fxs], L)];
  return {
    mode: "battle", monster: waves[0].key, foe: STAGE.monsters[waves[0].key].name, L, items,
    log: logTracks(log, L), title: track(titles, L), turns: turnLog, cast: [...party, ...allyBodies].map((b) => b.ch.name),
  };
}

// a value over the timeline from [step, value] events
function track(ev, L) {
  ev.sort((a, b) => a[0] - b[0]);
  const out = Array(L).fill(ev[0]?.[1] ?? "");
  let v = out[0], i = 0;
  for (let t = 0; t < L; t++) {
    while (i < ev.length && ev[i][0] <= t) v = ev[i++][1];
    out[t] = v;
  }
  return out;
}

// two lines of the battle log over the timeline: the newest and the one before
function logTracks(log, L) {
  log.sort((a, b) => a[0] - b[0]);
  const now = Array(L).fill(""), before = Array(L).fill("");
  let a = "", b = "", i = 0;
  for (let t = 0; t < L; t++) {
    while (i < log.length && log[i][0] <= t) { b = a; a = log[i][1]; i++; }
    now[t] = a;
    before[t] = b;
  }
  return [now, before];
}

// ---------------------------------------------------------------- camp and victory: loops of their own
const DAY = ["meal", "flowers", "training", "reading"];
const NIGHT = ["sleep", "stargaze"];
const WATER = new Set(["lakeside-town", "snow-north", "dawn-flowers"]);
const VICTORY = ["treasure", "grimoire", "mimic"];
export function pastime(sceneId, night, pick) {
  const list = night ? NIGHT : WATER.has(sceneId) ? [...DAY, "fishing"] : DAY;
  return list[pick % list.length];
}

function still(members, sceneId, W, night, mode, pick) {
  const items = [];
  const at = (family, x, y, w, list, ms) => items.push({ key: `s${items.length}`, family, x: Math.round(x), y, w, frames: list, ms });
  const prop = (n, x) => { const p = STAGE.props[n]; at(FAMILY.props, x, Y0, p.w, p.cps.map(S), p.ms); };
  const fxAt = (key, x, y, seq, ms) => { const f = STAGE.fx[key]; at(FAMILY.fx, x, y, f.w, seq.map((i) => (i == null ? BLANK : S(f.cps[i]))), ms); };
  const body = (m, head, a, flip = false) => {
    const f = frames(a + (flip ? "_l" : ""), false);
    at(familyOf(m.ch), head - (flip ? STAGE.stageWidth - 1 - STAGE.sx : STAGE.sx), Y0, STAGE.stageWidth, f.list, f.ms);
  };
  const B2 = (m, key, i) => S(STAGE.battle[key].cps[i]);
  const cx = Math.max(110, Math.min(260, Math.round(W * 0.45)));
  const start = Math.max(24, Math.min(64, Math.round(W * 0.08)));
  const lead = members[0]?.ch.name ?? "The party";
  const names = members.map((m) => m.ch.name).join(", ");
  const many = members.length > 1;
  const ring = (head) => { if (many) prop("ring", head - 11); };
  const ownAt = members.findIndex((m) => m.own);
  const wake = (m, a) => (m.st === "blocked" ? "alert" : a);
  let kind, line;

  if (mode === "question") {
    // a member's last turn ended with a question to the person: it waits by the signpost with a "?" over its head
    prop("signpost", Math.max(0, W - 60));
    members.forEach((m, i) => {
      const head = start + i * 28;
      if (i === ownAt) ring(head);
      body(m, head, wake(m, "stand"));
      if (m.asks) items.push({ key: `q${i}`, text: true, family: "Galmuri11", color: "#ffd35a", size: 13, x: head + 1, y: Y0 - 3, w: 10, frames: ["?", "?", "?", " "], ms: 380 });
    });
    const a = members.find((m) => m.asks) ?? members[0];
    line = [`${a.ch.name} asks you: ${a.q ?? "an answer"}`, names];
    return { mode, activity: "question", monster: null, foe: null, L: 1, items, log: [[line[0]], [line[1]]], cast: members.map((m) => m.ch.name) };
  }

  if (mode === "victory") {
    kind = VICTORY[pick % VICTORY.length];
    // the loot a done member really made (pixel-chronicle) is what's in the chest
    const looter = members.find((m) => m.lootName);
    const loot = looter ? `Loot: ${looter.lootName}${looter.lootCount > 1 ? ` (+${looter.lootCount - 1})` : ""}` : null;
    const chestX = W - 60;
    if (kind === "mimic") {
      const Mm = STAGE.monsters.mimic;
      const mx = W - 70;
      const seq = [...Mm.idle, ...Mm.idle, ...Mm.attack].map(S);
      at(FAMILY.monsters, mx, Y0, STAGE.monsterWidth, seq, 130);
      const w = STAGE.fx.word["MIMIC!"];
      at(FAMILY.fx, mx + 24, Y0 + 1 - STAGE.fx.numTop, w.w, seq.map((_, i) => (i >= 8 ? S(w.cps[i % 2]) : BLANK)), 130);
      const near = mx + Mm.x0 - 18;
      members.forEach((m, i) => {
        const head = i === 0 ? near : start + (i - 1) * 28;
        if (i === ownAt) ring(head);
        body(m, head, i === 0 ? "alert" : m.st === "done" ? "victory" : wake(m, "stand"));
      });
      line = [`It's a Mimic! ${lead} gets bitten… again`, names];
    } else {
      prop("treasure", chestX);
      if (kind === "grimoire") fxAt("grimoire", chestX + 2, Y0 - 6, [0, 1], 300);
      members.forEach((m, i) => {
        const head = start + i * 28;
        if (i === ownAt) ring(head);
        body(m, head, m.st === "done" ? "victory" : wake(m, "stand"));
      });
      line = loot ? [`Quest complete! ${loot}`, names] : kind === "grimoire" ? [`A rare grimoire! ${lead} is overjoyed`, names] : ["Quest complete! A treasure chest", names];
    }
    return { mode, activity: kind, monster: null, foe: null, L: 1, items, log: [[line[0]], [line[1]]], cast: members.map((m) => m.ch.name) };
  }

  kind = pastime(sceneId, night, pick);
  if (kind === "meal" || kind === "sleep" || kind === "stargaze") {
    if (cx - 120 >= 0) prop("signpost", cx - 120);
    prop("backpack", cx - 90);
    prop("tent", cx + 72);
    if (night) prop("bedroll", cx + 76);
    const fire = night ? "embers" : members.some((m) => m.st === "idle") ? "cook" : "fire";
    prop(fire, cx - Math.floor(STAGE.props[fire].w / 2));
    const seats = [[cx - 25, false], [cx + 25, true], [cx - 51, false], [cx + 51, true]];
    members.forEach((m, i) => {
      const [head, flip] = seats[i];
      if (i === ownAt) ring(head);
      const a = kind === "meal" ? (m.st === "idle" ? "eat" : "stand") : kind === "stargaze" && i === 0 ? "stand" : m.st === "idle" ? "rest" : "stand";
      body(m, head, wake(m, a), flip);
    });
    if (kind === "stargaze") {
      [[0.22, 23, 0], [0.62, 31, 9], [0.85, 41, 20]].forEach(([k, n, off]) => {
        const seq = Array(n).fill(null);
        [0, 1, 2].forEach((f, i) => { seq[(off + i) % n] = f; });
        fxAt("star", W * k, Y0 - 4, seq, 110);
      });
    }
    line = kind === "meal" ? [many ? "The party shares a meal by the campfire" : `${lead} has a meal by the campfire`, names]
      : kind === "sleep" ? ["The party sleeps by the campfire… Zzz", names]
        : [`${lead} keeps watch under the shooting stars`, names];
  } else if (kind === "flowers") {
    for (let x = 6, k = 0; x < W - 40; x += 46, k++) {
      const grow = [0, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
      fxAt("bloom", x, Y0, grow.map((_, i) => grow[(i + k * 3) % grow.length]), 320);
    }
    [[0.3, 2], [0.55, -1], [0.78, 4]].forEach(([k, dy], i) => fxAt("butterfly", W * k, Y0 + dy + i * 2, [0, 1], 160 + i * 30));
    members.forEach((m, i) => {
      const head = start + 10 + i * 36;
      if (i === ownAt) ring(head);
      body(m, head, wake(m, "stand"));
    });
    line = [many ? "The party walks through a field of flowers" : `${lead} casts a favorite spell: a field of flowers`, names];
  } else if (kind === "fishing") {
    const fisher = members.length - 1;
    members.forEach((m, i) => {
      const head = start + i * 30;
      if (i === ownAt) ring(head);
      body(m, head, wake(m, i === fisher ? "stand" : m.st === "idle" ? "rest" : "stand"));
      if (i === fisher) {
        fxAt("rod", head + 4, Y0, [0, 1, 2, 0, 1, 2, 0, 1, 2, 3], 280);
        fxAt("bubble", head + 2, Y0 - 4, [null, null, null, null, null, null, null, null, null, 1], 280);
      }
    });
    prop("backpack", Math.max(0, start - 24));
    line = [`${members[fisher].ch.name} goes fishing… a bite!`, names];
  } else if (kind === "training") {
    let x = start;
    members.forEach((m, i) => {
      const head = x;
      if (i === ownAt) ring(head);
      const fighter = Boolean(MELEE[m.ch.id]);
      if (m.st === "blocked") body(m, head, "alert");
      else if (fighter) {
        at(familyOf(m.ch), head - STAGE.sx, Y0, STAGE.stageWidth, [0, 1, 2, 2].map((f) => B2(m, "swing", f)), 180);
        fxAt("dummy", head + 18, Y0, [0, 1, 0, 0], 180);
      } else {
        const f = frames("cast", false);
        at(familyOf(m.ch), head - STAGE.sx, Y0, STAGE.stageWidth, f.list, f.ms);
        fxAt("dummy", head - STAGE.sx + 66, Y0, f.list.map((_, k) => (k === 8 || k === 9 ? 1 : 0)), f.ms);
      }
      x += fighter ? 52 : 92;
    });
    line = [many ? "The party trains with straw dummies" : `${lead} trains with a straw dummy`, names];
  } else {
    // reading: studying grimoires
    members.forEach((m, i) => {
      const head = start + i * 34;
      if (i === ownAt) ring(head);
      body(m, head, wake(m, i % 2 ? "write" : "read"));
    });
    fxAt("grimoire", start + members.length * 34 + 6, Y0 - 2, [0, 1], 320);
    line = [many ? "The party studies grimoires together" : `${lead} studies a grimoire`, names];
  }
  return { mode, activity: kind, monster: null, foe: null, L: 1, items, log: [[line[0]], [line[1]]], cast: members.map((m) => m.ch.name) };
}

// members: [{ ch, st, anim, own, key, summons, kinds }] (the shown tab's panes, MAX_PARTY at most; kinds: the kinds of
// work the member did lately, oldest first, its turns go through them); W: the stage's width in art pixels;
// pick: which pastime / victory scene (e.g. hash(tab) + the 20-minute slot), and which battle
// What the member's agent really did lately (pixel-chronicle's deeds), all optional:
//   wounds: commands / edits that failed in the last 5 minutes (the monster goes for it: no block, no dodge)
//   streak: failures in a row (3+: the monsters rage from the first wave);  hit: { what, detail } the latest failure
//   tests: { ok, passed?, failed? } a test run in the last 10 minutes (opens the fight: ALL CLEAR / WOUNDED)
//   asks, q: its last turn ended with a question q (no battle: mode "question", a "?" over its head)
//   lootName, lootCount: files it made in the last 30 minutes (what the victory chest holds)
// -> { mode, activity, monster, foe, L, items: [{ key, family, x, y, w, frames, ms, text?, color?, size? }],
//      log: [newest[], before[]], title?: [per step], cast }   (text items: plain characters in a ui font, color, size)
export function plan(members, sceneId, night, W = STAGE.stripWidth, pick = 0) {
  const st = members.map((m) => m.st);
  const mode = st.includes("working") ? "battle" : members.some((m) => m.asks) ? "question" : st.includes("done") ? "victory" : "camp";
  if (mode !== "battle") return still(members, sceneId, W, night, mode, pick);
  const seed = hash(`${sceneId}|${pick}|${members.map((m) => `${m.ch.id}:${(m.kinds ?? [m.anim]).join("+")}:${m.st}`).join(",")}`);
  return battle(members, sceneId, W, seed);
}
