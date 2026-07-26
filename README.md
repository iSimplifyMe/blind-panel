# blind-panel

Blind pairwise evaluation — seeded blinding, position-bias detection, and
inter-rater agreement.

**The win rate is the number everyone quotes and the number that means least.**

```bash
npx blind-panel prepare --candidates=a,b --items=one,two,three --out=./run --seed=r1
# judges see run/manifest.json — never run/key.json
npx blind-panel tally --dir=./run --verdicts=./verdicts.json
```

Zero dependencies. MIT.

## Why

When you put candidates in front of a panel — human or model — and ask which is
better, two numbers decide whether the answer means anything, and neither is
usually reported:

**Position bias.** If judges chose "left" far from half the time, they were
responding to position rather than content, and every win rate is void. Trivial
to compute. Almost never computed.

**Inter-rater agreement.** Near chance means the panel detected no shared signal,
so the win rate is noise however decisive it looks. High agreement means *either*
a real difference *or* a bias the judges share — this statistic cannot separate
those, and the tool says so rather than letting the ambiguity pass for rigour.

Either condition exits non-zero, because a run that failed them has not measured
anything and should not be reported as though it had.

Confidence intervals ship alongside, because 3-of-4 and 30-of-40 are not the same
claim. At n=6 the interval is ±0.40 — the tool telling you plainly that six
samples says almost nothing.

## What it does not do

**It does not judge.** It handles blinding, randomisation, unblinding and
statistics; who or what looks at the candidates is yours. That separation is the
point: anyone holding the seed can re-derive the assignment and check the
arithmetic instead of trusting your summary.

## Balanced by construction

Side assignment is not an independent coin flip per pair. With six items, pure
random puts every one on the same side about 3% of the time — and when it does,
the candidate's identity is perfectly confounded with position, which is exactly
the failure this package exists to detect.

Instead each candidate gets an equal number of left and right placements, shuffled
by a seeded Fisher-Yates. Balance is guaranteed; the individual assignment is
still unpredictable.

*(This was found by the first smoke run of this package producing
`candidateLeft: 6, candidateRight: 0`. It is now a regression test.)*

## Usage

### Explicit items

```bash
blind-panel prepare --candidates=modelA,modelB --items=q1,q2,q3 --out=./run --seed=run-1
```

### Directory mode

Candidate names come from directory basenames; items are the files present in
every candidate *and* the reference. Anything missing from a candidate is dropped
**loudly** — comparing a candidate on an item another candidate lacks would weight
the panel silently.

```bash
blind-panel prepare --candidates=./out/a,./out/b --reference=./out/ref --out=./run
```

### Verdicts

```json
[
  { "pairId": "modelA--q1", "judge": "alice", "choice": "left" },
  { "pairId": "modelA--q1", "judge": "bob",   "choice": "right" }
]
```

```bash
blind-panel tally --dir=./run --verdicts=./verdicts.json
```

Exit 0 means the run is usable. Exit 1 means it is not, and says why.

### As a library

```js
import { buildPairs, tally, problemsWith, sideBalance } from 'blind-panel';
```

## Origin

Extracted from a project that needed to judge three candidate visual designs and
wanted the judging to be worth something. The methodology owes a debt to
[mshumer/Claude-of-Duty](https://github.com/mshumer/Claude-of-Duty), which ran
eleven critics in blind A/B against real reference frames and published the
result honestly — but shipped no tooling for it. This is that procedure made
executable and checkable.

## License

MIT © iSimplifyMe
