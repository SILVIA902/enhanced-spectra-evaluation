'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const PARTS = arg('parts', 'A,B').split(',');
const FANIN = arg('fanin', '1,5,10,25,50,100').split(',').map(Number);
const DEPTH = arg('depth', '1,5,10,20').split(',').map(Number);
const RUNS = Number(arg('runs', '3'));
const ITERS = Number(arg('iters', '8'));
const CHAINS = Number(arg('chains', '5'));
const VERIFY = Number(arg('verify', '5'));
const CONFIG = arg('config', 'main');
const OUT = L.resultsDir('T8', CONFIG);
const PREP = 25;

const today = new Date().toISOString().slice(0, 10);
const expiry = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
const PRODUCTION = JSON.stringify({
  product: { name: 'Licorice root', sku: 'BENCH-LQ', category: 'raw' },
  production: { date: today, expiry, qty: { value: '10', unit: 'KG' } },
  dop: { geoZoneOK: true, harvestWindowOK: true, supplierAuthorized: true, varietal: 'bench' } });
const uidT = uid => ({ uidRaw: Buffer.from(uid, 'utf8') });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const farmers = Array.from({ length: PREP }, () => {
  const c = L.openClient('bench-farmer'); return { c, origin: c.contract('certificate', 'OriginContract') };
});
const pc = L.openClient('bench-producer');
const producer = { c: pc, process: pc.contract('certificate', 'ProcessContract'), pack: pc.contract('certificate', 'PackagingCertContract') };
const cc = L.openClient('bench-consumer');
const consumer = { c: cc, pack: cc.contract('certificate', 'PackagingCertContract') };
const closeAll = () => { farmers.forEach(f => f.c.close()); pc.close(); cc.close(); };

const rows = [];
const header = 'part,param,run,iter,step,op,l_endorse_ms,l_submit_ms,l_commit_ms,l_e2e_ms,status,failure_class,resp_bytes,tx_id';
function record(part, param, run, iter, step, rec) {
  const l = L.latencies(rec);
  const f = v => (v === null || v === undefined ? '' : v.toFixed(3));
  rows.push([part, param, run, iter, step, rec.op, f(l.endorse), f(l.submit), f(l.commit), f(l.e2e), rec.status, rec.failure,
    rec.result ? Buffer.byteLength(rec.result) : '', rec.txId].join(','));
}
function flush() { fs.writeFileSync(path.join(OUT, 'measurements.csv'), [header, ...rows].join('\n') + '\n'); }

let retries = 0;
async function measured(part, param, run, iter, step, contract, fn, opts, check) {
  for (let a = 1; a <= 5; a++) {
    const rec = await L.timedSubmit(contract, fn, opts);
    rec.op = fn;
    if (rec.status === 'VALID') {
      const obj = JSON.parse(rec.result);
      if (check && !check(obj)) { rec.failure = 'APP_CHECK_FAILED'; record(part, param, run, iter, step, rec); throw new Error(`${fn}: unexpected response ${rec.result.slice(0, 200)}`); }
      record(part, param, run, iter, step, rec);
      return obj;
    }
    if (/NOT_FOUND|NOT_AVAILABLE/.test(rec.failure) && a < 5) { retries++; await sleep(300 * a); continue; }
    record(part, param, run, iter, step, rec);
    throw new Error(`${fn}: ${rec.failure} ${rec.errorText.slice(0, 200)}`);
  }
}
async function measuredQuery(part, param, run, iter, step, contract, fn, opts, check) {
  const rec = await L.timedEvaluate(contract, fn, opts);
  rec.op = fn;
  record(part, param, run, iter, step, rec);
  if (rec.status !== 'OK') throw new Error(`${fn}: ${rec.failure}`);
  const obj = JSON.parse(rec.result);
  if (check && !check(obj)) throw new Error(`${fn}: unexpected response`);
  return obj;
}
async function prepLots(n) {
  const lots = new Array(n);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PREP, n) }, async (_, w) => {
    while (next < n) {
      const i = next++;
      for (let a = 1; ; a++) {
        const rec = await L.timedSubmit(farmers[w].origin, 'RegisterProduction', { args: [PRODUCTION] });
        if (rec.status === 'VALID') { lots[i] = JSON.parse(rec.result).lotCodes[0]; break; }
        if (a >= 5) throw new Error(`preparation failed: ${rec.failure}`);
        await sleep(300 * a);
      }
    }
  }));
  await sleep(500);
  return lots;
}
async function tail(part, param, run, iter, outLot) {
  const pkg = await measured(part, param, run, iter, 'package', producer.pack, 'CreatePackageForLot', { args: [outLot, ''] });
  const uid = L.randomUID();
  const bind = await measured(part, param, run, iter, 'binding', producer.pack, 'RegisterBindingForPackage',
    { args: [JSON.stringify({ packageId: pkg.packageId })], transient: uidT(uid) }, o => !!o.certId);
  for (let v = 1; v <= VERIFY; v++) {
    await measuredQuery(part, param, run, iter, 'verify', consumer.pack, 'VerifyByUID', { transient: uidT(uid) },
      o => o.status === 'VALID' && o.integrityOK === true);
  }
  await measuredQuery(part, param, run, iter, 'getcert', producer.pack, 'GetCert', { args: [bind.certId] });
  await measured(part, param, run, iter, 'consume', consumer.pack, 'ConsumeByUID', { transient: uidT(uid) }, o => o.status === 'CONSUMED');
}

async function partA() {
  for (const n of FANIN) {
    for (let run = 1; run <= RUNS; run++) {
      for (let it = 0; it <= ITERS; it++) {
        const t = Date.now();
        const lots = await prepLots(n);
        const tr = await measured('A', n, run, it, 'transformation', producer.process, 'RegisterTransformation',
          { args: [JSON.stringify({ processType: 'EXTRACTION', processProfile: 'BENCH_T8', inputLotsCsv: lots.join(','),
            qualityOutcome: { dopChecksOK: true } })] },
          o => o.summary.ok === true && Math.abs(o.summary.sumIn - 10 * n) < 1e-9 && Math.abs(o.summary.sumOut - 3 * n) < 1e-9);
        await tail('A', n, run, it, tr.output);
        console.log(`A fan-in ${String(n).padStart(3)} run ${run} iter ${it}${it === 0 ? ' (warm-up)' : ''}: ok ${((Date.now() - t) / 1000).toFixed(1)} s`);
        flush();
      }
    }
  }
}

async function partB() {
  for (const d of DEPTH) {
    for (let ch = 0; ch <= CHAINS; ch++) {
      const t = Date.now();
      let [lot] = await prepLots(1);
      for (let s = 1; s <= d; s++) {
        const tr = await measured('B', d, 1, ch, `transformation_${s}`, producer.process, 'RegisterTransformation',
          { args: [JSON.stringify({ processType: 'DRYING', processProfile: 'BENCH_T8', inputLotsCsv: lot,
            qualityOutcome: { dopChecksOK: true } })] }, o => o.summary.ok === true);
        lot = tr.output;
      }
      await tail('B', d, 1, ch, lot);
      console.log(`B depth ${String(d).padStart(2)} chain ${ch}${ch === 0 ? ' (warm-up)' : ''}: ok ${((Date.now() - t) / 1000).toFixed(1)} s`);
      flush();
    }
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`T8 ${CONFIG}: parts ${PARTS.join(',')}; fan-in ${FANIN.join(',')} (${RUNS} runs x ${ITERS} iterations); ` +
    `depth ${DEPTH.join(',')} (${CHAINS} chains); ${VERIFY} verifications per certificate`);
  try {
    if (PARTS.includes('A')) await partA();
    if (PARTS.includes('B')) await partB();
  } finally {
    flush();
    fs.writeFileSync(path.join(OUT, 'run_info.json'), JSON.stringify({ test: 'T8', config: CONFIG, parts: PARTS, fanin: FANIN,
      depth: DEPTH, runs: RUNS, iters: ITERS, chains: CHAINS, verify: VERIFY, retries, startedAt,
      finishedAt: new Date().toISOString() }, null, 2));
    closeAll();
  }
  console.log(`\nT8 completed. Retries due to propagation: ${retries}. Data in ${OUT}`);
}
main().catch(err => { console.error(`ABORTED: ${err.message}`); process.exitCode = 1; });
