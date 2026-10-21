'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

const FARMERS_MSP = 'FarmersMSP';
const PRODUCERS_MSP = 'ProducersMSP';

const AUTH_CHAINCODE = 'userauth';
const PDC_UID = 'uidPdc';
const KEY_PEPPER = 'cfg::pepper';

const MAX_QTY_PER_LOT = 10;
const MAX_LOTS_PER_PRODUCTION = 100;
const MAX_INPUT_LOTS = 100;
const MAX_JSON_BYTES = 16384;

const SCALE = 1000;
const KEY_GLOBAL_COUNTER = 'global::lotCounter';

const LOT_CODE_MODE = 'TXID';

const ProductType = Object.freeze({
  RAW_NON_TRATT: 'RAW_NON_TRATT',
  PASTA: 'PASTA',
  POLVERE: 'POLVERE'
});

const ProcessType = Object.freeze({
  PASS_THROUGH: 'PASS_THROUGH',
  EXTRACTION: 'EXTRACTION',
  KNEADING: 'KNEADING',
  DRYING: 'DRYING',
  MILLING: 'MILLING'
});

const PROCESS_RULES = Object.freeze({
  EXTRACTION:   { output: 'PASTA',         inputs: ['LQ'],        permille: 300 },
  MILLING:      { output: 'POLVERE',       inputs: ['PST'],       permille: 900 },
  DRYING:       { output: 'RAW_NON_TRATT', inputs: ['LQ', 'RLQ'], permille: 950 },
  PASS_THROUGH: { output: 'RAW_NON_TRATT', inputs: ['LQ', 'RLQ'], permille: 1000 },
  KNEADING:     { output: 'RAW_NON_TRATT', inputs: ['LQ', 'RLQ'], permille: 1000 }
});

const OUTPUT_PREFIX_BY_PRODUCT = Object.freeze({
  RAW_NON_TRATT: 'RLQ',
  PASTA: 'PST',
  POLVERE: 'PO'
});

const DEFAULT_TARE_BY_UNIT = Object.freeze({
  KG: '0.02',
  L: '0',
  PZ: '0'
});

const ALLOWED_UNITS = new Set(['KG', 'L', 'PZ']);

const LOT_RE = /^(LQ|PO|PST|RLQ)-\d{4}-[A-Z0-9]{3,16}$/;

const keyProduction = code => `production::${code}`;
const keyTransformation = tid => `transformation::${tid}`;
const keyLot = code => `lot::${code}`;
const keyPackage = id => `package::${id}`;
const keyBinding = id => `binding::${id}`;
const keyCert = id => `cert::${id}`;
const keyUid = commit => `uid::${commit}`;
const keyAvail = (family, code) => `avail::${family}::${code}`;
const keyXInput = (code, tid) => `xformInput::${code}::${tid}`;
const keyXOutput = (code, tid) => `xformOutput::${code}::${tid}`;
const keyBoundLot = code => `bound::lot::${code}`;
const keyPackagedLot = code => `packaged::lot::${code}`;
const keyScan = certId => `scan::${certId}`;
const keyRebind = (bindingId, txId) => `rebind::${bindingId}::${txId}`;

function sha256Hex(value) {
  const input = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value), 'utf8');

  return crypto.createHash('sha256').update(input).digest('hex');
}

function sortObjectDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectDeep);
  }
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = sortObjectDeep(value[key]);
    }
    return result;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortObjectDeep(value));
}

function hashObject(value) {
  return sha256Hex(stableStringify(value));
}

function calculateBinding(hUID, outputLotCode, certPayload) {
  const hBatch = sha256Hex(outputLotCode);
  const hCert = hashObject(certPayload);
  const bindingId = sha256Hex(`v1|${hUID}|${hBatch}|${hCert}`);

  return { bindingId, hUID, hBatch, hCert };
}

function parseJSON(value, errorCode = 'ERROR_INVALID_JSON') {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_JSON_BYTES
  ) {
    throw new Error('ERROR_PAYLOAD_INVALID_OR_TOO_LARGE');
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_) {
    throw new Error(errorCode);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(errorCode);
  }

  return parsed;
}

function requireField(obj, key) {
  if (
    obj === null ||
    typeof obj !== 'object' ||
    !Object.prototype.hasOwnProperty.call(obj, key)
  ) {
    throw new Error(`ERROR_MISSING_FIELD:${key}`);
  }
  return obj[key];
}

function requireString(obj, key) {
  const value = requireField(obj, key);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`ERROR_INVALID_STRING:${key}`);
  }
  return value.trim();
}

function requireStringMax(obj, key, max) {
  const value = requireString(obj, key);
  if (value.length > max) {
    throw new Error(`ERROR_FIELD_TOO_LONG:${key}`);
  }
  return value;
}

function optString(value, max, label) {
  if (value === undefined || value === null) {
    return '';
  }
  const text = String(value).trim();
  if (text.length > max) {
    throw new Error(`ERROR_FIELD_TOO_LONG:${label}`);
  }
  return text;
}

function requireArray(obj, key) {
  const value = requireField(obj, key);
  if (!Array.isArray(value)) {
    throw new Error(`ERROR_INVALID_ARRAY:${key}`);
  }
  return value;
}

function requireEnum(obj, key, values) {
  const value = requireString(obj, key);
  if (!Object.values(values).includes(value)) {
    throw new Error(`ERROR_INVALID_ENUM:${key}`);
  }
  return value;
}

function validateIdentifier(value, label) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(`ERROR_INVALID_IDENTIFIER:${label}`);
  }
  return value;
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('ERROR_DATE_FORMAT');
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error('ERROR_DATE_INVALID');
  }

  return value;
}

function normalizeUnit(value) {
  const unit = String(value || '').toUpperCase();
  if (!ALLOWED_UNITS.has(unit)) {
    throw new Error('ERROR_UNIT_NOT_ALLOWED');
  }
  return unit;
}

function parseQuantity(value, unit) {
  const normalizedUnit = normalizeUnit(unit);

  if (value === null || value === undefined || typeof value === 'boolean') {
    throw new Error('ERROR_QUANTITY_INVALID');
  }

  const text = String(value).trim();

  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) {
    throw new Error('ERROR_QUANTITY_PRECISION');
  }

  const parts = text.split('.');
  const integerPart = Number(parts[0]);
  const fractionalPart = Number((parts[1] || '').padEnd(3, '0'));

  if (!Number.isSafeInteger(integerPart) || !Number.isSafeInteger(fractionalPart)) {
    throw new Error('ERROR_QUANTITY_OVERFLOW');
  }

  const scaled = integerPart * SCALE + fractionalPart;

  if (!Number.isSafeInteger(scaled) || scaled <= 0) {
    throw new Error('ERROR_QUANTITY_INVALID');
  }

  if (normalizedUnit === 'PZ' && scaled % SCALE !== 0) {
    throw new Error('ERROR_PZ_MUST_BE_INTEGER');
  }

  return scaled;
}

function parseTare(value, unit) {
  const text = String(value).trim();
  if (/^0(?:\.0{1,3})?$/.test(text)) {
    return 0;
  }
  return parseQuantity(text, unit);
}

function fromScaled(value) {
  return value / SCALE;
}

function normalizeLimit(value, fallback = 100) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  const limit = Number(value);

  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('ERROR_LIMIT_INVALID');
  }

  return limit;
}

function validateGPS(value) {
  if (value === undefined || value === null) {
    return { lat: null, lon: null };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ERROR_GPS_INVALID');
  }

  const gps = { lat: null, lon: null };

  if (value.lat !== undefined && value.lat !== null) {
    const lat = Number(value.lat);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Error('ERROR_GPS_RANGE');
    }
    gps.lat = lat;
  }

  if (value.lon !== undefined && value.lon !== null) {
    const lon = Number(value.lon);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new Error('ERROR_GPS_RANGE');
    }
    gps.lon = lon;
  }

  return gps;
}

function identityKey(ctx) {
  return sha256Hex(ctx.clientIdentity.getID());
}

function operatorIdentity(ctx) {
  return {
    msp: ctx.clientIdentity.getMSPID(),
    userKey: identityKey(ctx)
  };
}

function txTimestamp(ctx) {
  const ts = ctx.stub.getTxTimestamp();

  const seconds =
    ts.seconds && typeof ts.seconds.toNumber === 'function'
      ? ts.seconds.toNumber()
      : Number(ts.seconds);

  const nanos = Number(ts.nanos || 0);

  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos >= 1000000000
  ) {
    throw new Error('ERROR_TRANSACTION_TIMESTAMP');
  }

  const date = new Date(seconds * 1000 + Math.floor(nanos / 1000000));

  if (Number.isNaN(date.getTime())) {
    throw new Error('ERROR_TRANSACTION_TIMESTAMP');
  }

  return date.toISOString();
}

function txDate(ctx) {
  return txTimestamp(ctx).slice(0, 10);
}

function fmtDateMMDD(date) {
  return validateDate(date).slice(5).replace('-', '');
}

function pad3(value) {
  return String(value).padStart(3, '0');
}

async function getStateObject(ctx, key, errorCode = 'ERROR_NOT_FOUND') {
  const raw = await ctx.stub.getState(key);

  if (!raw || raw.length === 0) {
    throw new Error(errorCode);
  }

  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (_) {
    throw new Error('ERROR_LEDGER_STATE_CORRUPTED');
  }
}

async function getOptionalStateObject(ctx, key) {
  const raw = await ctx.stub.getState(key);

  if (!raw || raw.length === 0) {
    return null;
  }

  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (_) {
    throw new Error('ERROR_LEDGER_STATE_CORRUPTED');
  }
}

async function putStateObject(ctx, key, value) {
  await ctx.stub.putState(key, Buffer.from(stableStringify(value), 'utf8'));
}

async function ensureAbsent(ctx, key, errorCode) {
  const existing = await ctx.stub.getState(key);
  if (existing && existing.length > 0) {
    throw new Error(errorCode);
  }
}

function familyFromLotCode(lotCode) {
  if (typeof lotCode !== 'string') {
    throw new Error('ERROR_LOT_FAMILY_INVALID');
  }
  const match = LOT_RE.exec(lotCode);
  if (!match) {
    throw new Error('ERROR_LOT_FAMILY_INVALID');
  }
  return match[1];
}

async function requireAvailableIndex(ctx, lotCode) {
  return getStateObject(
    ctx,
    keyAvail(familyFromLotCode(lotCode), lotCode),
    'ERROR_LOT_NOT_AVAILABLE'
  );
}

function assertLotAvailable(lot) {
  if (lot.state !== 'AVAILABLE' || lot.consumed === true) {
    throw new Error('ERROR_LOT_NOT_AVAILABLE');
  }
}

async function scanPrefix(ctx, prefix, limit, mapper) {
  const iterator = await ctx.stub.getStateByRange(prefix, `${prefix}~`);
  const out = [];

  try {
    while (out.length < limit) {
      const item = await iterator.next();

      if (
        item.value &&
        item.value.key &&
        item.value.value &&
        item.value.value.length
      ) {
        const value = JSON.parse(item.value.value.toString('utf8'));
        const mapped = mapper(item.value.key.slice(prefix.length), value);
        if (mapped) {
          out.push(mapped);
        }
      }

      if (item.done) {
        break;
      }
    }
  } finally {
    await iterator.close();
  }

  return out;
}

async function allocateLotNumbers(ctx, count) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_LOTS_PER_PRODUCTION) {
    throw new Error('ERROR_LOT_COUNT_INVALID');
  }

  const raw = await ctx.stub.getState(KEY_GLOBAL_COUNTER);
  const current = raw && raw.length ? Number(raw.toString('utf8')) : 0;

  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(current + count)
  ) {
    throw new Error('ERROR_COUNTER_INVALID');
  }

  await ctx.stub.putState(
    KEY_GLOBAL_COUNTER,
    Buffer.from(String(current + count))
  );

  return Array.from({ length: count }, (_, index) => current + index + 1);
}

async function allocateLotSuffixes(ctx, count) {
  if (LOT_CODE_MODE === 'TXID') {
    const txId = ctx.stub.getTxID();

    const base = txId.slice(0, 13).toUpperCase();

    return Array.from({ length: count }, (_, i) => ({
      progressive: i + 1,
      suffix: `${base}${String(i + 1).padStart(3, '0')}`
    }));
  }

  const numbers = await allocateLotNumbers(ctx, count);

  return numbers.map(n => ({
    progressive: n,
    suffix: pad3(n)
  }));
}

async function requireRole(ctx, role) {
  const msp = ctx.clientIdentity.getMSPID();

  if (msp !== FARMERS_MSP && msp !== PRODUCERS_MSP) {
    throw new Error('ERROR_UNAUTHORIZED_MSP');
  }

  if (!['farmer', 'producer', 'consumer', '*'].includes(role)) {
    throw new Error('ERROR_ROLE_UNSUPPORTED');
  }

  if (role === 'farmer' && msp !== FARMERS_MSP) {
    throw new Error('ERROR_UNAUTHORIZED_MSP');
  }

  if (role === 'producer' && msp !== PRODUCERS_MSP) {
    throw new Error('ERROR_UNAUTHORIZED_MSP');
  }

  const response = await ctx.stub.invokeChaincode(
    AUTH_CHAINCODE,
    ['UserAuthContract:CheckAuthorized', role],
    ctx.stub.getChannelID()
  );

  if (!response || response.status !== 200) {
    throw new Error('ERROR_USERAUTH_DENIED');
  }

  let authorization;

  try {
    authorization = JSON.parse(Buffer.from(response.payload).toString('utf8'));
    if (typeof authorization === 'string') {
      authorization = JSON.parse(authorization);
    }
  } catch (_) {
    throw new Error('ERROR_USERAUTH_INVALID_RESPONSE');
  }

  if (
    !authorization ||
    authorization.authorized !== true ||
    (role !== '*' && authorization.role !== role) ||
    authorization.msp !== msp ||
    authorization.userKey !== identityKey(ctx)
  ) {
    throw new Error('ERROR_USERAUTH_DENIED');
  }

  return authorization;
}

function requireAdmin(ctx, onlyMsp = null) {
  const msp = ctx.clientIdentity.getMSPID();

  if (msp !== FARMERS_MSP && msp !== PRODUCERS_MSP) {
    throw new Error('ERROR_UNAUTHORIZED_MSP');
  }

  if (onlyMsp && msp !== onlyMsp) {
    throw new Error('ERROR_ADMIN_ORG_NOT_PERMITTED');
  }

  let attr = null;
  try {
    attr = ctx.clientIdentity.getAttributeValue('role');
  } catch (_) {
    attr = null;
  }

  if (attr === 'admin') {
    return msp;
  }

  const expectedCN =
    msp === FARMERS_MSP
      ? 'Admin@farmers.example.com'
      : 'Admin@producers.example.com';

  const match = /^x509::(.*?)::/.exec(ctx.clientIdentity.getID());

  if (!match || !match[1].split('/').includes(`CN=${expectedCN}`)) {
    throw new Error('ERROR_ADMIN_REQUIRED');
  }

  return msp;
}

function canonicalizeUID(value) {
  if (typeof value !== 'string') {
    throw new Error('ERROR_UID_INVALID');
  }

  const uid = value.trim().replace(/[\s:-]/g, '').toUpperCase();

  if (!/^[0-9A-F]{14}$/.test(uid)) {
    throw new Error('ERROR_UID_INVALID');
  }

  return uid;
}

function readTransient(ctx, field) {
  const transient = ctx.stub.getTransient();

  if (!transient || !transient.has(field)) {
    throw new Error(`ERROR_TRANSIENT_REQUIRED:${field}`);
  }

  const raw = transient.get(field);

  if (!raw || raw.length === 0) {
    throw new Error(`ERROR_TRANSIENT_EMPTY:${field}`);
  }

  return Buffer.from(raw);
}

function readTransientUID(ctx, field) {
  return canonicalizeUID(readTransient(ctx, field).toString('utf8'));
}

async function uidCommit(ctx, canonicalUID) {
  const pepper = await ctx.stub.getPrivateData(PDC_UID, KEY_PEPPER);

  if (!pepper || pepper.length !== 32) {
    throw new Error('ERROR_PEPPER_MISSING');
  }

  return crypto
    .createHmac('sha256', Buffer.from(pepper))
    .update(`UID|v1|${canonicalUID}`, 'utf8')
    .digest('hex');
}

async function readPrivateUID(ctx, commit) {
  const raw = await ctx.stub.getPrivateData(PDC_UID, keyUid(commit));

  if (!raw || raw.length === 0) {
    return null;
  }

  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (_) {
    throw new Error('ERROR_PDC_CORRUPTED');
  }
}

async function writePrivateUID(ctx, commit, value) {
  await ctx.stub.putPrivateData(
    PDC_UID,
    keyUid(commit),
    Buffer.from(stableStringify(value), 'utf8')
  );
}

async function resolveBindingByUID(ctx, canonicalUID) {
  const commit = await uidCommit(ctx, canonicalUID);
  const mapping = await readPrivateUID(ctx, commit);

  if (!mapping) {
    throw new Error('ERROR_UID_UNKNOWN');
  }
  if (mapping.revoked === true) {
    throw new Error('ERROR_UID_REVOKED');
  }
  if (!mapping.bindingId || !mapping.certId) {
    throw new Error('ERROR_PDC_MAPPING_INVALID');
  }

  const binding = await getStateObject(
    ctx,
    keyBinding(mapping.bindingId),
    'ERROR_BINDING_NOT_FOUND'
  );

  if (!Number.isInteger(binding.version) || mapping.version !== binding.version) {
    throw new Error('ERROR_BINDING_VERSION_MISMATCH');
  }
  if (mapping.certId !== binding.certId) {
    throw new Error('ERROR_BINDING_CERT_MISMATCH');
  }
  if (commit !== binding.currentUidCommit) {
    throw new Error('ERROR_UID_BINDING_MISMATCH');
  }

  const certificate = await getStateObject(
    ctx,
    keyCert(binding.certId),
    'ERROR_CERT_NOT_FOUND'
  );

  if (certificate.packageId !== binding.packageId) {
    throw new Error('ERROR_CERT_PACKAGE_MISMATCH');
  }

  const expectedBindingId = sha256Hex(
    `v1|${binding.hUID}|${binding.hBatch}|${binding.hCert}`
  );

  if (
    expectedBindingId !== mapping.bindingId ||
    expectedBindingId !== binding.bindingId
  ) {
    throw new Error('ERROR_BINDING_INTEGRITY_VIOLATION');
  }

  if (hashObject(certificate.payload) !== binding.hCert) {
    throw new Error('ERROR_CERT_INTEGRITY_VIOLATION');
  }

  const lot = await getStateObject(
    ctx,
    keyLot(binding.lotCodeOutput),
    'ERROR_OUTPUT_LOT_NOT_FOUND'
  );

  if (sha256Hex(lot.lotCode) !== binding.hBatch) {
    throw new Error('ERROR_BATCH_INTEGRITY_VIOLATION');
  }

  if (
    certificate.payload.lotCodeOutput !== lot.lotCode ||
    certificate.payload.packageId !== binding.packageId
  ) {
    throw new Error('ERROR_CERT_LINEAGE_MISMATCH');
  }

  const pkg = await getStateObject(
    ctx,
    keyPackage(binding.packageId),
    'ERROR_PACKAGE_NOT_FOUND'
  );

  if (
    pkg.lotCodeOutput !== lot.lotCode ||
    pkg.state !== 'BOUND' ||
    lot.state !== 'BOUND'
  ) {
    throw new Error('ERROR_PACKAGE_LINEAGE_MISMATCH');
  }

  return { commit, mapping, binding, certificate, lot, pkg };
}

async function readMaterialLot(ctx, lotCode) {
  validateIdentifier(lotCode, 'lotCode');

  const production = await getOptionalStateObject(ctx, keyProduction(lotCode));

  if (production) {
    return { key: keyProduction(lotCode), obj: production, isProduction: true };
  }

  const output = await getOptionalStateObject(ctx, keyLot(lotCode));

  if (!output) {
    throw new Error(`ERROR_INPUT_NOT_FOUND:${lotCode}`);
  }

  return { key: keyLot(lotCode), obj: output, isProduction: false };
}

function materialQuantity(record) {
  const obj = record.obj;

  const unit = record.isProduction
    ? normalizeUnit(obj.production.qty.unit)
    : normalizeUnit(obj.unit);

  const qty = record.isProduction ? obj.production.qty.value : obj.qty;

  return { unit, scaled: parseQuantity(qty, unit) };
}

class OriginContract extends Contract {
  constructor() {
    super('OriginContract');
  }

  async InitLedger() {
    return JSON.stringify({ initialized: true });
  }

  async RegisterProduction(ctx, payloadJson) {
    await requireRole(ctx, 'farmer');

    const payload = parseJSON(payloadJson);

    const product = requireField(payload, 'product');
    const production = requireField(payload, 'production');

    const productName = requireStringMax(product, 'name', 120);
    const productSku = requireStringMax(product, 'sku', 64);
    const productCategory = requireStringMax(product, 'category', 64);

    const productionDate = validateDate(requireString(production, 'date'));
    const expiryDate = validateDate(requireString(production, 'expiry'));

    if (productionDate > expiryDate) {
      throw new Error('ERROR_DATE_ORDER');
    }

    const issuedAt = txTimestamp(ctx);
    const maxDate = new Date(Date.parse(issuedAt) + 86400000)
      .toISOString()
      .slice(0, 10);

    if (productionDate > maxDate) {
      throw new Error('ERROR_DATE_IN_FUTURE');
    }

    const qty = requireField(production, 'qty');
    const unit = normalizeUnit(requireString(qty, 'unit'));
    const totalScaled = parseQuantity(requireField(qty, 'value'), unit);

    const maxScaled = MAX_QTY_PER_LOT * SCALE;
    const parts = Math.ceil(totalScaled / maxScaled);

    if (parts > MAX_LOTS_PER_PRODUCTION) {
      throw new Error('ERROR_TOO_MANY_LOTS');
    }

    const plant = production.plant || {};
    const rawMaterial = production.rawMaterial || {};
    const location = production.location || {};
    const quality = production.quality || {};
    const dop = payload.dop || {};

    const gps = validateGPS(location.gps);

    const certs = Array.isArray(quality.certs) ? quality.certs : [];
    if (certs.length > 20) {
      throw new Error('ERROR_TOO_MANY_CERTS');
    }

    const plantInfo = {
      name: optString(plant.name, 120, 'plant.name'),
      line: optString(plant.line, 120, 'plant.line')
    };
    const rawMaterialInfo = {
      id: optString(rawMaterial.id, 120, 'rawMaterial.id'),
      descr: optString(rawMaterial.descr, 300, 'rawMaterial.descr')
    };
    const locationInfo = {
      address: optString(location.address, 200, 'location.address'),
      site: optString(location.site, 120, 'location.site'),
      gps
    };
    const qualityInfo = {
      certs: certs.map(c => optString(c, 100, 'quality.certs')),
      checks: optString(quality.checks, 1000, 'quality.checks')
    };
    const notes = optString(production.notes, 1000, 'notes');
    const varietal = optString(dop.varietal, 100, 'dop.varietal');

    const allocation = await allocateLotSuffixes(ctx, parts);

    const mmdd = fmtDateMMDD(productionDate);
    const txId = ctx.stub.getTxID();

    let remaining = totalScaled;

    const lotCodes = [];
    const lotProgressiveNumbers = [];

    for (let i = 0; i < parts; i++) {
      const { progressive, suffix } = allocation[i];
      const lotCode = `LQ-${mmdd}-${suffix}`;

      const currentScaled = Math.min(remaining, maxScaled);
      remaining -= currentScaled;

      await ensureAbsent(
        ctx,
        keyProduction(lotCode),
        'ERROR_PRODUCTION_ALREADY_EXISTS'
      );

      const asset = {
        lotCode,
        lotProgressiveNumber: progressive,

        product: {
          name: productName,
          sku: productSku.toUpperCase(),
          category: productCategory
        },

        production: {
          date: productionDate,
          expiry: expiryDate,
          qty: { value: fromScaled(currentScaled), unit },
          plant: plantInfo,
          rawMaterial: rawMaterialInfo,
          location: locationInfo,
          quality: qualityInfo,
          notes
        },

        dop: {
          geoZoneOK: dop.geoZoneOK === true,
          varietal,
          harvestWindowOK: dop.harvestWindowOK === true,
          supplierAuthorized: dop.supplierAuthorized === true
        },

        operator: operatorIdentity(ctx),

        txId,
        issuedAt,

        state: 'AVAILABLE',
        consumed: false,
        remainingQty: fromScaled(currentScaled)
      };

      await putStateObject(ctx, keyProduction(lotCode), asset);

      await putStateObject(ctx, keyAvail('LQ', lotCode), {
        qty: fromScaled(currentScaled),
        unit
      });

      lotCodes.push(lotCode);
      lotProgressiveNumbers.push(progressive);
    }

    ctx.stub.setEvent(
      'EVENT_PRODUCTION_REGISTERED',
      Buffer.from(JSON.stringify({ txId, lotCodes, count: lotCodes.length }))
    );

    return JSON.stringify({ lotCodes, lotProgressiveNumbers });
  }

  async GetProductionByLotCode(ctx, lotCode) {
    return JSON.stringify(
      await getStateObject(ctx, keyProduction(lotCode), 'ERROR_NOT_FOUND')
    );
  }
}

class ProcessContract extends Contract {
  constructor() {
    super('ProcessContract');
  }

  async InitLedger() {
    return JSON.stringify({ initialized: true });
  }

  async RegisterTransformation(ctx, transformationJson) {
    await requireRole(ctx, 'producer');

    const data = parseJSON(transformationJson);

    const processType = requireEnum(data, 'processType', ProcessType);
    const rule = PROCESS_RULES[processType];

    const processProfile = requireStringMax(data, 'processProfile', 64);

    if (
      data.singleOutputType !== undefined &&
      data.singleOutputType !== null &&
      String(data.singleOutputType).trim() !== '' &&
      String(data.singleOutputType).trim().toUpperCase() !== rule.output
    ) {
      throw new Error('ERROR_OUTPUT_TYPE_MISMATCH');
    }

    let inputLots;

    if (typeof data.inputLotsCsv === 'string') {
      inputLots = data.inputLotsCsv
        .split(/[,\s;]+/)
        .map(value => value.trim())
        .filter(Boolean);
    } else {
      inputLots = requireArray(data, 'inputs').map(input =>
        requireString(input, 'lotCode')
      );
    }

    if (inputLots.length === 0 || inputLots.length > MAX_INPUT_LOTS) {
      throw new Error('ERROR_INPUT_COUNT_INVALID');
    }

    if (new Set(inputLots).size !== inputLots.length) {
      throw new Error('ERROR_DUPLICATE_INPUT_LOT');
    }

    const records = [];

    let sumInScaled = 0;
    let unitIn = null;
    let allInputsDOP = true;

    for (const lotCode of inputLots) {
      const family = familyFromLotCode(lotCode);

      if (!rule.inputs.includes(family)) {
        throw new Error(`ERROR_INPUT_FAMILY_NOT_ALLOWED:${lotCode}`);
      }

      const record = await readMaterialLot(ctx, lotCode);

      assertLotAvailable(record.obj);
      await requireAvailableIndex(ctx, lotCode);

      await ensureAbsent(
        ctx,
        keyPackagedLot(lotCode),
        'ERROR_INPUT_ALREADY_PACKAGED'
      );

      const quantity = materialQuantity(record);

      if (unitIn === null) {
        unitIn = quantity.unit;
      }

      if (unitIn !== quantity.unit) {
        throw new Error('ERROR_MIXED_UNITS');
      }

      if (!Number.isSafeInteger(sumInScaled + quantity.scaled)) {
        throw new Error('ERROR_QUANTITY_OVERFLOW');
      }

      sumInScaled += quantity.scaled;

      const obj = record.obj;

      const dopOK = obj.dop
        ? obj.dop.geoZoneOK === true &&
          obj.dop.harvestWindowOK === true &&
          obj.dop.supplierAuthorized === true
        : obj.isDOP === true;

      if (!dopOK) {
        allInputsDOP = false;
      }

      records.push({
        ...record,
        lotCode,
        family,
        unit: quantity.unit,
        qtyScaled: quantity.scaled
      });
    }

    if (!Number.isSafeInteger(sumInScaled * rule.permille)) {
      throw new Error('ERROR_QUANTITY_OVERFLOW');
    }

    const sumOutScaled = Math.floor(
      (sumInScaled * rule.permille + 500) / 1000
    );

    if (sumOutScaled <= 0) {
      throw new Error('ERROR_OUTPUT_QTY_ZERO');
    }

    if (unitIn === 'PZ' && sumOutScaled % SCALE !== 0) {
      throw new Error('ERROR_PZ_OUTPUT_INVALID');
    }

    const lossesScaled = sumInScaled - sumOutScaled;

    if (lossesScaled < 0 || sumOutScaled + lossesScaled !== sumInScaled) {
      throw new Error('ERROR_MASS_BALANCE');
    }

    const timestamp = txTimestamp(ctx);
    const txId = ctx.stub.getTxID();
    const ymd = timestamp.slice(0, 10).replace(/-/g, '');

    const tid = `TID-${ymd}-${txId}`;

    await ensureAbsent(ctx, keyTransformation(tid), 'ERROR_TRANSFORMATION_EXISTS');

    const outputType = rule.output;
    const prefix = OUTPUT_PREFIX_BY_PRODUCT[outputType];

    const [allocation] = await allocateLotSuffixes(ctx, 1);
    const lotCode = `${prefix}-${ymd.slice(4)}-${allocation.suffix}`;

    await ensureAbsent(ctx, keyLot(lotCode), 'ERROR_OUTPUT_ALREADY_EXISTS');

    const sumIn = fromScaled(sumInScaled);
    const sumOut = fromScaled(sumOutScaled);
    const losses = fromScaled(lossesScaled);

    const dopDeclared =
      !!data.qualityOutcome && data.qualityOutcome.dopChecksOK === true;

    const isDOP = allInputsDOP && dopDeclared;

    const transformation = {
      tid,
      processType,
      processProfile,

      inputs: records.map(record => ({
        lotCode: record.lotCode,
        qty: fromScaled(record.qtyScaled),
        qtyScaled: record.qtyScaled,
        unit: record.unit
      })),

      outputs: [
        {
          lotCode,
          productType: outputType,
          qty: sumOut,
          qtyScaled: sumOutScaled,
          unit: unitIn
        }
      ],

      massBalance: {
        unit: unitIn,
        sumIn,
        sumOut,
        losses,
        sumInScaled,
        sumOutScaled,
        lossesScaled,
        yieldPermille: rule.permille,
        tolerance: 0,
        ok: true
      },

      qualityOutcome: { dopChecksOK: dopDeclared },

      plant: optString(data.plant, 120, 'plant'),
      line: optString(data.line, 120, 'line'),

      operator: operatorIdentity(ctx),
      timestamp,
      txId
    };

    const outputLot = {
      lotCode,
      lotProgressiveNumber: allocation.progressive,

      productType: outputType,
      fromTID: tid,

      qty: sumOut,
      unit: unitIn,

      isDOP,
      inputLots: inputLots.slice(),

      operator: operatorIdentity(ctx),

      state: 'AVAILABLE',
      consumed: false,
      remainingQty: sumOut
    };

    await putStateObject(ctx, keyTransformation(tid), transformation);
    await putStateObject(ctx, keyLot(lotCode), outputLot);
    await putStateObject(ctx, keyXOutput(lotCode, tid), { tid });
    await putStateObject(ctx, keyAvail(prefix, lotCode), {
      qty: sumOut,
      unit: unitIn
    });

    for (const record of records) {
      record.obj.state = 'CONSUMED';
      record.obj.consumed = true;
      record.obj.remainingQty = 0;
      record.obj.consumedAt = timestamp;
      record.obj.consumedByTID = tid;

      await putStateObject(ctx, record.key, record.obj);
      await ctx.stub.deleteState(keyAvail(record.family, record.lotCode));
      await putStateObject(ctx, keyXInput(record.lotCode, tid), { tid });
    }

    ctx.stub.setEvent(
      'EVENT_TRANSFORMATION_REGISTERED',
      Buffer.from(JSON.stringify({ tid, output: lotCode, processType }))
    );

    return JSON.stringify({
      tid,
      output: lotCode,
      summary: {
        productType: outputType,
        unit: unitIn,
        yield: rule.permille / 1000,
        sumIn,
        sumOut,
        losses,
        ok: true
      }
    });
  }

  async ListAvailableLots(ctx, family, limitStr) {
    const fam = String(family || '').toUpperCase();

    if (!['LQ', 'PO', 'PST', 'RLQ'].includes(fam)) {
      throw new Error('ERROR_INVALID_FAMILY');
    }

    const lots = await scanPrefix(
      ctx,
      `avail::${fam}::`,
      normalizeLimit(limitStr, 50),
      (lotCode, meta) => ({ lotCode, ...meta })
    );

    return JSON.stringify({ family: fam, lots });
  }

  async GetTransformation(ctx, tid) {
    return JSON.stringify(
      await getStateObject(ctx, keyTransformation(tid), 'ERROR_NOT_FOUND')
    );
  }

  async GetLot(ctx, lotCode) {
    return JSON.stringify(
      await getStateObject(ctx, keyLot(lotCode), 'ERROR_NOT_FOUND')
    );
  }
}

async function validatePackagingLot(ctx, lotCode) {
  validateIdentifier(lotCode, 'lotCode');

  const family = familyFromLotCode(lotCode);

  if (!['PO', 'PST', 'RLQ'].includes(family)) {
    throw new Error('ERROR_NOT_OUTPUT_FAMILY');
  }

  const lot = await getStateObject(
    ctx,
    keyLot(lotCode),
    'ERROR_OUTPUT_LOT_NOT_FOUND'
  );

  assertLotAvailable(lot);
  await requireAvailableIndex(ctx, lotCode);

  await ensureAbsent(ctx, keyPackagedLot(lotCode), 'ERROR_LOT_ALREADY_PACKAGED');

  return { lot, family };
}

async function persistPackage(ctx, pkg, lot, family) {
  await ensureAbsent(ctx, keyPackage(pkg.packageId), 'ERROR_PACKAGE_EXISTS');

  await putStateObject(ctx, keyPackage(pkg.packageId), pkg);

  lot.state = 'PACKAGED';
  lot.packageId = pkg.packageId;
  lot.packagedAt = pkg.createdAt;

  await putStateObject(ctx, keyLot(lot.lotCode), lot);
  await ctx.stub.deleteState(keyAvail(family, lot.lotCode));

  await putStateObject(ctx, keyPackagedLot(pkg.lotCodeOutput), {
    lotCode: pkg.lotCodeOutput,
    packageId: pkg.packageId,
    productType: pkg.productType,
    unit: pkg.unit,
    netQty: pkg.netQty,
    packDate: pkg.packDate,
    isDOP: pkg.isDOP,
    createdAt: pkg.createdAt,
    bound: false
  });

  ctx.stub.setEvent(
    'EVENT_PACKAGING_CREATED',
    Buffer.from(
      JSON.stringify({
        packageId: pkg.packageId,
        lotCodeOutput: pkg.lotCodeOutput
      })
    )
  );
}

class PackagingCertContract extends Contract {
  constructor() {
    super('PackagingCertContract');
  }

  async InitLedger() {
    return JSON.stringify({ initialized: true });
  }

  async InitPepper(ctx) {
    requireAdmin(ctx);

    const pepper = readTransient(ctx, 'pepper');

    if (pepper.length !== 32) {
      throw new Error('ERROR_PEPPER_LENGTH');
    }

    const existing = await ctx.stub.getPrivateData(PDC_UID, KEY_PEPPER);

    if (existing && existing.length > 0) {
      throw new Error('ERROR_PEPPER_EXISTS');
    }

    await ctx.stub.putPrivateData(PDC_UID, KEY_PEPPER, pepper);

    return JSON.stringify({ initialized: true });
  }

  async CreatePackageForLot(ctx, lotCode, tareOverrideOpt) {
    await requireRole(ctx, 'producer');

    const { lot, family } = await validatePackagingLot(ctx, lotCode);

    const unit = normalizeUnit(lot.unit);
    const lotScaled = parseQuantity(lot.qty, unit);

    let tareScaled = 0;

    if (
      tareOverrideOpt !== undefined &&
      tareOverrideOpt !== null &&
      String(tareOverrideOpt).trim() !== ''
    ) {
      tareScaled = parseTare(tareOverrideOpt, unit);
    } else {
      tareScaled = parseTare(DEFAULT_TARE_BY_UNIT[unit], unit);
    }

    if (tareScaled >= lotScaled) {
      throw new Error('ERROR_TARE_EXCEEDS_LOT');
    }

    const netScaled = lotScaled - tareScaled;

    const date = txDate(ctx);
    const ymd = date.replace(/-/g, '');
    const packageId = `PKG-${ymd}-${ctx.stub.getTxID()}`;

    const pkg = {
      packageId,
      lotCodeOutput: lotCode,
      productType: lot.productType,

      netQty: fromScaled(netScaled),
      tareQty: fromScaled(tareScaled),
      unit,

      packDate: date,
      isDOP: lot.isDOP === true,

      state: 'VALID',
      createdAt: txTimestamp(ctx),
      operator: operatorIdentity(ctx)
    };

    await persistPackage(ctx, pkg, lot, family);

    return JSON.stringify({
      packageId,
      lotCodeOutput: lotCode,
      productType: pkg.productType,
      unit,
      netQty: pkg.netQty,
      packDate: date,
      isDOP: pkg.isDOP
    });
  }

  async RegisterBindingForPackage(ctx, packageDataJson) {
    await requireRole(ctx, 'producer');

    const canonicalUID = readTransientUID(ctx, 'uidRaw');
    const hUID = await uidCommit(ctx, canonicalUID);

    const data = parseJSON(packageDataJson, 'ERROR_INVALID_JSON_PACKAGE');
    const packageId = requireString(data, 'packageId');

    const pkg = await getStateObject(
      ctx,
      keyPackage(packageId),
      'ERROR_PACKAGE_NOT_FOUND'
    );

    if (pkg.state !== 'VALID') {
      throw new Error('ERROR_PACKAGE_NOT_VALID');
    }

    const lot = await getStateObject(
      ctx,
      keyLot(pkg.lotCodeOutput),
      'ERROR_OUTPUT_LOT_NOT_FOUND'
    );

    if (lot.state !== 'PACKAGED' || lot.packageId !== packageId) {
      throw new Error('ERROR_LOT_NOT_PACKAGED');
    }

    const packagedIndex = await getStateObject(
      ctx,
      keyPackagedLot(lot.lotCode),
      'ERROR_PACKAGE_INDEX_NOT_FOUND'
    );

    if (packagedIndex.packageId !== packageId) {
      throw new Error('ERROR_PACKAGE_INDEX_MISMATCH');
    }

    await ensureAbsent(ctx, keyBoundLot(lot.lotCode), 'ERROR_LOT_ALREADY_BOUND');

    const existingUID = await readPrivateUID(ctx, hUID);

    if (existingUID !== null) {
      throw new Error('ERROR_UID_ALREADY_USED');
    }

    const transformation = await getStateObject(
      ctx,
      keyTransformation(lot.fromTID),
      'ERROR_TRANSFORMATION_NOT_FOUND'
    );

    if (
      !Array.isArray(transformation.inputs) ||
      !transformation.massBalance ||
      transformation.massBalance.ok !== true
    ) {
      throw new Error('ERROR_TRANSFORMATION_INVALID');
    }

    if (!Array.isArray(lot.inputLots) || lot.inputLots.length === 0) {
      throw new Error('ERROR_INPUT_LINEAGE_INVALID');
    }

    const txId = ctx.stub.getTxID();
    const timestamp = txTimestamp(ctx);
    const ymd = timestamp.slice(0, 10).replace(/-/g, '');
    const certId = `CERT-${ymd}-${txId}`;

    await ensureAbsent(ctx, keyCert(certId), 'ERROR_CERT_ALREADY_EXISTS');

    const inputsManifest = transformation.inputs
      .map(input => ({
        lotCode: input.lotCode,
        qty: input.qty,
        qtyScaled: input.qtyScaled,
        unit: input.unit
      }))
      .sort((a, b) =>
        a.lotCode < b.lotCode ? -1 : a.lotCode > b.lotCode ? 1 : 0
      );

    const transformChain = [
      {
        tid: transformation.tid,
        processType: transformation.processType,
        processProfile: transformation.processProfile
      }
    ];

    const certificatePayload = {
      schemaVersion: '2.0',

      certId,
      packageId,

      lotCodeOutput: lot.lotCode,
      productType: lot.productType,

      isDOP: pkg.isDOP === true,

      producerMSP: PRODUCERS_MSP,

      inputLots: lot.inputLots.slice(),

      hashInputsManifest: hashObject(inputsManifest),
      hashTransformChain: hashObject(transformChain),

      massBalanceSummary: { ...transformation.massBalance },

      dopOutcome:
        !!transformation.qualityOutcome &&
        transformation.qualityOutcome.dopChecksOK === true
    };

    const hashes = calculateBinding(hUID, lot.lotCode, certificatePayload);

    await ensureAbsent(
      ctx,
      keyBinding(hashes.bindingId),
      'ERROR_BINDING_ALREADY_EXISTS'
    );

    const binding = {
      bindingId: hashes.bindingId,
      schemaVersion: 'v1',

      certId,
      packageId,
      lotCodeOutput: lot.lotCode,

      hUID: hashes.hUID,
      hBatch: hashes.hBatch,
      hCert: hashes.hCert,

      originalUidCommit: hashes.hUID,
      currentUidCommit: hashes.hUID,
      version: 1,

      createdAt: timestamp,
      createdTxId: txId,
      createdBy: operatorIdentity(ctx)
    };

    const certificate = {
      certId,
      packageId,
      bindingId: hashes.bindingId,

      state: 'VALID',

      issuedAt: timestamp,
      consumedAt: null,
      consumptionTxId: null,
      consumedBy: null,

      pdfIssued: false,

      payload: certificatePayload
    };

    await putStateObject(ctx, keyBinding(hashes.bindingId), binding);
    await putStateObject(ctx, keyCert(certId), certificate);

    await writePrivateUID(ctx, hUID, {
      bindingId: hashes.bindingId,
      certId,
      version: 1,
      revoked: false
    });

    await putStateObject(ctx, keyBoundLot(lot.lotCode), {
      lotCode: lot.lotCode,
      packageId,
      certId,
      bindingId: hashes.bindingId,
      boundAt: timestamp
    });

    lot.state = 'BOUND';
    lot.boundAt = timestamp;
    await putStateObject(ctx, keyLot(lot.lotCode), lot);

    pkg.state = 'BOUND';
    pkg.boundAt = timestamp;
    await putStateObject(ctx, keyPackage(packageId), pkg);

    await putStateObject(ctx, keyPackagedLot(lot.lotCode), {
      ...packagedIndex,
      bound: true,
      boundAt: timestamp
    });

    ctx.stub.setEvent(
      'EVENT_CERT_REGISTERED',
      Buffer.from(
        JSON.stringify({ certId, packageId, bindingId: hashes.bindingId })
      )
    );

    return JSON.stringify({ certId, bindingId: hashes.bindingId });
  }

  async VerifyByUID(ctx) {
    await requireRole(ctx, '*');

    const canonicalUID = readTransientUID(ctx, 'uidRaw');
    const { binding, certificate } = await resolveBindingByUID(ctx, canonicalUID);

    const scan = await getOptionalStateObject(ctx, keyScan(binding.certId));

    return JSON.stringify({
      status: certificate.state,
      certId: binding.certId,
      bindingId: binding.bindingId,
      packageId: binding.packageId,
      lotCodeOutput: binding.lotCodeOutput,
      issuedAt: certificate.issuedAt,
      consumedAt: certificate.consumedAt,
      repeatedScans: scan ? scan.count : 0,
      integrityOK: true
    });
  }

  async ConsumeByUID(ctx) {
    const auth = await requireRole(ctx, 'consumer');

    const canonicalUID = readTransientUID(ctx, 'uidRaw');
    const { binding, certificate } = await resolveBindingByUID(ctx, canonicalUID);

    if (certificate.state === 'CONSUMED') {
      const key = keyScan(binding.certId);
      const scan = (await getOptionalStateObject(ctx, key)) || { count: 0 };

      scan.count += 1;
      scan.lastAt = txTimestamp(ctx);

      await putStateObject(ctx, key, scan);

      ctx.stub.setEvent(
        'EVENT_REPEATED_SCAN',
        Buffer.from(
          JSON.stringify({ certId: binding.certId, count: scan.count })
        )
      );

      return JSON.stringify({
        status: 'ALREADY_CONSUMED',
        certId: binding.certId,
        consumedAt: certificate.consumedAt,
        repeatedScans: scan.count
      });
    }

    if (certificate.state !== 'VALID') {
      throw new Error('ERROR_CERT_STATE_INVALID');
    }

    certificate.state = 'CONSUMED';
    certificate.consumedAt = txTimestamp(ctx);
    certificate.consumptionTxId = ctx.stub.getTxID();
    certificate.consumedBy = auth.userKey;

    await putStateObject(ctx, keyCert(binding.certId), certificate);

    ctx.stub.setEvent(
      'EVENT_CERT_CONSUMED',
      Buffer.from(
        JSON.stringify({
          certId: binding.certId,
          bindingId: binding.bindingId
        })
      )
    );

    return JSON.stringify({
      status: 'CONSUMED',
      certId: binding.certId,
      packageId: certificate.packageId,
      payload: certificate.payload
    });
  }

  async AdminRebind(ctx) {
    requireAdmin(ctx, PRODUCERS_MSP);

    const oldCanonicalUID = readTransientUID(ctx, 'oldUidRaw');
    const newCanonicalUID = readTransientUID(ctx, 'newUidRaw');

    if (oldCanonicalUID === newCanonicalUID) {
      throw new Error('ERROR_REBIND_SAME_UID');
    }

    const { commit: oldCommit, mapping: oldMapping, binding, certificate } =
      await resolveBindingByUID(ctx, oldCanonicalUID);

    if (certificate.state !== 'VALID') {
      throw new Error('ERROR_REBIND_NOT_ALLOWED');
    }

    const newCommit = await uidCommit(ctx, newCanonicalUID);

    const newMapping = await readPrivateUID(ctx, newCommit);

    if (newMapping !== null) {
      throw new Error('ERROR_NEW_UID_ALREADY_USED');
    }

    const nextVersion = binding.version + 1;

    if (!Number.isSafeInteger(nextVersion)) {
      throw new Error('ERROR_BINDING_VERSION_OVERFLOW');
    }

    const when = txTimestamp(ctx);

    binding.version = nextVersion;
    binding.currentUidCommit = newCommit;
    binding.lastReboundAt = when;
    binding.lastReboundTxId = ctx.stub.getTxID();
    binding.lastReboundBy = operatorIdentity(ctx);

    await putStateObject(ctx, keyBinding(binding.bindingId), binding);

    await writePrivateUID(ctx, oldCommit, {
      bindingId: binding.bindingId,
      certId: binding.certId,
      version: oldMapping.version,
      revoked: true
    });

    await writePrivateUID(ctx, newCommit, {
      bindingId: binding.bindingId,
      certId: binding.certId,
      version: nextVersion,
      revoked: false
    });

    await putStateObject(ctx, keyRebind(binding.bindingId, ctx.stub.getTxID()), {
      bindingId: binding.bindingId,
      certId: binding.certId,
      version: nextVersion,
      newUidCommit: newCommit,
      by: identityKey(ctx),
      at: when
    });

    ctx.stub.setEvent(
      'EVENT_REBIND',
      Buffer.from(
        JSON.stringify({
          bindingId: binding.bindingId,
          certId: binding.certId,
          version: nextVersion
        })
      )
    );

    return JSON.stringify({
      bindingId: binding.bindingId,
      certId: binding.certId,
      version: nextVersion
    });
  }

  async VerifyCertIntegrity(ctx, certId) {
    const certificate = await getStateObject(
      ctx,
      keyCert(certId),
      'ERROR_NOT_FOUND'
    );

    const binding = await getStateObject(
      ctx,
      keyBinding(certificate.bindingId),
      'ERROR_BINDING_NOT_FOUND'
    );

    const hCert = hashObject(certificate.payload);
    const hBatch = sha256Hex(certificate.payload.lotCodeOutput);
    const expected = sha256Hex(`v1|${binding.hUID}|${hBatch}|${hCert}`);

    const ok =
      hCert === binding.hCert &&
      hBatch === binding.hBatch &&
      expected === binding.bindingId;

    return JSON.stringify({
      certId,
      bindingId: binding.bindingId,
      ok,
      state: certificate.state
    });
  }

  async GetPackage(ctx, packageId) {
    return JSON.stringify(
      await getStateObject(ctx, keyPackage(packageId), 'ERROR_NOT_FOUND')
    );
  }

  async GetCert(ctx, certId) {
    return JSON.stringify(
      await getStateObject(ctx, keyCert(certId), 'ERROR_NOT_FOUND')
    );
  }

  async GetBinding(ctx, bindingId) {
    return JSON.stringify(
      await getStateObject(ctx, keyBinding(bindingId), 'ERROR_NOT_FOUND')
    );
  }

  async IsLotBound(ctx, lotCode) {
    return JSON.stringify(
      await getStateObject(ctx, keyBoundLot(lotCode), 'ERROR_NOT_FOUND')
    );
  }

  async IsLotPackaged(ctx, lotCode) {
    return JSON.stringify(
      await getStateObject(ctx, keyPackagedLot(lotCode), 'ERROR_NOT_FOUND')
    );
  }

  async GetPackageByLot(ctx, lotCode) {
    const info = await getStateObject(
      ctx,
      keyPackagedLot(lotCode),
      'ERROR_NOT_FOUND'
    );

    return JSON.stringify({
      packageId: info.packageId,
      lotCodeOutput: lotCode,
      productType: info.productType || null,
      unit: info.unit || null,
      netQty: info.netQty ?? null,
      packDate: info.packDate || null,
      isDOP: info.isDOP === true
    });
  }

  async ListLotsNeedingPackaging(ctx, limitStr) {
    const limit = normalizeLimit(limitStr, 100);
    const lots = [];

    for (const family of ['PST', 'PO', 'RLQ']) {
      if (lots.length >= limit) {
        break;
      }

      const found = await scanPrefix(
        ctx,
        `avail::${family}::`,
        limit - lots.length,
        (lotCode, meta) => ({
          lotCode,
          family,
          qty: meta.qty,
          unit: meta.unit
        })
      );

      lots.push(...found);
    }

    return JSON.stringify({ lots });
  }

  async ListLotsNeedingBinding(ctx, limitStr) {
    const limit = normalizeLimit(limitStr, 100);

    const lots = await scanPrefix(
      ctx,
      'packaged::lot::',
      limit,
      (lotCode, info) =>
        info.bound === true
          ? null
          : {
              lotCode,
              family: familyFromLotCode(lotCode),
              qty: info.netQty,
              unit: info.unit,
              packageId: info.packageId
            }
    );

    return JSON.stringify({ lots });
  }
}

module.exports.contracts = [
  OriginContract,
  ProcessContract,
  PackagingCertContract
];
