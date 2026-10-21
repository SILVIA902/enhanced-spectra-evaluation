'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const today = new Date().toISOString().slice(0, 10);
const expiry = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

let failures = 0;
const records = [];

function show(rec) {
  const l = L.latencies(rec);
  const f = v => (v === null ? '      -' : v.toFixed(1).padStart(7));
  console.log(`${rec.op.padEnd(26)} ${rec.status.padEnd(10)}` +
    ` endorse${f(l.endorse)}  submit${f(l.submit)}  commit${f(l.commit)}  total${f(l.e2e)} ms`);
  if (rec.status === 'ERROR') console.log(`   -> ${rec.failure}: ${rec.errorText.slice(0, 300)}`);
}

function check(cond, msg) {
  console.log(`   check: ${msg} -> ${cond ? 'OK' : 'FAILED'}`);
  if (!cond) failures++;
}

async function step(client, promise) {
  const rec = await promise;
  rec.client = client.label;
  records.push(rec);
  show(rec);
  const ok = rec.kind === 'submit' ? rec.status === 'VALID' : rec.status === 'OK';
  if (!ok) throw new Error(`${rec.op} failed (${rec.failure})`);
  return JSON.parse(rec.result);
}

async function main() {
  const farmer = L.openClient('bench-farmer');
  const producer = L.openClient('bench-producer');
  const consumer = L.openClient('bench-consumer');
  const origin = farmer.contract('certificate', 'OriginContract');
  const process = producer.contract('certificate', 'ProcessContract');
  const pack = producer.contract('certificate', 'PackagingCertContract');
  const auth = producer.contract('userauth', 'UserAuthContract');
  const verify = consumer.contract('certificate', 'PackagingCertContract');
  const uid = L.randomUID();

  try {
    const prod = await step(farmer, L.timedSubmit(origin, 'RegisterProduction', { args: [JSON.stringify({
      product: { name: 'Licorice root', sku: 'BENCH-LQ', category: 'raw' },
      production: { date: today, expiry, qty: { value: '10', unit: 'KG' } },
      dop: { geoZoneOK: true, harvestWindowOK: true, supplierAuthorized: true, varietal: 'bench' } })] }));
    const lq = prod.lotCodes[0];
    check(prod.lotCodes.length === 1, `one lot created (${lq})`);

    const tr = await step(producer, L.timedSubmit(process, 'RegisterTransformation', { args: [JSON.stringify({
      processType: 'EXTRACTION', processProfile: 'BENCH_PILOT', inputLotsCsv: lq,
      qualityOutcome: { dopChecksOK: true } })] }));
    check(tr.summary.sumIn === 10 && tr.summary.sumOut === 3 && tr.summary.losses === 7 && tr.summary.ok === true,
      `mass balance 10 -> 3 + 7 losses (${tr.output})`);

    const lqState = await step(farmer, L.timedEvaluate(origin, 'GetProductionByLotCode', { args: [lq] }));
    check(lqState.state === 'CONSUMED', 'input lot set to CONSUMED');

    const pkg = await step(producer, L.timedSubmit(pack, 'CreatePackageForLot', { args: [tr.output, ''] }));
    check(pkg.netQty === 2.98, `package with net weight 2.98 kg (${pkg.packageId.slice(0, 24)}...)`);

    const bind = await step(producer, L.timedSubmit(pack, 'RegisterBindingForPackage', {
      args: [JSON.stringify({ packageId: pkg.packageId })],
      transient: { uidRaw: Buffer.from(uid, 'utf8') } }));
    check(!!bind.certId && !!bind.bindingId, 'certificate and binding created');

    const cert = await step(producer, L.timedEvaluate(pack, 'GetCert', { args: [bind.certId] }));
    check(cert.state === 'VALID', 'certificate VALID');

    const integ = await step(producer, L.timedEvaluate(pack, 'VerifyCertIntegrity', { args: [bind.certId] }));
    check(integ.ok === true, 'cryptographic integrity verified');

    const authz = await step(producer, L.timedEvaluate(auth, 'CheckAuthorized', { args: ['producer'] }));
    check(authz.authorized === true, 'producer authorized');

    const v1 = await step(consumer, L.timedEvaluate(verify, 'VerifyByUID', {
      transient: { uidRaw: Buffer.from(uid, 'utf8') } }));
    check(v1.status === 'VALID' && v1.integrityOK === true, 'VerifyByUID before consumption: VALID');

    const c1 = await step(consumer, L.timedSubmit(verify, 'ConsumeByUID', {
      transient: { uidRaw: Buffer.from(uid, 'utf8') } }));
    check(c1.status === 'CONSUMED', 'first consumption: CONSUMED');

    const v2 = await step(consumer, L.timedEvaluate(verify, 'VerifyByUID', {
      transient: { uidRaw: Buffer.from(uid, 'utf8') } }));
    check(v2.status === 'CONSUMED', 'VerifyByUID after consumption: CONSUMED');

    const c2 = await step(consumer, L.timedSubmit(verify, 'ConsumeByUID', {
      transient: { uidRaw: Buffer.from(uid, 'utf8') } }));
    check(c2.status === 'ALREADY_CONSUMED' && c2.repeatedScans === 1,
      'second consumption: ALREADY_CONSUMED, repeated scan logged');
  } catch (err) {
    failures++;
    console.log(`\nABORTED: ${err.message}`);
  } finally {
    farmer.close(); producer.close(); consumer.close();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(L.resultsDir('T0_pilot'), `pilot_${stamp}.csv`);
  const meta = { test: 'T0', config: 'pilot', run: 1 };
  fs.writeFileSync(file, [L.CSV_HEADER, ...records.map((r, i) => L.csvRow(meta, i + 1, r))].join('\n') + '\n');
  console.log(`\nData saved to ${file}`);
  console.log(failures === 0 ? 'PILOT PASSED' : `PILOT FAILED (${failures} problems)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
