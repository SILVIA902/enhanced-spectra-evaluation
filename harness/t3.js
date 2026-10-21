'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const REPS = Number(arg('reps', '3'));
const TARGETS = Number(arg('targets', '10'));
const KS = arg('ks', '2,5,10,20').split(',').map(Number);
const SUBTESTS = arg('subtests', 'a,b1,b2,c').split(',');
const PREP = Number(arg('prep', '20'));
const CONFIG = arg('config', 'main');
const KMAX = Math.max(...KS);
const OUT = L.resultsDir('T3', CONFIG);

const today = new Date().toISOString().slice(0, 10);
const expiry = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
const PRODUCTION = JSON.stringify({
  product: { name: 'Licorice root', sku: 'BENCH-LQ', category: 'raw' },
  production: { date: today, expiry, qty: { value: '10', unit: 'KG' } },
  dop: { geoZoneOK: true, harvestWindowOK: true, supplierAuthorized: true, varietal: 'bench' } });
const transformation = lq => JSON.stringify({
  processType: 'EXTRACTION', processProfile: 'BENCH_T3', inputLotsCsv: lq,
  qualityOutcome: { dopChecksOK: true } });
const uidT = uid => ({ uidRaw: Buffer.from(uid, 'utf8') });

function pool(label, n) {
  return Array.from({ length: n }, () => {
    const c = L.openClient(label);
    return {
      c,
      origin: c.contract('certificate', 'OriginContract'),
      process: c.contract('certificate', 'ProcessContract'),
      pack: c.contract('certificate', 'PackagingCertContract'),
    };
  });
}
const N_CLIENTS = Math.max(KMAX, PREP);
const farmers = pool('bench-farmer', PREP);
const producers = pool('bench-producer', N_CLIENTS);
const consumers = pool('bench-consumer', N_CLIENTS);

async function runPool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker(w) {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], w);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, (_, w) => worker(w)));
  return out;
}
const prepRows = [];
const prepRetries = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mustSubmit(contract, fn, opts, label) {
  const MAX = 6;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const rec = await L.timedSubmit(contract, fn, opts);
    rec.client = label;
    prepRows.push(rec);
    if (rec.status === 'VALID') return JSON.parse(rec.result);
    const reason = `${fn}:${rec.failure}`;
    prepRetries[reason] = (prepRetries[reason] || 0) + 1;
    if (attempt === MAX) throw new Error(`preparation failed: ${fn} ${rec.failure} ${rec.errorText.slice(0, 200)}`);
    await sleep(100 * 2 ** (attempt - 1));
  }
}
async function makeLQ(w) {
  const f = farmers[w % farmers.length];
  const o = await mustSubmit(f.origin, 'RegisterProduction', { args: [PRODUCTION] }, 'prep-farmer');
  return o.lotCodes[0];
}
async function makePackage(w) {
  const lq = await makeLQ(w);
  const p = producers[w % producers.length];
  const tr = await mustSubmit(p.process, 'RegisterTransformation', { args: [transformation(lq)] }, 'prep-producer');
  const pkg = await mustSubmit(p.pack, 'CreatePackageForLot', { args: [tr.output, ''] }, 'prep-producer');
  return pkg.packageId;
}
async function makeBoundUID(w) {
  const pkgId = await makePackage(w);
  const uid = L.randomUID();
  const p = producers[w % producers.length];
  await mustSubmit(p.pack, 'RegisterBindingForPackage',
    { args: [JSON.stringify({ packageId: pkgId })], transient: uidT(uid) }, 'prep-producer');
  return uid;
}
function outcome(rec, sub) {
  if (rec.status === 'VALID') {
    if (sub === 'a') {
      const o = JSON.parse(rec.result);
      if (o.status === 'CONSUMED') return 'COMMITTED';
      if (o.status === 'ALREADY_CONSUMED') return 'REPEATED_SCAN';
      return 'VALID_OTHER';
    }
    return 'COMMITTED';
  }
  if (rec.status === 'MVCC_READ_CONFLICT') return 'MVCC_CONFLICT';
  if (rec.status === 'ERROR' && rec.failure.startsWith('ENDORSE:ERROR_')) return `REJECTED_${rec.failure.slice(8)}`;
  return `OTHER_${rec.failure || rec.status}`;
}
async function evalJson(contract, fn, opts) {
  const rec = await L.timedEvaluate(contract, fn, opts);
  return rec.status === 'OK' ? { ok: true, obj: JSON.parse(rec.result) } : { ok: false, code: rec.failure };
}

const plan = [];
for (let rep = 1; rep <= REPS; rep++) {
  for (const sub of SUBTESTS) {
    for (const k of KS) {
      for (let t = 1; t <= TARGETS; t++) plan.push({ rep, sub, k, t });
    }
  }
}
const need = { a: 0, b1: 0, b2: 0, c: 0 };
for (const p of plan) {
  if (p.sub === 'a') need.a += 1;
  if (p.sub === 'b1') need.b1 += p.k;
  if (p.sub === 'b2') need.b2 += 1;
  if (p.sub === 'c') need.c += 1;
}

async function main() {
  const t0 = Date.now();
  console.log(`T3 ${CONFIG}: ${plan.length} targets (rep ${REPS}, ${TARGETS} per k, k = ${KS.join(',')}, ` +
    `subtests ${SUBTESTS.join(',')})`);
  console.log(`Preparation (${PREP} parallel streams): ${need.a} bound UIDs, ${need.b1 + need.b2} package, ` +
    `${need.c} LQ lots`);

  const tp = Date.now();
  const assets = {
    a: await runPool(Array(need.a).fill(0), PREP, (_, w) => makeBoundUID(w)),
    b: await runPool(Array(need.b1 + need.b2).fill(0), PREP, (_, w) => makePackage(w)),
    c: await runPool(Array(need.c).fill(0), PREP, (_, w) => makeLQ(w)),
  };
  const prepSec = (Date.now() - tp) / 1000;
  const prepValid = prepRows.filter(r => r.status === 'VALID').length;
  console.log(`Preparation completed in ${prepSec.toFixed(1)} s: ${prepValid} valid transactions ` +
    `(${(prepValid / prepSec).toFixed(1)} TPS), ${prepRows.length - prepValid} retried`);
  if (Object.keys(prepRetries).length) console.log(`  retry reasons: ${JSON.stringify(prepRetries)}`);
  fs.writeFileSync(path.join(OUT, 'prep.csv'),
    [L.CSV_HEADER, ...prepRows.map((r, i) => L.csvRow({ test: 'T3', config: CONFIG, run: 0 }, i + 1, r))]
      .join('\n') + '\n');

  await sleep(3000);
  const cursor = { a: 0, b: 0, c: 0 };
  const attemptRows = ['subtest,k,rep,target,client,t0_epoch_ms,l_e2e_ms,status,failure_class,outcome'];
  const targetRows = ['subtest,k,rep,target,committed,repeated_scans,mvcc,rejected,other,release_spread_ms,' +
    'completion_ms,postcheck_ok,safety_ok,detail'];
  const summary = {};

  for (const [n, p] of plan.entries()) {
    const verifier = consumers[0];
    let recs = [], post = { ok: false, detail: '' };

    if (p.sub === 'a') {
      const uid = assets.a[cursor.a++];
      recs = await Promise.all(Array.from({ length: p.k }, (_, i) =>
        L.timedSubmit(consumers[i].pack, 'ConsumeByUID', { transient: uidT(uid) })));
      const scans = recs.filter(r => outcome(r, 'a') === 'REPEATED_SCAN').length;
      const v = await evalJson(verifier.pack, 'VerifyByUID', { transient: uidT(uid) });
      post.ok = v.ok && v.obj.status === 'CONSUMED' && v.obj.repeatedScans === scans;
      post.detail = v.ok ? `state=${v.obj.status} scans=${v.obj.repeatedScans}` : v.code;
    }

    if (p.sub === 'b1') {
      const uid = L.randomUID();
      const pkgs = assets.b.slice(cursor.b, cursor.b + p.k); cursor.b += p.k;
      recs = await Promise.all(pkgs.map((pkg, i) =>
        L.timedSubmit(producers[i].pack, 'RegisterBindingForPackage',
          { args: [JSON.stringify({ packageId: pkg })], transient: uidT(uid) })));
      const win = recs.findIndex(r => r.status === 'VALID');
      const v = await evalJson(verifier.pack, 'VerifyByUID', { transient: uidT(uid) });
      let losersOk = true;
      for (let i = 0; i < pkgs.length; i++) {
        if (i === win) continue;
        const g = await evalJson(verifier.pack, 'GetPackage', { args: [pkgs[i]] });
        if (!g.ok || g.obj.state !== 'VALID') losersOk = false;
      }
      post.ok = win >= 0 && v.ok && v.obj.packageId === pkgs[win] && losersOk;
      post.detail = `winnerPkgMatch=${v.ok && win >= 0 && v.obj.packageId === pkgs[win]} losersUnbound=${losersOk}`;
    }

    if (p.sub === 'b2') {
      const pkg = assets.b[cursor.b++];
      const uids = Array.from({ length: p.k }, () => L.randomUID());
      recs = await Promise.all(uids.map((uid, i) =>
        L.timedSubmit(producers[i].pack, 'RegisterBindingForPackage',
          { args: [JSON.stringify({ packageId: pkg })], transient: uidT(uid) })));
      const win = recs.findIndex(r => r.status === 'VALID');
      let winnerOk = false, losersOk = true;
      for (let i = 0; i < uids.length; i++) {
        const v = await evalJson(verifier.pack, 'VerifyByUID', { transient: uidT(uids[i]) });
        if (i === win) winnerOk = v.ok && v.obj.packageId === pkg && v.obj.status === 'VALID';
        else if (v.ok || v.code !== 'EVALUATE:ERROR_UID_UNKNOWN') losersOk = false;
      }
      post.ok = win >= 0 && winnerOk && losersOk;
      post.detail = `winnerResolves=${winnerOk} losersUnknown=${losersOk}`;
    }

    if (p.sub === 'c') {
      const lq = assets.c[cursor.c++];
      recs = await Promise.all(Array.from({ length: p.k }, (_, i) =>
        L.timedSubmit(producers[i].process, 'RegisterTransformation', { args: [transformation(lq)] })));
      const winRec = recs.find(r => r.status === 'VALID');
      const winTid = winRec ? JSON.parse(winRec.result).tid : null;

      const g = await evalJson(verifier.origin, 'GetProductionByLotCode', { args: [lq] });
      post.ok = !!winTid && g.ok && g.obj.state === 'CONSUMED' && g.obj.consumedByTID === winTid;
      post.detail = g.ok ? `state=${g.obj.state} consumedByWinner=${g.obj.consumedByTID === winTid}` : g.code;
    }

    const oc = recs.map(r => outcome(r, p.sub));
    const committed = oc.filter(x => x === 'COMMITTED').length;
    const count = pre => oc.filter(x => x.startsWith(pre)).length;
    const t0s = recs.map(r => r.t0), t3s = recs.map(r => r.t3 ?? r.t0);
    const spread = Math.max(...t0s) - Math.min(...t0s);
    const completion = Math.max(...t3s) - Math.min(...t0s);
    const safety = committed <= 1 && (committed === 0 || post.ok);

    recs.forEach((r, i) => {
      const l = L.latencies(r);
      attemptRows.push([p.sub, p.k, p.rep, p.t, i + 1, (performance.timeOrigin + r.t0).toFixed(3),
        l.e2e === null ? '' : l.e2e.toFixed(3), r.status, r.failure, oc[i]].join(','));
    });
    targetRows.push([p.sub, p.k, p.rep, p.t, committed, count('REPEATED_SCAN'), count('MVCC'), count('REJECTED'),
      count('OTHER') + count('VALID_OTHER'), spread.toFixed(3), completion.toFixed(3), post.ok, safety,
      post.detail.replace(/,/g, ';')].join(','));

    const key = `${p.sub}|${p.k}`;
    const s = (summary[key] ??= { sub: p.sub, k: p.k, targets: 0, exactlyOne: 0, violations: 0, noCommit: 0,
      postFail: 0, outcomes: {}, spreadMax: 0 });
    s.targets++;
    if (committed === 1) s.exactlyOne++;
    if (committed === 0) s.noCommit++;
    if (!safety) s.violations++;
    if (committed === 1 && !post.ok) s.postFail++;
    s.spreadMax = Math.max(s.spreadMax, spread);
    for (const x of oc) s.outcomes[x] = (s.outcomes[x] || 0) + 1;

    const flag = safety ? (committed === 1 ? 'ok' : 'no commit') : 'VIOLATION';
    const others = oc.filter(x => x !== 'COMMITTED')
      .reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});
    console.log(`[${String(n + 1).padStart(3)}/${plan.length}] ${p.sub.padEnd(2)} k=${String(p.k).padStart(2)} ` +
      `rep ${p.rep} target ${String(p.t).padStart(2)}: commit ${committed}, others ${JSON.stringify(others)} -> ${flag}`);
  }

  fs.writeFileSync(path.join(OUT, 'attempts.csv'), attemptRows.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'targets.csv'), targetRows.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({
    config: CONFIG, reps: REPS, targetsPerK: TARGETS, ks: KS, subtests: SUBTESTS,
    prep: { seconds: prepSec, validTx: prepValid, retried: prepRows.length - prepValid, concurrency: PREP,
      retryReasons: prepRetries },
    startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(),
    results: Object.values(summary) }, null, 2));

  console.log('\nT3 SUMMARY');
  console.log('subtest    k   targets   exactly-one      no-commit  violations   postcheck-failed  spread-max(ms)  outcomes');
  for (const s of Object.values(summary)) {
    console.log(`${s.sub.padEnd(9)} ${String(s.k).padStart(2)} ${String(s.targets).padStart(9)} ` +
      `${String(s.exactlyOne).padStart(14)} ${String(s.noCommit).padStart(14)} ${String(s.violations).padStart(11)} ` +
      `${String(s.postFail).padStart(18)} ${s.spreadMax.toFixed(1).padStart(15)}  ${JSON.stringify(s.outcomes)}`);
  }
  const totalViol = Object.values(summary).reduce((a, s) => a + s.violations, 0);
  console.log(`\nTotal safety violations: ${totalViol}`);
  console.log(`Data saved to ${OUT}`);
  for (const p of [...farmers, ...producers, ...consumers]) p.c.close();
}

main().catch(err => { console.error(err); process.exitCode = 1; for (const p of [...farmers, ...producers, ...consumers]) p.c.close(); });
