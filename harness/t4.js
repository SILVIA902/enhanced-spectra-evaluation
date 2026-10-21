'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const PROFILES = arg('profiles', 'A,B,C').split(',');
const REPS = Number(arg('reps', '5'));
const BURSTS = arg('bursts', '10,50,100,200').split(',').map(Number);
const PB_SIZE = Number(arg('pb-size', '50'));
const PB_PERIOD = Number(arg('pb-period', '5'));
const PB_DURATION = Number(arg('pb-duration', '60'));
const POISSON = String(arg('poisson', '')).split(',').filter(Boolean).map(Number);
const PC_DURATION = Number(arg('pc-duration', '60'));
const SEED = Number(arg('seed', '20261021'));
const GAP = Number(arg('gap', '10'));
const CLIENTS = Number(arg('clients', '32'));
const CONFIG = arg('config', 'main');
const DRAIN_MAX = 120000;
const OUT = L.resultsDir('T4', CONFIG);
if (PROFILES.includes('C') && !POISSON.length) { console.error('Specify --poisson with the mean rates (TPS)'); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const expiry = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
const PRODUCTION = JSON.stringify({
  product: { name: 'Licorice root', sku: 'BENCH-LQ', category: 'raw' },
  production: { date: today, expiry, qty: { value: '10', unit: 'KG' } },
  dop: { geoZoneOK: true, harvestWindowOK: true, supplierAuthorized: true, varietal: 'bench' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
function pctl(a, p) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const farmers = Array.from({ length: CLIENTS }, () => {
  const c = L.openClient('bench-farmer');
  return { c, origin: c.contract('certificate', 'OriginContract') };
});
const closeAll = () => farmers.forEach(f => f.c.close());

function scheduleFor(profile, param, rep) {
  if (profile === 'A') return Array(param).fill(0);
  if (profile === 'B') {
    const out = [];
    for (let t = 0; t < PB_DURATION * 1000; t += PB_PERIOD * 1000) for (let i = 0; i < PB_SIZE; i++) out.push(t);
    return out;
  }

  const r = rng(SEED + param * 1000 + rep);
  const out = [];
  let t = -Math.log(1 - r()) * 1000 / param;
  while (t < PC_DURATION * 1000) { out.push(t); t += -Math.log(1 - r()) * 1000 / param; }
  return out;
}

async function execute(schedule) {
  const recs = new Array(schedule.length);
  const timeline = [];
  let outstanding = 0, maxOut = 0, launched = 0;
  const pending = new Set();
  const t0 = now();
  let lastSample = -Infinity;
  const sample = () => {
    const t = now();
    if (t - lastSample >= 100) { timeline.push([Math.round(t - t0), outstanding]); lastSample = t; }
  };
  while (launched < schedule.length) {
    const t = now() - t0;
    while (launched < schedule.length && schedule[launched] <= t) {
      const i = launched++;
      const f = farmers[i % farmers.length];
      outstanding++; maxOut = Math.max(maxOut, outstanding);
      const p = L.timedSubmit(f.origin, 'RegisterProduction', { args: [PRODUCTION] }).then(rec => {
        rec.client = 'bench-farmer'; rec.offset = schedule[i]; recs[i] = rec;
        outstanding--; pending.delete(p);
      });
      pending.add(p);
    }
    sample();
    const next = launched < schedule.length ? schedule[launched] - (now() - t0) : 0;
    await sleep(Math.max(0, Math.min(5, next)));
  }
  const deadline = now() + DRAIN_MAX;
  while (pending.size && now() < deadline) { sample(); await sleep(20); }
  timeline.push([Math.round(now() - t0), outstanding]);
  return { recs: recs.filter(Boolean), unresolved: pending.size, timeline, maxOut, t0 };
}

function metrics(profile, schedule, res) {
  const { recs, unresolved, timeline, maxOut, t0 } = res;
  const valid = recs.filter(r => r.status === 'VALID');
  const lat = valid.map(r => r.t3 - r.t0);
  const failures = {};
  for (const r of recs.filter(x => x.status !== 'VALID')) failures[r.failure || r.status] = (failures[r.failure || r.status] || 0) + 1;
  const firstSubmit = Math.min(...recs.map(r => r.t0));
  const lastDone = Math.max(...recs.map(r => r.t3 ?? r.tErr ?? r.t0));
  const lastScheduled = schedule.length ? t0 + schedule[schedule.length - 1] : t0;
  const m = {
    requests: schedule.length, valid: valid.length, failed: recs.length - valid.length, unresolved,
    completionMs: lastDone - firstSubmit,
    drainMs: Math.max(0, lastDone - lastScheduled),
    releaseSpreadMs: profile === 'A' ? Math.max(...recs.map(r => r.t0)) - firstSubmit : null,
    p50: pctl(lat, 0.5), p95: pctl(lat, 0.95), p99: pctl(lat, 0.99), max: lat.length ? Math.max(...lat) : NaN,
    meanLat: mean(lat), maxOutstanding: maxOut, failures,
    blocks: new Set(valid.map(r => r.block)).size,
  };
  if (profile === 'B') {

    const bursts = [...new Set(schedule)];
    m.perBurstCompletionMs = bursts.map(b => {
      const rs = recs.filter(r => r.offset === b);
      return Math.max(...rs.map(r => r.t3 ?? r.tErr ?? r.t0)) - (t0 + b);
    });
    m.burstsCompletedBeforeNext = m.perBurstCompletionMs.filter(x => x < PB_PERIOD * 1000).length;
  }
  if (profile === 'C') {
    const gaps = schedule.slice(1).map((x, i) => x - schedule[i]);
    m.achievedRate = schedule.length / PC_DURATION;
    m.interArrivalMeanMs = mean(gaps);
    m.interArrivalCv = Math.sqrt(mean(gaps.map(g => (g - mean(gaps)) ** 2))) / mean(gaps);
    m.outstandingP95 = pctl(timeline.map(x => x[1]), 0.95);
  }
  return m;
}

async function main() {
  const startedAt = new Date().toISOString();
  const configs = [];
  if (PROFILES.includes('A')) for (const b of BURSTS) configs.push(['A', b]);
  if (PROFILES.includes('B')) configs.push(['B', PB_SIZE]);
  if (PROFILES.includes('C')) for (const r of POISSON) configs.push(['C', r]);
  console.log(`T4 ${CONFIG}: ${configs.length} configurations x ${REPS} repetitions; seed ${SEED}; ${CLIENTS} connections`);

  await execute(Array(20).fill(0));
  await sleep(GAP * 1000);

  const rows = ['profile,param,rep,requests,valid,failed,unresolved,completion_ms,drain_ms,release_spread_ms,' +
    'p50_ms,p95_ms,p99_ms,max_ms,max_outstanding,blocks,extra'];
  const all = [];
  for (const [profile, param] of configs) {
    for (let rep = 1; rep <= REPS; rep++) {
      const schedule = scheduleFor(profile, param, rep);
      const dir = path.join(OUT, `${profile}_${param}`, `r${rep}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'schedule.json'), JSON.stringify({ profile, param, rep, seed: SEED, offsetsMs: schedule }));
      const res = await execute(schedule);
      const m = metrics(profile, schedule, res);
      const meta = { test: 'T4', config: `${CONFIG}-${profile}${param}`, run: rep };
      fs.writeFileSync(path.join(dir, 'requests.csv'),
        [L.CSV_HEADER, ...res.recs.map((r, i) => L.csvRow(meta, i + 1, r))].join('\n') + '\n');
      fs.writeFileSync(path.join(dir, 'outstanding.csv'),
        ['ms_from_start,outstanding', ...res.timeline.map(x => x.join(','))].join('\n') + '\n');
      fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({ profile, param, rep, ...m }, null, 2));
      all.push({ profile, param, rep, ...m });
      const extra = profile === 'B' ? `bursts_done_before_next=${m.burstsCompletedBeforeNext}/${m.perBurstCompletionMs.length}`
        : profile === 'C' ? `rate=${m.achievedRate.toFixed(1)};cv=${m.interArrivalCv.toFixed(2)}` : '';
      rows.push([profile, param, rep, m.requests, m.valid, m.failed, m.unresolved, m.completionMs, m.drainMs,
        m.releaseSpreadMs, m.p50, m.p95, m.p99, m.max, m.maxOutstanding, m.blocks, extra]
        .map(v => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(3) : '') : v ?? '')).join(','));
      fs.writeFileSync(path.join(OUT, 'summary.csv'), rows.join('\n') + '\n');
      const label = profile === 'A' ? `burst singolo B=${param}` : profile === 'B' ? `burst periodici ${PB_SIZE}/${PB_PERIOD}s`
        : `Poisson ${param} TPS`;
      console.log(`${label.padEnd(22)} rep ${rep}: ${m.valid}/${m.requests} valid, completion ${(m.completionMs / 1000).toFixed(2)} s, ` +
        `P50 ${m.p50.toFixed(0)} P95 ${m.p95.toFixed(0)} ms, max outstanding ${m.maxOutstanding}, blocks ${m.blocks}` +
        (m.failed || m.unresolved ? `, ERRORS ${JSON.stringify(m.failures)} unresolved ${m.unresolved}` : '') +
        (extra ? `, ${extra}` : ''));
      await sleep(GAP * 1000);
    }
  }
  fs.writeFileSync(path.join(OUT, 'run_info.json'), JSON.stringify({ test: 'T4', config: CONFIG, profiles: PROFILES,
    reps: REPS, bursts: BURSTS, pbSize: PB_SIZE, pbPeriod: PB_PERIOD, pbDuration: PB_DURATION, poisson: POISSON,
    pcDuration: PC_DURATION, seed: SEED, gap: GAP, clients: CLIENTS, startedAt, finishedAt: new Date().toISOString() }, null, 2));
  const bad = all.reduce((s, x) => s + x.failed + x.unresolved, 0);
  console.log(`\nT4 completed: ${all.length} runs, invalid or unresolved requests: ${bad}`);
  console.log(`Data saved to ${OUT}`);
  closeAll();
}

main().catch(err => { console.error(err); process.exitCode = 1; closeAll(); });
