#!/usr/bin/env node
/**
 * blind-panel — blind pairwise evaluation.
 *
 *   blind-panel prepare --candidates=a,b --items=hero,wide --out=DIR [--seed=S]
 *   blind-panel prepare --candidates=dirA,dirB --reference=dirRef --out=DIR
 *   blind-panel tally   --dir=DIR --verdicts=verdicts.json
 *
 * PREPARE writes manifest.json (give this to judges) and key.json (withhold it
 * until verdicts are in).
 *
 * TALLY unblinds and reports win rate with a confidence interval, a
 * position-bias check, and inter-rater agreement. It exits non-zero if either
 * check fires, because a run with position bias or chance-level agreement has
 * not measured anything and should not be reported as though it had.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { buildPairs, manifestFor, keyFor, tally, problemsWith, sideBalance } from '../src/blind.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = Object.fromEntries(argv.slice(1).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));

const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const USAGE = `blind-panel — blind pairwise evaluation

  blind-panel prepare --candidates=a,b --items=x,y --out=DIR [--seed=S]
  blind-panel prepare --candidates=dirA,dirB --reference=dirRef --out=DIR [--seed=S]
  blind-panel tally   --dir=DIR --verdicts=verdicts.json

verdicts.json is [{ "pairId": "...", "judge": "...", "choice": "left"|"right" }]`;

// ---------------------------------------------------------------- prepare
if (cmd === 'prepare') {
  const outDir = resolve(args.out ?? './blind-run');
  const seed = String(args.seed ?? 'blind-panel');
  const rawCandidates = list(args.candidates);
  if (!rawCandidates.length) die('--candidates is required\n\n' + USAGE);

  let names = rawCandidates;
  let items = list(args.items);
  let dirMode = false;

  // Directory mode: candidate names come from directory basenames, and items
  // are the files present in EVERY candidate as well as the reference.
  if (args.reference) {
    dirMode = true;
    const refDir = resolve(args.reference);
    const candDirs = rawCandidates.map((d) => resolve(d));
    for (const d of [...candDirs, refDir]) {
      if (!existsSync(d) || !statSync(d).isDirectory()) die(`not a directory: ${d}`);
    }
    names = candDirs.map((d) => basename(d));
    const refItems = readdirSync(refDir).filter((f) => !f.startsWith('.')).sort();
    const common = refItems.filter((f) => candDirs.every((d) => existsSync(join(d, f))));
    const dropped = refItems.filter((f) => !common.includes(f));

    if (!common.length) die('no filenames common to the reference and every candidate');
    items = common;

    // Loud, never silent. Comparing a candidate on an item another candidate
    // lacks would weight the panel without anyone noticing.
    if (dropped.length) {
      console.error(`NOTE: dropped ${dropped.length} item(s) not present in every candidate: ${dropped.join(', ')}`);
    }
  }

  if (!items.length) die('--items is required unless --reference is given\n\n' + USAGE);

  const pairs = buildPairs(names, items, seed);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifestFor(pairs), null, 2));
  writeFileSync(join(outDir, 'key.json'), JSON.stringify(keyFor(pairs, seed), null, 2));

  console.log(JSON.stringify({
    out: outDir,
    mode: dirMode ? 'directory' : 'explicit',
    candidates: names,
    items,
    pairs: pairs.length,
    sideBalance: sideBalance(pairs),
    seed,
    note: 'Judges get manifest.json. Withhold key.json until verdicts are in.',
  }, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------- tally
if (cmd === 'tally') {
  const dir = args.dir ? resolve(args.dir) : null;
  const keyPath = args.key ? resolve(args.key) : (dir ? join(dir, 'key.json') : null);
  if (!keyPath || !existsSync(keyPath)) die('--key=key.json (or --dir=DIR) is required\n\n' + USAGE);
  if (!args.verdicts) die('--verdicts=verdicts.json is required\n\n' + USAGE);

  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  const verdicts = JSON.parse(readFileSync(resolve(args.verdicts), 'utf8'));
  if (!Array.isArray(verdicts)) die('verdicts.json must be an array of {pairId, judge, choice}');

  const result = tally(key, verdicts);
  console.log(JSON.stringify(result, null, 2));

  const problems = problemsWith(result);
  if (problems.length) {
    console.error('\nPROBLEMS:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.error('\nOK: no position bias, agreement above chance.');
  process.exit(0);
}

die(USAGE);
