'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const grpc = require('@grpc/grpc-js');
const { connect, signers, hash } = require('@hyperledger/fabric-gateway');

const CHANNEL = 'milkchannel';
const ENDORSERS = ['FarmersMSP', 'ProducersMSP'];
const IDENTITIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'identities.json'), 'utf8'));
const TX_CODES = { 0: 'VALID', 10: 'ENDORSEMENT_POLICY_FAILURE',
  11: 'MVCC_READ_CONFLICT', 12: 'PHANTOM_READ_CONFLICT' };
const GRPC_CODES = Object.fromEntries(Object.entries(grpc.status).map(([k, v]) => [v, k]));

const now = () => performance.now();
const epoch = t => performance.timeOrigin + t;

function hostAlias(mspId) {
  return mspId === 'FarmersMSP' ? 'peer0.farmers.example.com' : 'peer0.producers.example.com';
}

function openClient(label) {
  const id = IDENTITIES.find(x => x.label === label);
  if (!id) throw new Error(`identity not found in identities.json: ${label}`);
  const grpcClient = new grpc.Client(
    id.peerEndpoint,
    grpc.credentials.createSsl(fs.readFileSync(id.peerTlsCert)),
    { 'grpc.ssl_target_name_override': hostAlias(id.mspId) });
  const gateway = connect({
    client: grpcClient,
    identity: { mspId: id.mspId, credentials: fs.readFileSync(id.certPath) },
    signer: signers.newPrivateKeySigner(crypto.createPrivateKey(fs.readFileSync(id.keyPath))),
    hash: hash.sha256,
    evaluateOptions: () => ({ deadline: Date.now() + 10000 }),
    endorseOptions: () => ({ deadline: Date.now() + 30000 }),
    submitOptions: () => ({ deadline: Date.now() + 30000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 120000 }),
  });
  const network = gateway.getNetwork(CHANNEL);
  return {
    label,
    mspId: id.mspId,
    contract: (cc, name) => network.getContract(cc, name),
    close: () => { gateway.close(); grpcClient.close(); },
  };
}

function errorInfo(err) {
  const parts = [err && err.message ? err.message : String(err)];
  if (err && Array.isArray(err.details)) {
    for (const d of err.details) parts.push(d.message);
  }
  const text = parts.join(' | ');
  const m = text.match(/ERROR_[A-Z0-9_]+/);
  let code = m ? m[0] : null;
  if (!code && err && typeof err.code === 'number' && GRPC_CODES[err.code]) code = `GRPC_${GRPC_CODES[err.code]}`;
  if (!code && /too many requests|concurrency limit/i.test(text)) code = 'PEER_CONCURRENCY_LIMIT';
  return { text, code: code || 'OTHER' };
}

function newRecord(op, kind) {
  return { op, kind, t0: now(), t1: null, t2: null, t3: null,
    txId: '', block: '', status: '', failure: '', result: null, errorText: '' };
}

async function timedSubmit(contract, fn, { args = [], transient } = {}) {
  const rec = newRecord(fn, 'submit');
  try {
    const options = { arguments: args, endorsingOrganizations: ENDORSERS };
    if (transient) options.transientData = transient;
    const proposal = contract.newProposal(fn, options);
    rec.txId = proposal.getTransactionId();
    const tx = await proposal.endorse();  rec.t1 = now();
    const commit = await tx.submit();     rec.t2 = now();
    const st = await commit.getStatus();  rec.t3 = now();
    rec.block = String(st.blockNumber);
    rec.status = TX_CODES[st.code] || `CODE_${st.code}`;
    if (st.successful) rec.result = Buffer.from(tx.getResult()).toString('utf8');
    else rec.failure = rec.status;
  } catch (err) {
    const stage = rec.t1 === null ? 'ENDORSE' : rec.t2 === null ? 'SUBMIT' : 'COMMIT';
    const info = errorInfo(err);
    rec.tErr = now();
    rec.status = 'ERROR';
    rec.failure = `${stage}:${info.code}`;
    rec.errorText = info.text;
  }
  return rec;
}

async function timedEvaluate(contract, fn, { args = [], transient } = {}) {
  const rec = newRecord(fn, 'evaluate');
  try {
    const options = { arguments: args };
    if (transient) options.transientData = transient;
    const out = await contract.evaluate(fn, options);
    rec.t3 = now();
    rec.status = 'OK';
    rec.result = Buffer.from(out).toString('utf8');
  } catch (err) {
    const info = errorInfo(err);
    rec.tErr = now();
    rec.status = 'ERROR';
    rec.failure = `EVALUATE:${info.code}`;
    rec.errorText = info.text;
  }
  return rec;
}

function latencies(rec) {
  const d = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : b - a);
  return { endorse: d(rec.t0, rec.t1), submit: d(rec.t1, rec.t2),
    commit: d(rec.t2, rec.t3), e2e: d(rec.t0, rec.t3) };
}

const CSV_HEADER = 'test,config,run,req_id,op,client,t0_epoch_ms,' +
  'l_endorse_ms,l_submit_ms,l_commit_ms,l_e2e_ms,tx_id,block,status,failure_class,l_error_ms';

function csvRow(meta, reqId, rec) {
  const l = latencies(rec);
  const f = v => (v === null || v === undefined ? '' : v.toFixed(3));
  return [meta.test, meta.config, meta.run, reqId, rec.op, rec.client,
    epoch(rec.t0).toFixed(3), f(l.endorse), f(l.submit), f(l.commit), f(l.e2e),
    rec.txId, rec.block, rec.status, rec.failure,
    f(rec.tErr === undefined ? null : rec.tErr - rec.t0)].join(',');
}

function resultsDir(...parts) {
  const dir = path.join(__dirname, '..', 'results', ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const randomUID = () => crypto.randomBytes(7).toString('hex').toUpperCase();

module.exports = { openClient, timedSubmit, timedEvaluate, latencies,
  CSV_HEADER, csvRow, resultsDir, randomUID, errorInfo };
