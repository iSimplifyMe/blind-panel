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
    .map(([name, { wins, n }]) => ({
      name, wins, n,
      winRate: n ? +(wins / n).toFixed(4) : 0,
      // Normal-approximation half-width at 95%, so 3-of-4 is visibly not the
      // same claim as 30-of-40.
      ci95: n ? +(1.96 * Math.sqrt(0.25 / n)).toFixed(4) : 1,
    }))
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
