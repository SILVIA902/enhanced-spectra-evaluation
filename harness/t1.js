'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const RUN = Number(arg('run', '1'));
const ITERS = Number(arg('iters', '60'));
const WARMUP = Number(arg('warmup', '3'));
const CONFIG = arg('config', 'bt2s');
const OUT = arg('out', null) || L.resultsDir('T1', CONFIG, `r${RUN}`);
fs.mkdirSync(OUT, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const expiry = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
const PRODUCTION = JSON.stringify({
  product: { name: 'Licorice root', sku: 'BENCH-LQ', category: 'raw' },
  production: { date: today, expiry, qty: { value: '10', unit: 'KG' } },
  dop: { geoZoneOK: true, harvestWindowOK: true, supplierAuthorized: true, varietal: 'bench' } });

function pctl(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function iteration(c, i) {
  const out = [];
  const run = async (client, promise, validate, rename) => {
    const rec = await promise;
    rec.client = client.label;
    if (rename) rec.op = rename;
    out.push(rec);
    const ok = rec.kind === 'submit' ? rec.status === 'VALID' : rec.status === 'OK';
    if (!ok) throw new Error(`${rec.op}: ${rec.failure} ${rec.errorText.slice(0, 200)}`);
    const obj = JSON.parse(rec.result);
    if (validate && !validate(obj)) {
      rec.failure = 'APP_CHECK_FAILED';
      throw new Error(`${rec.op}: unexpected response ${rec.result.slice(0, 200)}`);
    }
    return obj;
  };
  const uidT = () => ({ uidRaw: Buffer.from(uid, 'utf8') });
  const uid = L.randomUID();

  try {
    const prod = await run(c.farmer, L.timedSubmit(c.origin, 'RegisterProduction', { args: [PRODUCTION] }),
      o => o.lotCodes.length === 1);
    const lq = prod.lotCodes[0];
    const tr = await run(c.producer, L.timedSubmit(c.process, 'RegisterTransformation', { args: [JSON.stringify({
      processType: 'EXTRACTION', processProfile: 'BENCH_T1', inputLotsCsv: lq,
      qualityOutcome: { dopChecksOK: true } })] }),
      o => o.summary.sumIn === 10 && o.summary.sumOut === 3 && o.summary.losses === 7 && o.summary.ok === true);
    await run(c.farmer, L.timedEvaluate(c.origin, 'GetProductionByLotCode', { args: [lq] }),
      o => o.state === 'CONSUMED');
    const pkg = await run(c.producer, L.timedSubmit(c.pack, 'CreatePackageForLot', { args: [tr.output, ''] }),
      o => o.netQty === 2.98);
    const bind = await run(c.producer, L.timedSubmit(c.pack, 'RegisterBindingForPackage', {
      args: [JSON.stringify({ packageId: pkg.packageId })], transient: uidT() }),
      o => !!o.certId && !!o.bindingId);
    await run(c.producer, L.timedEvaluate(c.pack, 'GetCert', { args: [bind.certId] }), o => o.state === 'VALID');
    await run(c.producer, L.timedEvaluate(c.pack, 'VerifyCertIntegrity', { args: [bind.certId] }), o => o.ok === true);
    await run(c.producer, L.timedEvaluate(c.auth, 'CheckAuthorized', { args: ['producer'] }), o => o.authorized === true);
    await run(c.consumer, L.timedEvaluate(c.verify, 'VerifyByUID', { transient: uidT() }),
      o => o.status === 'VALID' && o.integrityOK === true);
    await run(c.consumer, L.timedSubmit(c.verify, 'ConsumeByUID', { transient: uidT() }),
      o => o.status === 'CONSUMED');
    await run(c.consumer, L.timedSubmit(c.verify, 'ConsumeByUID', { transient: uidT() }),
      o => o.status === 'ALREADY_CONSUMED', 'ConsumeByUID_repeat');
    return { out, ok: true };
  } catch (err) {
    console.log(`   iteration ${i} aborted: ${err.message}`);
    return { out, ok: false };
  }
}

async function main() {
  const farmer = L.openClient('bench-farmer');
  const producer = L.openClient('bench-producer');
  const consumer = L.openClient('bench-consumer');
  const c = {
    farmer, producer, consumer,
    origin: farmer.contract('certificate', 'OriginContract'),
    process: producer.contract('certificate', 'ProcessContract'),
    pack: producer.contract('certificate', 'PackagingCertContract'),
    auth: producer.contract('userauth', 'UserAuthContract'),
    verify: consumer.contract('certificate', 'PackagingCertContract'),
  };
  const meta = { test: 'T1', config: CONFIG, run: RUN };
  const measured = [], warm = [];
  let failedIters = 0;
  const total = WARMUP + ITERS;
  const startedAt = new Date().toISOString();

  for (let i = 1; i <= total; i++) {
    const isWarm = i <= WARMUP;
    const t = Date.now();
    const { out, ok } = await iteration(c, i);
    (isWarm ? warm : measured).push(...out);
    if (!ok && !isWarm) failedIters++;
    console.log(`iteration ${String(i).padStart(3)}/${total} ${isWarm ? '(warm-up)' : ''} ` +
      `${ok ? 'ok' : 'FAILED'}  ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
  farmer.close(); producer.close(); consumer.close();

  const write = (name, recs) => fs.writeFileSync(path.join(OUT, name),
    [L.CSV_HEADER, ...recs.map((r, k) => L.csvRow(meta, k + 1, r))].join('\n') + '\n');
  write('requests.csv', measured);
  write('warmup.csv', warm);
  fs.writeFileSync(path.join(OUT, 'run_info.json'), JSON.stringify({
    test: 'T1', config: CONFIG, run: RUN, warmup: WARMUP, iterations: ITERS,
    failedIterations: failedIters, startedAt, finishedAt: new Date().toISOString() }, null, 2));

  console.log(`\nSummary of run ${RUN} (${CONFIG}), measured iterations: ${ITERS}, failed: ${failedIters}`);
  console.log('operation                     n    e2e mean    e2e P50   e2e P95   endorse mean    commit mean');
  const ops = [...new Set(measured.map(r => r.op))];
  for (const op of ops) {
    const rs = measured.filter(r => r.op === op && (r.status === 'VALID' || r.status === 'OK') && !r.failure);
    const e2e = rs.map(r => L.latencies(r).e2e).sort((a, b) => a - b);
    const en = rs.map(r => L.latencies(r).endorse).filter(v => v !== null);
    const co = rs.map(r => L.latencies(r).commit).filter(v => v !== null);
    const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
    const f = v => (Number.isNaN(v) ? '-' : v.toFixed(1)).padStart(9);
    console.log(`${op.padEnd(27)} ${String(rs.length).padStart(4)} ${f(mean(e2e))}  ${f(pctl(e2e, 0.5))} ${f(pctl(e2e, 0.95))}` +
      `       ${f(mean(en))}      ${f(mean(co))}`);
  }
  console.log(`\nData saved to ${OUT}`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
