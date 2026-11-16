// node fit.test.mjs: checks fit.js, the SPACES block's size by how many spaces there are.
import assert from "node:assert/strict";
import { fitHeight, plan, H, FALLBACK_WEIGHT } from "./fit.js";

let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
};

const node = (size) => ({ id: "spaces", size });

test("height: header, rows, gaps, paddings, frame", () => {
  assert.equal(fitHeight([H.slim], 4), 28 + 4 + H.slim + 6 + 4);
  assert.equal(fitHeight([26, 32, 26, 28], 4), 28 + 4 + 112 + 3 * 2 + 6 + 4);
  assert.equal(fitHeight([], 0), 38);
});

test("one space: keeps the person's weight, shrinks", () => {
  const r = plan(node({ weight: 0.41 }), 1, 74, {});
  assert.deepEqual(r.resize, { id: "spaces", px: 74 });
  assert.deepEqual(r.mem, { weight: 0.41, asked: 74 });
});

test("one space, already that size: nothing", () => {
  assert.equal(plan(node({ px: 74 }), 1, 74, { weight: 0.41, asked: 74 }).resize, null);
});

test("one space, dragged by hand after it shrank: left alone", () => {
  const r = plan(node({ px: 150 }), 1, 74, { weight: 0.41, asked: 74 });
  assert.equal(r.resize, null);
  assert.deepEqual(r.mem, { weight: 0.41, asked: 74 });
});

test("one space, what it shows grew (a machine group): asks again", () => {
  const r = plan(node({ px: 74 }), 1, 130, { weight: 0.41, asked: 74 });
  assert.deepEqual(r.resize, { id: "spaces", px: 130 });
  assert.deepEqual(r.mem, { weight: 0.41, asked: 130 });
});

test("two spaces: grows back to the weight it had", () => {
  const r = plan(node({ px: 74 }), 2, 74, { weight: 0.41, asked: 74 });
  assert.deepEqual(r.resize, { id: "spaces", weight: 0.41 });
  assert.deepEqual(r.mem, { weight: null, asked: null });
});

test("two spaces, the weight lost but the size is ours: the layout's weight", () => {
  assert.deepEqual(plan(node({ px: 74 }), 3, null, { asked: 74 }).resize, { id: "spaces", weight: FALLBACK_WEIGHT });
});

test("two spaces, a size this mod never set: left alone", () => {
  assert.equal(plan(node({ px: 200 }), 2, null, {}).resize, null);
  assert.equal(plan(node({ weight: 0.6 }), 2, null, { weight: 0.41 }).resize, null);
});

test("no block, no spaces, bad memory: nothing", () => {
  assert.equal(plan(null, 1, 74, {}).resize, null);
  assert.equal(plan(node({ px: 74 }), 0, 74, { weight: 0.4, asked: 74 }).resize, null);
  assert.deepEqual(plan(node({ weight: 1 }), 1, 74, { weight: "x", asked: {} }).mem, { weight: 1, asked: 74 });
  assert.equal(plan(node({ weight: 1 }), 1, null, null).resize, null);
});

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
