import { createFSRS, DEFAULT_W, AGAIN, HARD, GOOD, EASY, DAY } from '../fsrs.js';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; }
  else { failed++; console.error('  FAIL:', name, extra); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

const f = createFSRS();
const { decay, factor } = f.params;

// 1. Forgetting curve calibration: R(S,S) === 0.9
for (const S of [1, 2.3, 8.3, 50, 365]) {
  ok(`R(S,S)=0.9 @S=${S}`, approx(f.retrievability(S, S), 0.9, 1e-9),
    `got ${f.retrievability(S, S)}`);
}

// 2. Interval at default retention (0.9) equals stability
for (const S of [1, 2.3, 8.3, 50, 365]) {
  ok(`interval(0.9)≈S @S=${S}`, approx(f.intervalDays(S), S, 1e-6),
    `got ${f.intervalDays(S)}`);
}

// 3. Retrievability monotonically decreases with elapsed time
let prev = 1.01;
for (const t of [0.5, 1, 2, 5, 10, 30]) {
  const r = f.retrievability(t, 10);
  ok(`R decreasing @t=${t}`, r < prev && r > 0 && r <= 1, `got ${r}`);
  prev = r;
}

// 4. New-card intervals ordered Again < Hard < Good < Easy
const p = f.preview(null);
ok('new Again requeues (0d)', p[AGAIN] === 0, JSON.stringify(p));
ok('new intervals ordered Hard<=Good<Easy', p[HARD] <= p[GOOD] && p[GOOD] < p[EASY], JSON.stringify(p));
console.log('  new-card intervals (days):', p);

// 5. Good on a new card graduates to a positive multi-day interval
const g1 = f.review(null, GOOD, { now: 0 });
ok('new Good -> future due', g1.due > 0 && g1.scheduledDays >= 1, JSON.stringify(g1));
ok('new Good sets stability & difficulty', g1.stability > 0 && g1.difficulty >= 1 && g1.difficulty <= 10);

// 6. A successful review after the interval increases stability
const now1 = g1.due;
const g2 = f.review(g1, GOOD, { now: now1 });
ok('recall grows stability', g2.stability > g1.stability, `${g1.stability} -> ${g2.stability}`);
ok('recall pushes due further out', g2.scheduledDays > g1.scheduledDays, `${g1.scheduledDays} -> ${g2.scheduledDays}`);

// 7. A lapse (Again) after the interval reduces stability and requeues
const lapse = f.review(g2, AGAIN, { now: g2.due });
ok('lapse shrinks stability', lapse.stability < g2.stability, `${g2.stability} -> ${lapse.stability}`);
ok('lapse requeues this session', lapse.requeue === true && lapse.scheduledDays === 0);
ok('lapse increments lapses', lapse.lapses === 1);

// 8. Difficulty stays within [1,10] across a long random run
let card = null;
let bad = false;
let seed = 42;
const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
let t = 0;
for (let i = 0; i < 500; i++) {
  const grade = 1 + Math.floor(rng() * 4);
  card = f.review(card, grade, { now: t, rng });
  if (card.difficulty < 1 || card.difficulty > 10) bad = true;
  if (card.stability < 0.01) bad = true;
  t = card.due + (card.requeue ? 60000 : 0) + 1; // advance time past due
}
ok('difficulty & stability stay in bounds over 500 reviews', !bad);

// 9. Easy yields a longer interval than Good from the same state
const easyN = f.review(null, EASY, { now: 0 });
const goodN = f.review(null, GOOD, { now: 0 });
ok('Easy interval > Good interval (new)', easyN.scheduledDays > goodN.scheduledDays,
  `${goodN.scheduledDays} vs ${easyN.scheduledDays}`);

console.log(`\nFSRS tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
