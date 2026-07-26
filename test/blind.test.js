import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPairs, manifestFor, keyFor, tally, agreementStats, sideBalance,
  wilsonInterval, beatsChance, exactBinomialP,
} from '../src/blind.js';

const ITEMS = ['hero', 'seam', 'wide', 'offaxis'];
const CANDS = ['alpha', 'beta'];

// ---------------------------------------------------------------- blinding

test('blinding is reproducible from the seed', () => {
  const a = buildPairs(CANDS, ITEMS, 'seed-1');
  const b = buildPairs(CANDS, ITEMS, 'seed-1');
  assert.deepEqual(a, b);
});

test('a different seed produces a different assignment', () => {
  const a = buildPairs(CANDS, ITEMS, 'seed-1');
  const b = buildPairs(CANDS, ITEMS, 'seed-2');
  assert.notDeepEqual(a.map((p) => p.candidateSide), b.map((p) => p.candidateSide));
});

test('blinding does not depend on input ORDER — only on content', () => {
  const a = buildPairs(['alpha', 'beta'], ['hero', 'wide'], 's');
  const b = buildPairs(['beta', 'alpha'], ['wide', 'hero'], 's');
  assert.deepEqual(a, b, 'directory listing order must not change the blinding');
});

test('every pair assigns the two sides to different images', () => {
  for (const p of buildPairs(CANDS, ITEMS, 's')) {
    assert.notEqual(p.candidateSide, p.referenceSide);
    assert.ok(['left', 'right'].includes(p.candidateSide));
  }
});

test('the manifest leaks nothing about which side is which', () => {
  const pairs = buildPairs(CANDS, ITEMS, 's');
  const json = JSON.stringify(manifestFor(pairs));
  assert.ok(!json.includes('candidateSide'));
  assert.ok(!json.includes('referenceSide'));
  // pairId contains the candidate name by design (judges compare against a
  // reference, not against each other), but never the side.
  assert.ok(!/"(left|right)"/.test(json));
});

test('the key round-trips the seed so a result can be re-derived', () => {
  const pairs = buildPairs(CANDS, ITEMS, 'audit-me');
  const key = keyFor(pairs, 'audit-me');
  assert.equal(key.seed, 'audit-me');
  assert.deepEqual(buildPairs(CANDS, ITEMS, key.seed), key.pairs);
});

// ---------------------------------------------------------------- tally

const keyOf = (cands = CANDS, items = ITEMS, seed = 's') =>
  keyFor(buildPairs(cands, items, seed), seed);

/** Verdicts where `winners` always beat the reference and others always lose. */
function verdictsWhere(key, judges, winners) {
  const out = [];
  for (const judge of judges) {
    for (const p of key.pairs) {
      const wins = winners.includes(p.candidate);
      out.push({ pairId: p.pairId, judge, choice: wins ? p.candidateSide : p.referenceSide });
    }
  }
  return out;
}

test('a candidate that always wins scores 1.0 and one that always loses scores 0', () => {
  const key = keyOf();
  const r = tally(key, verdictsWhere(key, ['j1', 'j2'], ['alpha']));
  const alpha = r.candidates.find((c) => c.name === 'alpha');
  const beta = r.candidates.find((c) => c.name === 'beta');
  assert.equal(alpha.winRate, 1);
  assert.equal(beta.winRate, 0);
  assert.equal(alpha.n, ITEMS.length * 2);
});

test('the confidence interval narrows as n grows', () => {
  const small = keyOf(['a'], ['hero'], 's');
  const large = keyOf(['a'], ITEMS, 's');
  const rs = tally(small, verdictsWhere(small, ['j1'], ['a']));
  const rl = tally(large, verdictsWhere(large, ['j1', 'j2', 'j3'], ['a']));
  assert.ok(rl.candidates[0].ci95.width < rs.candidates[0].ci95.width);
});

test('unknown pairIds and invalid choices are reported, not silently dropped', () => {
  const key = keyOf();
  const r = tally(key, [
    { pairId: 'nope--hero', judge: 'j', choice: 'left' },
    { pairId: key.pairs[0].pairId, judge: 'j', choice: 'sideways' },
    { pairId: key.pairs[1].pairId, judge: 'j', choice: 'left' },
  ]);
  assert.equal(r.unknownPairIds.length, 2);
});

// ---------------------------------------------------------------- the checks that matter

test('position bias fires when judges always pick left regardless of content', () => {
  const key = keyOf();
  const verdicts = key.pairs.map((p) => ({ pairId: p.pairId, judge: 'j1', choice: 'left' }));
  const r = tally(key, verdicts);
  assert.equal(r.positionBias.leftRate, 1);
  assert.equal(r.positionBias.suspect, true,
    'a panel that always picks left must be flagged — its win rates are meaningless');
});

test('position bias does NOT fire on a balanced run', () => {
  const key = keyOf();
  const r = tally(key, verdictsWhere(key, ['j1', 'j2'], ['alpha']));
  assert.equal(r.positionBias.suspect, false);
});

test('agreement near chance is flagged', () => {
  // Two judges answering in exact opposition: agreement 0, which is as far from
  // a shared signal as it gets — but the mean is 0, not 0.5, so nearChance is
  // false. Perfect disagreement is itself a signal (of an inverted rubric), and
  // conflating it with noise would hide that.
  const key = keyOf();
  const verdicts = [];
  for (const p of key.pairs) {
    verdicts.push({ pairId: p.pairId, judge: 'j1', choice: 'left' });
    verdicts.push({ pairId: p.pairId, judge: 'j2', choice: 'right' });
  }
  const r = tally(key, verdicts);
  assert.equal(r.agreement.meanPairwiseAgreement, 0);
  assert.equal(r.agreement.nearChance, false);
});

test('a coin-flipping panel is flagged as near chance', () => {
  const key = keyOf(['a'], ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'], 'x');
  const verdicts = [];
  key.pairs.forEach((p, i) => {
    verdicts.push({ pairId: p.pairId, judge: 'j1', choice: 'left' });
    // j2 agrees on exactly half — the definition of no shared signal.
    verdicts.push({ pairId: p.pairId, judge: 'j2', choice: i % 2 ? 'left' : 'right' });
  });
  const r = tally(key, verdicts);
  assert.equal(r.agreement.meanPairwiseAgreement, 0.5);
  assert.equal(r.agreement.nearChance, true);
});

test('agreement is computed only over pairs both judges actually answered', () => {
  const perJudge = new Map([
    ['j1', new Map([['p1', true], ['p2', false], ['p3', true]])],
    ['j2', new Map([['p1', true], ['p2', false]])],
  ]);
  const s = agreementStats(perJudge);
  assert.equal(s.pairwise[0].overlap, 2, 'p3 was not answered by j2 and must not count');
  assert.equal(s.pairwise[0].agreement, 1);
});

test('a single judge yields no agreement statistic rather than a fake one', () => {
  const key = keyOf();
  const r = tally(key, verdictsWhere(key, ['solo'], ['alpha']));
  assert.equal(r.agreement.pairwise.length, 0);
  assert.equal(r.agreement.meanPairwiseAgreement, null);
  assert.equal(r.agreement.nearChance, false);
});

// ---------------------------------------------------------------- side balance

test('side assignment is BALANCED by construction, not by luck', () => {
  // The regression this guards: independent coin flips per pair look correct and
  // are not. With six items, all-same-side has probability 1/32, and when it
  // happens the candidate is perfectly confounded with position — the exact
  // failure this package exists to detect. It was hit on the first smoke run.
  for (const n of [2, 4, 6, 8, 20]) {
    const items = Array.from({ length: n }, (_, i) => `item${i}`);
    const b = sideBalance(buildPairs(['a', 'b'], items, 'any-seed'));
    assert.equal(b.worstSkew, 0, `n=${n} produced an unbalanced assignment`);
  }
});

test('odd item counts skew by at most one', () => {
  for (const n of [1, 3, 5, 7]) {
    const items = Array.from({ length: n }, (_, i) => `item${i}`);
    const b = sideBalance(buildPairs(['a', 'b'], items, 's'));
    assert.ok(b.worstSkew <= 1, `n=${n} skewed by ${b.worstSkew}`);
  }
});

test('balance holds for EVERY seed, not just a lucky one', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (let i = 0; i < 50; i++) {
    assert.equal(sideBalance(buildPairs(['x'], items, `seed-${i}`)).worstSkew, 0);
  }
});

test('balanced does not mean predictable — sides still vary by seed', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    seen.add(buildPairs(['x'], items, `s${i}`).map((p) => p.candidateSide).join(''));
  }
  assert.ok(seen.size > 5, 'assignment is too predictable across seeds');
});

// ---------------------------------------------------------------- Wilson intervals

test('Wilson stays inside [0,1] across the whole range', () => {
  for (const n of [1, 2, 3, 5, 10, 40, 100, 1000]) {
    for (let w = 0; w <= n; w++) {
      const ci = wilsonInterval(w, n);
      assert.ok(ci.lower >= 0, `lower ${ci.lower} < 0 at ${w}/${n}`);
      assert.ok(ci.upper <= 1, `upper ${ci.upper} > 1 at ${w}/${n}`);
      assert.ok(ci.lower <= ci.upper, `inverted at ${w}/${n}`);
    }
  }
});

test('Wilson does NOT collapse to zero width at the extremes', () => {
  // This is the whole reason for not using the normal approximation: at 0 or n
  // wins, p(1-p) is 0, so the textbook interval reports "100%, +/-0" from a
  // handful of comparisons. That is a missing estimate presented as a certain one.
  for (const n of [3, 4, 10, 40]) {
    const all = wilsonInterval(n, n);
    const none = wilsonInterval(0, n);
    assert.ok(all.width > 0.05, `n=${n}: all-wins width ${all.width} is implausibly tight`);
    assert.ok(none.width > 0.05, `n=${n}: no-wins width ${none.width} is implausibly tight`);
    assert.equal(all.upper, 1);
    assert.equal(none.lower, 0);
    assert.ok(all.lower < 1, 'a perfect record must not have lower bound 1');
    assert.ok(none.upper > 0, 'a zero record must not have upper bound 0');
  }
});

test('Wilson narrows monotonically as n grows at a fixed proportion', () => {
  let prev = Infinity;
  for (const n of [8, 16, 40, 100, 400, 1000]) {
    const ci = wilsonInterval(Math.round(n * 0.75), n);
    assert.ok(ci.width < prev, `width did not shrink at n=${n}`);
    prev = ci.width;
  }
});

test('Wilson is asymmetric near the extremes — which is why we report both bounds', () => {
  const ci = wilsonInterval(9, 10); // p̂ = 0.9
  const below = 0.9 - ci.lower;
  const above = ci.upper - 0.9;
  assert.ok(Math.abs(below - above) > 0.02,
    'expected a visibly asymmetric interval; collapsing it to ± would discard that');
});

test('Wilson converges on the point estimate for large n', () => {
  const ci = wilsonInterval(7000, 10000);
  assert.ok(Math.abs((ci.lower + ci.upper) / 2 - 0.7) < 0.01);
  assert.ok(ci.width < 0.02);
});

test('beatsChance refuses to call a result that spans a coin flip', () => {
  const bc = (w, n) => beatsChance(wilsonInterval(w, n), w, n);
  assert.equal(bc(8, 11), 'inconclusive');   // 72.7%, interval spans 0.5
  assert.equal(bc(3, 4), 'inconclusive');    // 75%, tiny n
  assert.equal(bc(80, 110), 'better');       // same 72.7%, real n
  assert.equal(bc(30, 110), 'worse');
  // The case that motivated the exact test: Wilson alone calls this 'better'
  // (lower bound 0.5101); the exact two-sided p is 0.125.
  assert.ok(wilsonInterval(4, 4).lower > 0.5, 'precondition: Wilson excludes 0.5 here');
  assert.equal(exactBinomialP(4, 4), 0.125);
  assert.equal(bc(4, 4), 'inconclusive', 'four wins out of four is a coin flip one time in eight');
});

test('tally reports a Wilson interval and a verdict per candidate', () => {
  const key = keyOf();
  const r = tally(key, verdictsWhere(key, ['j1', 'j2'], ['alpha']));
  const alpha = r.candidates.find((c) => c.name === 'alpha');
  assert.equal(alpha.ci95.method, 'wilson');
  assert.ok(alpha.ci95.lower > 0 && alpha.ci95.upper === 1);
  assert.ok(['better', 'worse', 'inconclusive'].includes(alpha.verdict));
});

test('a small perfect record is reported as inconclusive, not as certainty', () => {
  // 4 items, 1 judge, candidate wins every pair. Point estimate 100%.
  const key = keyOf(['solo'], ['a', 'b', 'c', 'd'], 's');
  const r = tally(key, verdictsWhere(key, ['j1'], ['solo']));
  const c = r.candidates[0];
  assert.equal(c.winRate, 1);
  assert.ok(c.ci95.lower < 0.6,
    'four wins out of four must not be reported as a confident result');
  assert.equal(c.verdict, 'inconclusive');
});
