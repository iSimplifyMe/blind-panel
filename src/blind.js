/**
 * Blind pairwise evaluation.
 *
 * WHAT THIS IS FOR. When you put candidates in front of a panel — human or model
 * — and ask which is better, the number everyone quotes is the win rate, and it
 * is the number that means least. Two others decide whether it means anything at
 * all:
 *
 *   POSITION BIAS. If judges chose "left" far from half the time, they were
 *   responding to position rather than content, and every win rate is void.
 *   Trivial to compute. Almost never reported.
 *
 *   INTER-RATER AGREEMENT. Near chance means the panel detected no shared
 *   signal, so the win rate is noise however decisive it looks. High agreement
 *   means EITHER a real difference OR a bias the judges share — this statistic
 *   cannot separate those, and pretending otherwise is the standard way blind
 *   panels get oversold.
 *
 * WHAT THIS IS NOT. It does not judge. It handles blinding, randomisation,
 * unblinding and statistics; who or what looks at the candidates is yours to
 * decide. That separation is what makes a published result auditable — anyone
 * holding the seed re-derives the assignment and checks the arithmetic instead
 * of trusting it.
 *
 * Zero dependencies. Everything here is pure and seeded.
 */

// ---------------------------------------------------------------- seeded rng

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function sfc32(a, b, c, d) {
  return function () {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Deterministic PRNG from a string seed. Same seed, same sequence, anywhere. */
export function makeRng(seed = 'blind-panel') {
  const h = xmur3(String(seed));
  return sfc32(h(), h(), h(), h());
}

// ---------------------------------------------------------------- blinding

/**
 * Build the blinded pair list: one pair per (candidate, item), candidate against
 * the reference for that item. Which side the candidate lands on comes from a
 * seeded stream — random to the judge, reproducible to an auditor.
 *
 * Inputs are SORTED before the stream is consumed. Without that, "the same seed
 * reproduces the same blinding" would silently depend on directory listing order
 * or object key order, which is not a guarantee at all.
 */
export function buildPairs(candidates, items, seed = 'blind-panel') {
  const sortedItems = [...items].sort();
  const pairs = [];

  for (const candidate of [...candidates].sort()) {
    // BALANCED BY CONSTRUCTION, not by hoping a coin flip evens out.
    //
    // Independent coin flips per pair look correct and are not. With six items
    // the probability of landing every one on the same side is 1/32, and when it
    // happens the candidate's identity is perfectly confounded with position —
    // which is precisely the failure this tool exists to detect. It was hit on
    // the first smoke run of this package.
    //
    // Instead: build a list that is half "left" and half "right" (odd counts
    // take the extra side from the stream, so balance stays even ACROSS
    // candidates rather than always favouring one side), then shuffle it. Every
    // candidate now gets the same number of left and right placements, and the
    // judge still cannot predict any individual pair.
    const rng = makeRng(`${seed}::sides::${candidate}`);
    const n = sortedItems.length;
    const half = Math.floor(n / 2);
    const sides = [
      ...Array(half).fill('left'),
      ...Array(half).fill('right'),
      ...(n % 2 ? [rng() < 0.5 ? 'left' : 'right'] : []),
    ];

    // Fisher-Yates, seeded.
    for (let i = sides.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [sides[i], sides[j]] = [sides[j], sides[i]];
    }

    sortedItems.forEach((item, i) => {
      const candidateSide = sides[i];
      pairs.push({
        pairId: `${candidate}--${item}`,
        candidate,
        item,
        candidateSide,
        referenceSide: candidateSide === 'left' ? 'right' : 'left',
      });
    });
  }
  return pairs;
}

/**
 * Per-candidate side balance. Returned by prepare so a degenerate assignment is
 * visible before judging starts rather than discovered afterwards.
 */
export function sideBalance(pairs) {
  const per = new Map();
  for (const p of pairs) {
    if (!per.has(p.candidate)) per.set(p.candidate, { left: 0, right: 0 });
    per.get(p.candidate)[p.candidateSide] += 1;
  }
  const rows = [...per.entries()].map(([candidate, { left, right }]) => ({
    candidate, left, right, skew: Math.abs(left - right),
  })).sort((a, b) => a.candidate.localeCompare(b.candidate));
  return { perCandidate: rows, worstSkew: rows.reduce((m, r) => Math.max(m, r.skew), 0) };
}

/** What the judge may see. Carries no hint of which side is which. */
export function manifestFor(pairs) {
  return {
    pairs: pairs.map((p) => ({ pairId: p.pairId })),
    instructions:
      'For each pair, two candidates are shown as "left" and "right". Decide which ' +
      'is better against the stated criterion and answer "left" or "right". You are ' +
      'not told which is which, and the assignment differs per pair. Answer every pair.',
  };
}

/** The sealed key. Write it separately and withhold it until verdicts are in. */
export function keyFor(pairs, seed) {
  return { seed, pairs };
}

// ---------------------------------------------------------------- intervals

/**
 * Wilson score interval for a binomial proportion.
 *
 * WHY NOT THE NORMAL APPROXIMATION. The textbook `p ± z·sqrt(p(1-p)/n)` fails
 * exactly where evaluation panels live — small n and lopsided results:
 *
 *   - At 0 wins or n wins it collapses to zero width, reporting a result of
 *     "100%, ±0" from four comparisons. That is not a tight estimate; it is a
 *     missing one.
 *   - It routinely produces bounds below 0 or above 1, which are not
 *     probabilities.
 *   - Its actual coverage at n < 40 is well below the nominal 95%, so it
 *     overstates confidence precisely when a reader most needs the opposite.
 *
 * Wilson is bounded in [0,1] by construction, stays sensible at the extremes,
 * and has far better small-sample coverage. It is asymmetric — the interval
 * around 0.9 is not centred on 0.9 — so `lower` and `upper` are reported
 * rather than a single ± figure, because collapsing an asymmetric interval to
 * a symmetric one throws away the part that matters.
 *
 * @param {number} wins successes
 * @param {number} n trials
 * @param {number} z standard-normal quantile; 1.96 ≈ 95%
 */
export function wilsonInterval(wins, n, z = 1.96) {
  if (!n) return { lower: 0, upper: 1, width: 1, method: 'wilson', z };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lower = Math.max(0, centre - margin);
  const upper = Math.min(1, centre + margin);
  return {
    lower: +lower.toFixed(4),
    upper: +upper.toFixed(4),
    width: +(upper - lower).toFixed(4),
    method: 'wilson',
    z,
  };
}

/** log(n!) by summation. Exact enough for any panel size, no special functions. */
function logFactorial(n) {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * EXACT two-sided binomial p-value against a fair coin.
 *
 * Wilson is the right interval to report, but it is still an approximation, and
 * at very small n it is slightly LIBERAL at the extremes. Concretely: a perfect
 * 4-of-4 record gives a Wilson lower bound of 0.5101, which excludes 0.5 and
 * would be called a win — while the exact two-sided p for 4-of-4 is 0.125,
 * nowhere near significant. Four consecutive wins is what a fair coin does one
 * time in eight.
 *
 * A directional claim therefore requires BOTH: an interval that excludes 0.5 and
 * an exact p below the threshold. Belt and braces, because the cost of the two
 * errors is not symmetric — an over-claimed evaluation result is repeated in a
 * deck long after anyone can check it.
 *
 * Computed in log space so it does not overflow on large panels.
 */
export function exactBinomialP(wins, n) {
  if (!n) return 1;
  const w = Math.max(wins, n - wins);   // symmetric under p = 0.5
  if (w === n - w) return 1;
  const lnFacN = logFactorial(n);
  const lnHalfN = n * Math.log(2);
  let tail = 0;
  for (let k = w; k <= n; k++) {
    tail += Math.exp(lnFacN - logFactorial(k) - logFactorial(n - k) - lnHalfN);
  }
  return Math.min(1, +(2 * tail).toFixed(6));
}

/**
 * Is this candidate established as better than the reference?
 *
 * Requires the Wilson interval to exclude 0.5 AND the exact binomial test to
 * reach `alpha`. A win rate of 0.72 whose interval spans 0.43–0.90 has
 * established nothing however large the point estimate looks, and saying so is
 * the entire purpose of reporting an interval.
 */
export function beatsChance(interval, wins, n, alpha = 0.05) {
  const p = exactBinomialP(wins, n);
  if (p >= alpha) return 'inconclusive';
  if (interval.lower > 0.5) return 'better';
  if (interval.upper < 0.5) return 'worse';
  return 'inconclusive';
}

// ---------------------------------------------------------------- tally

/**
 * Resolve verdicts against the key.
 * @param {Array<{pairId:string, judge:string, choice:'left'|'right'}>} verdicts
 */
export function tally(key, verdicts) {
  const byId = new Map(key.pairs.map((p) => [p.pairId, p]));
  const perCandidate = new Map();
  const perJudge = new Map();
  const unknown = [];
  let leftPicks = 0, total = 0;

  for (const v of verdicts) {
    const pair = byId.get(v?.pairId);
    if (!pair || (v.choice !== 'left' && v.choice !== 'right')) { unknown.push(v?.pairId); continue; }

    const candidateWon = v.choice === pair.candidateSide;
    total += 1;
    if (v.choice === 'left') leftPicks += 1;

    if (!perCandidate.has(pair.candidate)) perCandidate.set(pair.candidate, { wins: 0, n: 0 });
    const c = perCandidate.get(pair.candidate);
    c.n += 1;
    if (candidateWon) c.wins += 1;

    if (!perJudge.has(v.judge)) perJudge.set(v.judge, new Map());
    perJudge.get(v.judge).set(v.pairId, candidateWon);
  }

  const candidates = [...perCandidate.entries()]
    .map(([name, { wins, n }]) => {
      const ci95 = wilsonInterval(wins, n);
      return {
        name, wins, n,
        winRate: n ? +(wins / n).toFixed(4) : 0,
        ci95,
        exactP: exactBinomialP(wins, n),
        // The question actually being asked. A win rate whose interval spans
        // 0.5, or whose exact test does not reach 0.05, has not established
        // that the candidate is better however large the point estimate looks.
        verdict: beatsChance(ci95, wins, n),
      };
    })
    .sort((a, b) => b.winRate - a.winRate || a.name.localeCompare(b.name));

  return {
    candidates,
    positionBias: {
      leftPicks, total,
      leftRate: total ? +(leftPicks / total).toFixed(4) : 0,
      suspect: total >= 8 && Math.abs(leftPicks / total - 0.5) > 0.25,
    },
    agreement: agreementStats(perJudge),
    unknownPairIds: unknown,
  };
}

/**
 * Pairwise inter-rater agreement on the unblinded outcome.
 *
 * Computed only over pairs BOTH judges answered — scoring a judge against gaps
 * in another's coverage inflates or deflates agreement for no reason.
 */
export function agreementStats(perJudge) {
  const judges = [...perJudge.keys()].sort();
  const pairwise = [];

  for (let i = 0; i < judges.length; i++) {
    for (let j = i + 1; j < judges.length; j++) {
      const a = perJudge.get(judges[i]);
      const b = perJudge.get(judges[j]);
      let same = 0, n = 0;
      for (const [pairId, outcome] of a) {
        if (!b.has(pairId)) continue;
        n += 1;
        if (b.get(pairId) === outcome) same += 1;
      }
      pairwise.push({ judges: [judges[i], judges[j]], overlap: n, agreement: n ? +(same / n).toFixed(4) : null });
    }
  }

  const scored = pairwise.filter((p) => p.agreement != null);
  const mean = scored.length
    ? +(scored.reduce((s, p) => s + p.agreement, 0) / scored.length).toFixed(4)
    : null;

  return {
    judges,
    pairwise,
    meanPairwiseAgreement: mean,
    /**
     * Below this the panel is not discriminating and the run should be
     * discarded. Note that PERFECT DISAGREEMENT (0) is deliberately not flagged
     * here: it is a signal, usually of an inverted rubric, and conflating it
     * with noise would hide a real and fixable problem.
     */
    nearChance: mean != null && Math.abs(mean - 0.5) < 0.1,
  };
}

/** Problems that invalidate a run. Empty array means the result is usable. */
export function problemsWith(result) {
  const out = [];
  if (result.unknownPairIds.length) {
    out.push(`${result.unknownPairIds.length} verdict(s) referenced an unknown pairId or an invalid choice`);
  }
  if (result.positionBias.suspect) {
    out.push(`POSITION BIAS: judges chose left ${(result.positionBias.leftRate * 100).toFixed(1)}% of the time — ` +
      'they may be responding to position rather than content, which invalidates every win rate above');
  }
  if (result.agreement.nearChance) {
    out.push(`AGREEMENT NEAR CHANCE (${result.agreement.meanPairwiseAgreement}): the panel is not detecting a ` +
      'shared signal, so these win rates are noise however decisive they look');
  }
  return out;
}
