// FSRS-6 spaced-repetition scheduler.
// Reference formulas: open-spaced-repetition / expertium (FSRS-6, 21 params).
// Grades: 1=Again, 2=Hard, 3=Good, 4=Easy.

export const DEFAULT_W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
  1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

export const S_MIN = 0.01;
export const DAY = 86400000;

export const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

export function createFSRS({
  w = DEFAULT_W,
  requestRetention = 0.9,
  maximumInterval = 36500,
} = {}) {
  const decay = -w[20];
  // factor chosen so that R(S, S) === requestRetention baseline 0.9 (R = 0.9 at t = S)
  const factor = Math.pow(0.9, 1 / decay) - 1;

  const clampD = (d) => Math.min(Math.max(d, 1), 10);
  const clampS = (s) => Math.min(Math.max(s, S_MIN), maximumInterval);

  // Retrievability after `elapsedDays` given stability `s`.
  function retrievability(elapsedDays, s) {
    if (elapsedDays <= 0) return 1;
    return Math.pow(1 + factor * (elapsedDays / s), decay);
  }

  // Interval (days) that decays stability `s` down to requestRetention.
  function intervalDays(s) {
    const iv = (s / factor) * (Math.pow(requestRetention, 1 / decay) - 1);
    return iv;
  }

  function initStability(grade) {
    return clampS(w[grade - 1]);
  }
  function initDifficulty(grade) {
    return clampD(w[4] - Math.exp(w[5] * (grade - 1)) + 1);
  }

  function nextDifficulty(d, grade) {
    const deltaD = -w[6] * (grade - 3);
    const damped = d + deltaD * ((10 - d) / 9); // linear damping
    const reverted = w[7] * initDifficulty(EASY) + (1 - w[7]) * damped; // mean reversion
    return clampD(reverted);
  }

  function nextStabilityRecall(d, s, r, grade) {
    const hard = grade === HARD ? w[15] : 1;
    const easy = grade === EASY ? w[16] : 1;
    const sInc =
      Math.exp(w[8]) *
      (11 - d) *
      Math.pow(s, -w[9]) *
      (Math.exp(w[10] * (1 - r)) - 1) *
      hard *
      easy;
    return clampS(s * (1 + sInc));
  }

  function nextStabilityForget(d, s, r) {
    const sf =
      w[11] *
      Math.pow(d, -w[12]) *
      (Math.pow(s + 1, w[13]) - 1) *
      Math.exp(w[14] * (1 - r));
    return clampS(Math.min(sf, s)); // a lapse never increases stability
  }

  function shortTermStability(s, grade) {
    let sinc = Math.exp(w[17] * (grade - 3 + w[18])) * Math.pow(s, -w[19]);
    if (grade >= GOOD) sinc = Math.max(sinc, 1); // Good/Easy same-day must not shrink S
    return clampS(s * sinc);
  }

  function fuzzDays(days, rng) {
    if (days < 3 || !rng) return days;
    const f = 0.95 + rng() * 0.1; // +/-5%
    return Math.max(days, Math.round(days * f));
  }

  // Returns the next card state after reviewing `card` with `grade`.
  // card: { state, stability, difficulty, due, last_review, reps, lapses } (all optional for a new card)
  // opts: { now, rng }  -> rng() in [0,1) enables fuzz; omit for deterministic output.
  function review(card, grade, opts = {}) {
    const now = opts.now ?? Date.now();
    const isNew = !card || card.last_review == null;
    const c = {
      stability: card?.stability,
      difficulty: card?.difficulty,
      reps: card?.reps ?? 0,
      lapses: card?.lapses ?? 0,
    };

    if (isNew) {
      c.stability = initStability(grade);
      c.difficulty = initDifficulty(grade);
    } else {
      const elapsedDays = Math.max(0, (now - card.last_review) / DAY);
      const r = retrievability(elapsedDays, card.stability);
      c.difficulty = nextDifficulty(card.difficulty, grade);
      if (elapsedDays < 1) {
        c.stability = shortTermStability(card.stability, grade);
      } else if (grade === AGAIN) {
        c.stability = nextStabilityForget(card.difficulty, card.stability, r);
        c.lapses += 1;
      } else {
        c.stability = nextStabilityRecall(card.difficulty, card.stability, r);
      }
    }
    c.reps += 1;

    const ivDays = intervalDays(c.stability);
    // Sub-day intervals (always the case for Again) reappear later this session.
    if (grade === AGAIN || ivDays < 1) {
      c.requeue = true;
      c.due = now;
      c.scheduledDays = 0;
    } else {
      c.requeue = false;
      const days = Math.min(fuzzDays(Math.round(ivDays), opts.rng), maximumInterval);
      c.due = now + days * DAY;
      c.scheduledDays = days;
    }
    c.state = 'review';
    c.last_review = now;
    return c;
  }

  // Human-readable interval each button would produce, for on-button hints.
  function preview(card, now = Date.now()) {
    const out = {};
    for (const g of [AGAIN, HARD, GOOD, EASY]) {
      const next = review(card, g, { now }); // no rng -> deterministic
      out[g] = next.scheduledDays; // 0 means "again this session"
    }
    return out;
  }

  return {
    review,
    preview,
    retrievability,
    intervalDays,
    params: { w, requestRetention, maximumInterval, decay, factor },
  };
}
