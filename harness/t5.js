'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const protos = require('@hyperledger/fabric-protos');
const L = require('./lib');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const FAULTS = arg('faults', 'F1,F2,F3,F4').split(',');
const REPS = Number(arg('reps', '3'));
const WRATE = Number(arg('wrate', '32'));
const RRATE = Number(arg('rrate', '64'));
const BASELINE = Number(arg('baseline', '60'));
const FAULT = Number(arg('fault', '30'));
const OBSERVE = Number(arg('observe', '90'));
const CONFIG = arg('config', 'main');
const CLIENTS = 16;
const OUT = L.resultsDir('T5', CONFIG);
const CHANNEL = 'milkchannel';
const PEER_P = 'peer0.producers.example.com';
const ORDERER = 'orderer.example.com';

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
const sh = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function mk(label) {
  const c = L.openClient(label);
  return { c, origin: c.contract('certificate', 'OriginContract'), process: c.contract('certificate', 'ProcessContract'),
    pack: c.contract('certificate', 'PackagingCertContract'), qscc: c.contract('qscc') };
}
const farmers = Array.from({ length: CLIENTS }, () => mk('bench-farmer'));
const producers = Array.from({ length: 4 }, () => mk('bench-producer'));
const closeAll = () => [...farmers, ...producers].forEach(x => x.c.close());

async function mustSubmit(contract, fn, opts) {
  for (let a = 1; a <= 6; a++) {
    const rec = await L.timedSubmit(contract, fn, opts);
    if (rec.status === 'VALID') return JSON.parse(rec.result);
    if (a === 6) throw new Error(`preparation failed: ${fn} ${rec.failure} ${rec.errorText.slice(0, 200)}`);
    await sleep(200 * 2 ** (a - 1));
  }
}
async function makeBoundUID(w) {
  const f = farmers[w % farmers.length], p = producers[w % producers.length];
  const lq = (await mustSubmit(f.origin, 'RegisterProduction', { args: [PRODUCTION] })).lotCodes[0];
  const tr = await mustSubmit(p.process, 'RegisterTransformation', { args: [JSON.stringify({
    processType: 'EXTRACTION', processProfile: 'BENCH_T5', inputLotsCsv: lq, qualityOutcome: { dopChecksOK: true } })] });
  const pkg = await mustSubmit(p.pack, 'CreatePackageForLot', { args: [tr.output, ''] });
  const uid = L.randomUID();
  await mustSubmit(p.pack, 'RegisterBindingForPackage', { args: [JSON.stringify({ packageId: pkg.packageId })], transient: uidT(uid) });
  return uid;
}
async function height(cl) {
  try {
    const out = await cl.qscc.evaluateTransaction('GetChainInfo', CHANNEL);
    return Number(protos.common.BlockchainInfo.deserializeBinary(out).getHeight());
  } catch (_) { return null; }
}
async function txLookup(cl, txId) {
  try {
    const out = await cl.qscc.evaluateTransaction('GetTransactionByID', CHANNEL, txId);
    return protos.peer.ProcessedTransaction.deserializeBinary(out).getValidationcode();
  } catch (_) { return null; }
}
async function waitHealthy(maxMs) {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    const rec = await L.timedSubmit(farmers[0].origin, 'RegisterProduction', { args: [PRODUCTION] });
    if (rec.status === 'VALID') return Date.now() - t;
    await sleep(2000);
  }
  return null;
}
function networksOf(container) {
  return sh('inspect', container, '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}').split(' ').filter(Boolean);
}
function certificateCcContainer() {
  return sh('ps', '--format', '{{.Names}}').split('\n').find(n => n.startsWith('dev-peer0.farmers') && n.includes('-certificate_'));
}

const FAULT_DEF = {
  F1: { label: 'stop of peer0.producers', inject: () => sh('stop', '-t', '0', PEER_P), restore: () => sh('start', PEER_P) },
  F2: { label: 'stop of the ordering service', inject: () => sh('stop', '-t', '0', ORDERER), restore: () => sh('start', ORDERER) },
  F3: { label: 'kill of the certificate chaincode container (Farmers)',
    inject: () => { const c = certificateCcContainer(); if (!c) throw new Error('chaincode container not found'); sh('kill', c); return c; },
    restore: () => 'restarted by the peer on next invocation' },

  F4: { label: 'network partition of peer0.producers (all networks)', nets: [],
    inject() { this.nets = networksOf(PEER_P); for (const n of this.nets) sh('network', 'disconnect', n, PEER_P);
      const left = networksOf(PEER_P); if (left.length) throw new Error(`networks still connected: ${left.join(',')}`);
      return `disconnected from ${this.nets.join(',')}`; },
    restore() { for (const n of this.nets) sh('network', 'connect', n, PEER_P); return `reconnected to ${this.nets.join(',')}`; } },
};

async function run(faultId, rep, uids) {
  const def = FAULT_DEF[faultId];
  const dir = path.join(OUT, faultId, `r${rep}`);
  fs.mkdirSync(dir, { recursive: true });
  const recs = [];
  const pending = new Set();
  let wi = 0, ri = 0;
  const events = {};
  const launch = stream => {
    const i = stream === 'write' ? wi++ : ri++;
    const f = farmers[i % farmers.length];
    const p = (stream === 'write'
      ? L.timedSubmit(f.origin, 'RegisterProduction', { args: [PRODUCTION] })
      : L.timedEvaluate(f.pack, 'VerifyByUID', { transient: uidT(uids[i % uids.length]) }))
      .then(rec => { rec.client = 'bench-farmer'; rec.stream = stream; recs.push(rec); pending.delete(p); });
    pending.add(p);
  };
  const T = { start: now() };
  T.fault = T.start + BASELINE * 1000;
  T.restore = T.fault + FAULT * 1000;
  T.end = T.restore + OBSERVE * 1000;
  let nextW = T.start, nextR = T.start, injected = false, restored = false;
  while (now() < T.end) {
    const t = now();
    while (nextW <= t) { launch('write'); nextW += 1000 / WRATE; }
    while (nextR <= t) { launch('read'); nextR += 1000 / RRATE; }
    if (!injected && t >= T.fault) {
      injected = true; events.faultAt = now();
      try { events.faultDetail = String(def.inject()); } catch (e) { events.faultError = e.message; }
      console.log(`   ${faultId}: fault injected (${def.label})`);
    }
    if (!restored && t >= T.restore) {
      restored = true; events.restoreAt = now();
      try { events.restoreDetail = String(def.restore()); } catch (e) { events.restoreError = e.message; }
      console.log(`   ${faultId}: restore`);
    }
    await sleep(Math.max(0, Math.min(5, Math.min(nextW, nextR) - now())));
  }
  const drainEnd = now() + 150000;
  while (pending.size && now() < drainEnd) await sleep(100);
  const unresolved = pending.size;

  const secs = Math.ceil((T.end - T.start) / 1000);
  const tl = Array.from({ length: secs }, (_, s) => ({ s, wOk: 0, wFail: 0, rOk: 0, rFail: 0 }));
  for (const r of recs) {
    const s = Math.floor((r.t0 - T.start) / 1000);
    if (s < 0 || s >= secs) continue;
    const ok = r.stream === 'write' ? r.status === 'VALID' : r.status === 'OK';
    tl[s][(r.stream === 'write' ? 'w' : 'r') + (ok ? 'Ok' : 'Fail')]++;
  }

  const firstOkAfter = stream => {
    const ok = recs.filter(r => r.stream === stream && (stream === 'write' ? r.status === 'VALID' : r.status === 'OK') && r.t0 >= events.restoreAt)
      .sort((a, b) => a.t0 - b.t0)[0];
    return ok ? ok.t0 - events.restoreAt : null;
  };

  const outage = stream => {
    const okT = recs.filter(r => r.stream === stream && (stream === 'write' ? r.status === 'VALID' : r.status === 'OK')).map(r => r.t0).sort((a, b) => a - b);
    let maxGap = 0, gapStart = null;
    for (let i = 1; i < okT.length; i++) {
      const g = okT[i] - okT[i - 1];
      if (g > maxGap && okT[i] >= events.faultAt) { maxGap = g; gapStart = okT[i - 1]; }
    }
    return { maxGapMs: maxGap, gapStartRelFault: gapStart === null ? null : gapStart - events.faultAt };
  };
  const failures = { write: {}, read: {} };
  for (const r of recs) {
    const ok = r.stream === 'write' ? r.status === 'VALID' : r.status === 'OK';
    if (!ok) failures[r.stream][r.failure || r.status] = (failures[r.stream][r.failure || r.status] || 0) + 1;
  }

  const healthyAfterMs = await waitHealthy(180000);
  const hConvT = Date.now();
  let hF = null, hP = null;
  while (Date.now() - hConvT < 120000) {
    hF = await height(farmers[0]); hP = await height(producers[0]);
    if (hF !== null && hF === hP) break;
    await sleep(1000);
  }
  const heightsEqual = hF !== null && hF === hP;
  const writes = recs.filter(r => r.stream === 'write');
  const recon = { validClient: 0, validOnBoth: 0, unknownResolvedValid: 0, unknownResolvedInvalid: 0, unknownNotCommitted: 0,
    endorseRejected: 0, mismatch: 0, lotsChecked: 0, lotsMissing: 0 };
  const lots = [];
  let k = 0;
  await Promise.all(Array.from({ length: 16 }, async (_, w) => {
    while (k < writes.length) {
      const r = writes[k++];
      if (r.status === 'VALID') {
        recon.validClient++;
        const [a, b] = [await txLookup(farmers[w % farmers.length], r.txId), await txLookup(producers[w % producers.length], r.txId)];
        if (a === 0 && b === 0) recon.validOnBoth++; else recon.mismatch++;
        lots.push(JSON.parse(r.result).lotCodes[0]);
      } else if (r.failure.startsWith('ENDORSE:')) {
        recon.endorseRejected++;
        const a = await txLookup(farmers[w % farmers.length], r.txId);
        if (a !== null) recon.mismatch++;
      } else {
        const a = await txLookup(farmers[w % farmers.length], r.txId);
        if (a === 0) recon.unknownResolvedValid++; else if (a === null) recon.unknownNotCommitted++; else recon.unknownResolvedInvalid++;
      }
    }
  }));
  let j = 0;
  await Promise.all(Array.from({ length: 16 }, async (_, w) => {
    while (j < lots.length) {
      const lot = lots[j++];
      for (const cl of [farmers[w % farmers.length], producers[w % producers.length]]) {
        const rec = await L.timedEvaluate(cl.origin, 'GetProductionByLotCode', { args: [lot] });
        recon.lotsChecked++;
        if (rec.status !== 'OK') recon.lotsMissing++;
      }
    }
  }));

  const rel = t => (t === undefined ? null : t - T.start);
  const summary = {
    fault: faultId, label: def.label, rep, wrate: WRATE, rrate: RRATE, baseline: BASELINE, faultWindow: FAULT, observe: OBSERVE,
    startedAt: new Date(epoch(T.start)).toISOString(), faultRelMs: rel(events.faultAt), restoreRelMs: rel(events.restoreAt),
    faultDetail: events.faultDetail, faultError: events.faultError, restoreError: events.restoreError,
    writes: writes.length, reads: recs.length - writes.length, unresolvedAfterDrain: unresolved,
    writeOutage: outage('write'), readOutage: outage('read'),
    writeRecoveryMs: firstOkAfter('write'), readRecoveryMs: firstOkAfter('read'),
    failures, healthyAfterMs, heightsEqual, heightFarmers: hF, heightProducers: hP, reconciliation: recon,
    consistent: heightsEqual && recon.mismatch === 0 && recon.lotsMissing === 0 && recon.unknownResolvedInvalid === 0,
  };
  const meta = { test: 'T5', config: `${CONFIG}-${faultId}`, run: rep };
  fs.writeFileSync(path.join(dir, 'requests.csv'), [L.CSV_HEADER + ',stream',
    ...recs.map((r, i) => `${L.csvRow(meta, i + 1, r)},${r.stream}`)].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'timeline.csv'), ['second,write_ok,write_fail,read_ok,read_fail',
    ...tl.map(x => [x.s, x.wOk, x.wFail, x.rOk, x.rFail].join(','))].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`T5 ${CONFIG}: faults ${FAULTS.join(',')}, ${REPS} repetitions, writes ${WRATE} TPS, reads ${RRATE} TPS, ` +
    `window ${BASELINE}+${FAULT}+${OBSERVE} s`);
  const uids = [];
  for (let i = 0; i < 20; i += 4) uids.push(...await Promise.all([0, 1, 2, 3].map(w => makeBoundUID(w))));
  console.log(`Prepared ${uids.length} UIDs for the reads`);
  await sleep(3000);
  const all = [];
  for (const f of FAULTS) {
    for (let rep = 1; rep <= REPS; rep++) {
      console.log(`== ${f} rep ${rep}`);
      const s = await run(f, rep, uids);
      all.push(s);
      const fmt = v => (v === null || v === undefined ? '-' : `${(v / 1000).toFixed(1)} s`);
      console.log(`   writes: max gap ${fmt(s.writeOutage.maxGapMs)}, recovery after restore ${fmt(s.writeRecoveryMs)}; ` +
        `reads: max gap ${fmt(s.readOutage.maxGapMs)}, recovery ${fmt(s.readRecoveryMs)}`);
      console.log(`   write errors ${JSON.stringify(s.failures.write)}; read errors ${JSON.stringify(s.failures.read)}`);
      console.log(`   reconciliation: ${JSON.stringify(s.reconciliation)}; heights ${s.heightFarmers}/${s.heightProducers} -> ` +
        `${s.consistent ? 'CONSISTENT STATE' : 'WARNING: INCONSISTENCY'}` + (s.faultError ? `; injection error: ${s.faultError}` : ''));
      await sleep(10000);
    }
  }
  fs.writeFileSync(path.join(OUT, 'run_info.json'), JSON.stringify({ test: 'T5', config: CONFIG, faults: FAULTS, reps: REPS,
    wrate: WRATE, rrate: RRATE, baseline: BASELINE, fault: FAULT, observe: OBSERVE, startedAt, finishedAt: new Date().toISOString() }, null, 2));
  console.log(`\nT5 completed: ${all.filter(s => s.consistent).length}/${all.length} runs with a consistent state after recovery`);
  console.log(`Data saved to ${OUT}`);
  closeAll();
}

main().catch(err => { console.error(err); process.exitCode = 1; closeAll(); });
