'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const L = require('./lib');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const WORKLOADS = arg('workloads', 'write,read').split(',');
const RATES = arg('rates', '10,20,40,80,160,320,640').split(',').map(Number);
const WARM = Number(arg('warm', '15'));
const MEASURE = Number(arg('measure', '30'));
const DRAIN = Number(arg('drain', '30'));
const REPS = Number(arg('reps', '3'));
const CLIENTS = Number(arg('clients', '32'));
const CONFIG = arg('config', 'main');
const READ_UIDS = Number(arg('uids', '50'));

const P95BASE = Object.fromEntries(String(arg('p95base', '')).split(',').filter(Boolean)
  .map(x => x.split('=')).map(([k, v]) => [k, Number(v)]));
const OUT = L.resultsDir('T2', CONFIG);
const HERE = __dirname;

const today = new Date().toISOString().slice(0, 10);
const expiry = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
const PRODUCTION = JSON.stringify({
  product: { name: 'Licorice root', sku: 'BENCH-LQ', category: 'raw' },
  production: { date: today, expiry, qty: { value: '10', unit: 'KG' } },
  dop: { geoZoneOK: true, harvestWindowOK: true, supplierAuthorized: true, varietal: 'bench' } });
const uidT = uid => ({ uidRaw: Buffer.from(uid, 'utf8') });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
const epoch = t => performance.timeOrigin + t;

function pctl(a, p) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

function pool(label, n) {
  return Array.from({ length: n }, () => {
    const c = L.openClient(label);
    return { c, origin: c.contract('certificate', 'OriginContract'),
      process: c.contract('certificate', 'ProcessContract'), pack: c.contract('certificate', 'PackagingCertContract') };
  });
}
const farmers = pool('bench-farmer', CLIENTS);
const producers = pool('bench-producer', Math.min(CLIENTS, 20));
const consumers = pool('bench-consumer', CLIENTS);
const closeAll = () => { for (const p of [...farmers, ...producers, ...consumers]) p.c.close(); };

async function mustSubmit(contract, fn, opts) {
  for (let a = 1; a <= 6; a++) {
    const rec = await L.timedSubmit(contract, fn, opts);
    if (rec.status === 'VALID') return JSON.parse(rec.result);
    if (a === 6) throw new Error(`preparation failed: ${fn} ${rec.failure} ${rec.errorText.slice(0, 200)}`);
    await sleep(100 * 2 ** (a - 1));
  }
}
async function makeBoundUID(w) {
  const f = farmers[w % farmers.length], p = producers[w % producers.length];
  const lq = (await mustSubmit(f.origin, 'RegisterProduction', { args: [PRODUCTION] })).lotCodes[0];
  const tr = await mustSubmit(p.process, 'RegisterTransformation', { args: [JSON.stringify({
    processType: 'EXTRACTION', processProfile: 'BENCH_T2', inputLotsCsv: lq, qualityOutcome: { dopChecksOK: true } })] });
  const pkg = await mustSubmit(p.pack, 'CreatePackageForLot', { args: [tr.output, ''] });
  const uid = L.randomUID();
  await mustSubmit(p.pack, 'RegisterBindingForPackage',
    { args: [JSON.stringify({ packageId: pkg.packageId })], transient: uidT(uid) });
  return uid;
}

function startMonitor(file) {
  const m = spawn(path.join(HERE, 'monitor.sh'), [file], { stdio: 'ignore' });
  return () => { try { m.kill('SIGTERM'); } catch (_) {  } };
}
function storageSnapshot(file) {
  try { fs.writeFileSync(file, execFileSync(path.join(HERE, 'storage.sh'), { encoding: 'utf8' })); }
  catch (e) { fs.writeFileSync(file, `error,${String(e.message).replace(/,/g, ';')}\n`); }
}

async function runLevel(workload, rate, rep, uids, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stopMon = startMonitor(path.join(dir, 'resources.csv'));
  const recs = [];
  const timeline = [];
  let outstanding = 0, seq = 0, maxOutstanding = 0;
  const pending = new Set();
  const launchT = [];

  const launch = () => {
    const i = seq++;
    launchT.push(now());
    let p;
    if (workload === 'write') {
      const cl = farmers[i % farmers.length];
      p = L.timedSubmit(cl.origin, 'RegisterProduction', { args: [PRODUCTION] });
    } else {
      const cl = consumers[i % consumers.length];
      p = L.timedEvaluate(cl.pack, 'VerifyByUID', { transient: uidT(uids[i % uids.length]) });
    }
    outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding);
    const tracked = p.then(rec => {
      rec.client = workload === 'write' ? 'bench-farmer' : 'bench-consumer';
      rec.tDone = now();
      recs.push(rec);
      outstanding--;
      pending.delete(tracked);
    });
    pending.add(tracked);
  };

  const interval = 1000 / rate;
  const t0 = now();
  const warmEnd = t0 + WARM * 1000;
  const measEnd = warmEnd + MEASURE * 1000;
  let next = t0, lastSample = t0;
  while (now() < measEnd) {
    const t = now();
    while (next <= t && next < measEnd) { launch(); next += interval; }
    if (t - lastSample >= 1000) { timeline.push([Math.round(t - t0), outstanding]); lastSample = t; }
    await sleep(Math.max(0, Math.min(5, next - now())));
  }
  const submitEnd = now();
  const drainDeadline = submitEnd + DRAIN * 1000;
  while (pending.size && now() < drainDeadline) {
    if (now() - lastSample >= 1000) { timeline.push([Math.round(now() - t0), outstanding]); lastSample = now(); }
    await sleep(50);
  }
  const unresolved = pending.size;
  stopMon();

  const inWin = recs.filter(r => r.t0 >= warmEnd && r.t0 < measEnd);
  const ok = r => (workload === 'write' ? r.status === 'VALID' : r.status === 'OK');
  const valid = inWin.filter(ok);
  const failed = inWin.filter(r => !ok(r));
  const lat = valid.map(r => r.t3 - r.t0);
  const winSec = MEASURE;
  const submittedMeasured = launchT.filter(t => t >= warmEnd && t < measEnd).length;
  const unresolvedInWin = Math.max(0, submittedMeasured - inWin.length);
  const lambda = submittedMeasured / winSec;
  const X = inWin.length / winSec;
  const G = valid.length / winSec;
  const failRate = submittedMeasured ? (failed.length + unresolvedInWin) / submittedMeasured : 0;
  const thirds = timeline.filter(([ms]) => ms >= WARM * 1000 && ms < (WARM + MEASURE) * 1000).map(x => x[1]);
  const k3 = Math.max(1, Math.floor(thirds.length / 3));
  const growth = mean(thirds.slice(-k3)) - mean(thirds.slice(0, k3));
  const failures = {};
  for (const r of failed) failures[r.failure || r.status] = (failures[r.failure || r.status] || 0) + 1;

  const meta = { test: 'T2', config: `${CONFIG}-${workload}-L${rate}`, run: rep };
  fs.writeFileSync(path.join(dir, 'requests.csv'),
    [L.CSV_HEADER, ...recs.map((r, i) => L.csvRow(meta, i + 1, r))].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'outstanding.csv'),
    ['ms_from_start,outstanding', ...timeline.map(x => x.join(','))].join('\n') + '\n');
  const summary = {
    workload, rate, rep, warm: WARM, measure: MEASURE, drain: DRAIN, clients: CLIENTS,
    startedAt: new Date(epoch(t0)).toISOString(),
    submittedInWindow: submittedMeasured, nominalInWindow: Math.round(MEASURE * rate), completedInWindow: inWin.length,
    validInWindow: valid.length, failedInWindow: failed.length, unresolvedAfterDrain: unresolved,
    lambdaMeasured: lambda, throughput: X, goodput: G, failRate,
    p50: pctl(lat, 0.5), p95: pctl(lat, 0.95), p99: pctl(lat, 0.99), mean: mean(lat),
    endorseMean: workload === 'write' ? mean(valid.map(r => r.t1 - r.t0)) : null,
    commitMean: workload === 'write' ? mean(valid.map(r => r.t3 - r.t2)) : null,
    maxOutstanding, outstandingGrowth: growth, failures,
  };
  fs.writeFileSync(path.join(dir, 'level_summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

function sustainable(s, p95base) {
  const reasons = [];
  if (s.goodput < 0.95 * s.lambdaMeasured) reasons.push('goodput<0.95*lambda');
  if (s.failRate > 0.01) reasons.push('fail>1%');
  if (p95base && s.p95 > 2 * p95base) reasons.push('P95>2*base');
  if (s.outstandingGrowth > Math.max(20, 0.5 * s.lambdaMeasured)) reasons.push('backlog growing');
  return reasons;
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`T2 ${CONFIG}: workload ${WORKLOADS.join(',')}, rates ${RATES.join(',')} TPS, ` +
    `window ${WARM}+${MEASURE}+${DRAIN} s, ${REPS} repetitions, ${CLIENTS} client connections`);
  let uids = [];
  if (WORKLOADS.includes('read')) {
    const t = Date.now();
    const width = Math.min(20, READ_UIDS);
    let next = 0;
    await Promise.all(Array.from({ length: width }, async (_, w) => {
      while (next < READ_UIDS) { next++; uids.push(await makeBoundUID(w)); }
    }));
    uids = uids.slice(0, READ_UIDS);
    console.log(`Prepared ${uids.length} UIDs for the reads in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    await sleep(3000);
  }

  const rows = ['workload,rate,rep,lambda_measured,throughput,goodput,fail_rate,p50_ms,p95_ms,p99_ms,mean_ms,' +
    'endorse_mean_ms,commit_mean_ms,max_outstanding,outstanding_growth,unresolved,sustainable,reasons'];
  for (const w of WORKLOADS) {
    storageSnapshot(path.join(OUT, `storage_before_${w}.csv`));
    const wStart = Date.now();
    let p95base = Number.isFinite(P95BASE[w]) ? P95BASE[w] : null, consecutiveBad = 0;
    if (p95base !== null) console.log(`${w}: reference P95 set to ${p95base} ms`);
    for (const rate of RATES) {
      const levelResults = [];
      for (let rep = 1; rep <= REPS; rep++) {
        const dir = path.join(OUT, w, `L${rate}`, `r${rep}`);
        const s = await runLevel(w, rate, rep, uids, dir);
        if (p95base === null && rep === 1) p95base = s.p95;
        const reasons = sustainable(s, p95base);
        levelResults.push(reasons.length === 0);
        rows.push([w, rate, rep, s.lambdaMeasured, s.throughput, s.goodput, s.failRate, s.p50, s.p95, s.p99, s.mean,
          s.endorseMean, s.commitMean, s.maxOutstanding, s.outstandingGrowth, s.unresolvedAfterDrain,
          reasons.length === 0, reasons.join('|')]
          .map(v => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(3) : '') : v ?? '')).join(','));
        fs.writeFileSync(path.join(OUT, 'sweep_summary.csv'), rows.join('\n') + '\n');
        console.log(`${w.padEnd(5)} ${String(rate).padStart(4)} TPS rep ${rep}: lambda ${s.lambdaMeasured.toFixed(1)}  ` +
          `goodput ${s.goodput.toFixed(1)}  P50 ${s.p50.toFixed(1)}  P95 ${s.p95.toFixed(1)} ms  ` +
          `errors ${(100 * s.failRate).toFixed(2)}%  backlog max ${s.maxOutstanding}  ` +
          `${reasons.length ? `NOT sustainable (${reasons.join(', ')})` : 'sustainable'}`);
        await sleep(5000);
      }
      const allOk = levelResults.every(Boolean);
      consecutiveBad = allOk ? 0 : consecutiveBad + 1;
      if (consecutiveBad >= 2) { console.log(`${w}: two consecutive non-sustainable levels, sweep stopped.`); break; }
    }
    storageSnapshot(path.join(OUT, `storage_after_${w}.csv`));
    console.log(`${w}: completed in ${((Date.now() - wStart) / 60000).toFixed(1)} min`);
  }
  fs.writeFileSync(path.join(OUT, 'run_info.json'), JSON.stringify({ test: 'T2', config: CONFIG, workloads: WORKLOADS,
    rates: RATES, warm: WARM, measure: MEASURE, drain: DRAIN, reps: REPS, clients: CLIENTS, readUids: uids.length, p95base: P95BASE,
    startedAt, finishedAt: new Date().toISOString() }, null, 2));
  console.log(`\nT2 completed. Summary: ${path.join(OUT, 'sweep_summary.csv')}`);
  closeAll();
}

main().catch(err => { console.error(err); process.exitCode = 1; closeAll(); });
