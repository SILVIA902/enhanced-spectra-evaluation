'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

const FARMERS_MSP = 'FarmersMSP';
const PRODUCERS_MSP = 'ProducersMSP';

const MSP_ROLE = Object.freeze({
  [FARMERS_MSP]: 'farmer',
  [PRODUCERS_MSP]: 'producer'
});

const STATES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REVOKED: 'REVOKED'
});

const sha256 = x =>
  crypto.createHash('sha256').update(String(x), 'utf8').digest('hex');

const userKey = x => `user::${x}`;

const keyPattern = /^[0-9a-f]{64}$/;
const labelPattern = /^[A-Za-z0-9 _.@-]{1,80}$/;

function txSeconds(ctx) {
  const t = ctx.stub.getTxTimestamp();
  return typeof t.seconds.toNumber === 'function'
    ? t.seconds.toNumber()
    : Number(t.seconds);
}

function timestamp(ctx) {
  const t = ctx.stub.getTxTimestamp();
  return new Date(
    txSeconds(ctx) * 1000 + Math.floor(Number(t.nanos || 0) / 1e6)
  ).toISOString();
}

function identityKey(ctx) {
  return sha256(ctx.clientIdentity.getID());
}

function callerMsp(ctx) {
  const msp = ctx.clientIdentity.getMSPID();
  if (!MSP_ROLE[msp]) {
    throw new Error('ERROR_UNSUPPORTED_MSP');
  }
  return msp;
}

function isAdmin(ctx) {
  const msp = callerMsp(ctx);

  let attr = null;
  try {
    attr = ctx.clientIdentity.getAttributeValue('role');
  } catch (_) {
    attr = null;
  }
  if (attr === 'admin') {
    return true;
  }

  const cn =
    msp === FARMERS_MSP
      ? 'Admin@farmers.example.com'
      : 'Admin@producers.example.com';

  const subject = /^x509::(.*?)::/.exec(ctx.clientIdentity.getID());

  return !!(
    subject &&
    subject[1].split('/').some(x => x === `CN=${cn}`)
  );
}

function requireAdmin(ctx) {
  const msp = callerMsp(ctx);
  if (!isAdmin(ctx)) {
    throw new Error('ERROR_ADMIN_REQUIRED');
  }
  return msp;
}

function roleAllowed(msp, role) {
  return role === MSP_ROLE[msp] || role === 'consumer';
}

async function readUser(ctx, key) {
  if (!keyPattern.test(String(key))) {
    throw new Error('ERROR_USERKEY_INVALID');
  }
  const raw = await ctx.stub.getState(userKey(key));
  if (!raw || !raw.length) {
    throw new Error('ERROR_USER_NOT_FOUND');
  }
  return JSON.parse(raw.toString('utf8'));
}

async function saveUser(ctx, rec) {
  await ctx.stub.putState(
    userKey(rec.userKey),
    Buffer.from(JSON.stringify(rec))
  );
}

function view(rec) {
  const {
    userKey: key, label, role, msp, status,
    registeredAt, approvedAt, approvedBy, revokedAt
  } = rec;

  return {
    userKey: key, label, role, msp, status,
    registeredAt, approvedAt, approvedBy, revokedAt
  };
}

async function audit(ctx, action, target, extra = {}) {
  const rec = {
    action,
    target,
    actor: identityKey(ctx),
    msp: callerMsp(ctx),
    txId: ctx.stub.getTxID(),
    at: timestamp(ctx),
    ...extra
  };

  const key =
    `audit::${String(txSeconds(ctx)).padStart(12, '0')}::${ctx.stub.getTxID()}`;

  await ctx.stub.putState(key, Buffer.from(JSON.stringify(rec)));
}

async function collect(ctx, prefix, limit, predicate) {
  const n = Number(limit || 100);

  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new Error('ERROR_LIMIT_INVALID');
  }

  const it = await ctx.stub.getStateByRange(prefix, `${prefix}~`);
  const out = [];

  try {
    while (out.length < n) {
      const item = await it.next();

      if (item.value && item.value.value && item.value.value.length) {
        const rec = JSON.parse(item.value.value.toString('utf8'));
        if (predicate(rec)) {
          out.push(rec);
        }
      }

      if (item.done) {
        break;
      }
    }
  } finally {
    await it.close();
  }

  return out;
}

class UserAuthContract extends Contract {
  constructor() {
    super('UserAuthContract');
  }

  async InitLedger() {
    return JSON.stringify({
      initialized: true,
      seededCredentials: false
    });
  }

  async RequestUserRegistration(ctx, label, requestedRole) {
    const msp = callerMsp(ctx);

    if (isAdmin(ctx)) {
      throw new Error('ERROR_ADMIN_NOT_REGISTRABLE');
    }

    const lbl = String(label || '').trim();
    if (!labelPattern.test(lbl)) {
      throw new Error('ERROR_LABEL_INVALID');
    }

    const role = String(requestedRole || MSP_ROLE[msp]).trim().toLowerCase();
    if (!roleAllowed(msp, role)) {
      throw new Error('ERROR_ROLE_NOT_ALLOWED');
    }

    const key = identityKey(ctx);
    const old = await ctx.stub.getState(userKey(key));
    if (old && old.length) {
      throw new Error('ERROR_USER_EXISTS');
    }

    const rec = {
      userKey: key,
      label: lbl,
      role,
      msp,
      status: STATES.PENDING,
      registeredAt: timestamp(ctx),
      approvedAt: null,
      approvedBy: null,
      revokedAt: null
    };

    await saveUser(ctx, rec);
    await audit(ctx, 'REQUEST_REGISTRATION', key, { role });

    ctx.stub.setEvent(
      'EVENT_USER_REQUESTED',
      Buffer.from(JSON.stringify({ userKey: key, msp }))
    );

    return JSON.stringify(view(rec));
  }

  async ApproveUser(ctx, key) {
    const msp = requireAdmin(ctx);
    const rec = await readUser(ctx, key);

    if (rec.msp !== msp) {
      throw new Error('ERROR_CROSS_ORG_ADMIN');
    }
    if (rec.status !== STATES.PENDING) {
      throw new Error('ERROR_INVALID_STATE');
    }

    rec.status = STATES.APPROVED;
    rec.approvedAt = timestamp(ctx);
    rec.approvedBy = identityKey(ctx);

    await saveUser(ctx, rec);
    await audit(ctx, 'APPROVE_USER', key, { role: rec.role });

    ctx.stub.setEvent(
      'EVENT_USER_APPROVED',
      Buffer.from(JSON.stringify({ userKey: key }))
    );

    return JSON.stringify(view(rec));
  }

  async RevokeUser(ctx, key) {
    const msp = requireAdmin(ctx);
    const rec = await readUser(ctx, key);

    if (rec.msp !== msp) {
      throw new Error('ERROR_CROSS_ORG_ADMIN');
    }
    if (rec.status === STATES.REVOKED) {
      throw new Error('ERROR_ALREADY_REVOKED');
    }

    rec.status = STATES.REVOKED;
    rec.revokedAt = timestamp(ctx);

    await saveUser(ctx, rec);
    await audit(ctx, 'REVOKE_USER', key);

    ctx.stub.setEvent(
      'EVENT_USER_REVOKED',
      Buffer.from(JSON.stringify({ userKey: key }))
    );

    return JSON.stringify(view(rec));
  }

  async ChangeRole(ctx, key, requestedRole) {
    const msp = requireAdmin(ctx);
    const rec = await readUser(ctx, key);

    if (rec.msp !== msp) {
      throw new Error('ERROR_CROSS_ORG_ADMIN');
    }
    if (rec.status !== STATES.APPROVED) {
      throw new Error('ERROR_USER_NOT_APPROVED');
    }

    const role = String(requestedRole || '').trim().toLowerCase();

    if (!roleAllowed(msp, role)) {
      throw new Error('ERROR_ROLE_NOT_ALLOWED');
    }
    if (rec.role === role) {
      throw new Error('ERROR_ROLE_UNCHANGED');
    }

    const previous = rec.role;
    rec.role = role;

    await saveUser(ctx, rec);
    await audit(ctx, 'CHANGE_ROLE', key, { from: previous, to: role });

    ctx.stub.setEvent(
      'EVENT_ROLE_CHANGED',
      Buffer.from(JSON.stringify({ userKey: key, from: previous, to: role }))
    );

    return JSON.stringify(view(rec));
  }

  async CheckAuthorized(ctx, rolesCsv) {
    const msp = callerMsp(ctx);
    const key = identityKey(ctx);
    const rec = await readUser(ctx, key);

    if (
      rec.msp !== msp ||
      rec.status !== STATES.APPROVED ||
      !roleAllowed(msp, rec.role)
    ) {
      throw new Error('ERROR_NOT_AUTHORIZED');
    }

    const roles = String(rolesCsv || '')
      .split(',')
      .map(x => x.trim().toLowerCase());

    if (!roles.includes(rec.role) && !roles.includes('*')) {
      throw new Error('ERROR_ROLE_NOT_PERMITTED');
    }

    return JSON.stringify({
      authorized: true,
      userKey: key,
      role: rec.role,
      msp
    });
  }

  async GetMyIdentity(ctx) {
    const key = identityKey(ctx);
    const raw = await ctx.stub.getState(userKey(key));

    return JSON.stringify({
      userKey: key,
      msp: callerMsp(ctx),
      isAdmin: isAdmin(ctx),
      registration:
        raw && raw.length ? view(JSON.parse(raw.toString('utf8'))) : null
    });
  }

  async GetUser(ctx, key) {
    return JSON.stringify(view(await readUser(ctx, key)));
  }

  async GetPendingUsers(ctx, limit) {
    const msp = requireAdmin(ctx);

    return JSON.stringify(
      (
        await collect(
          ctx,
          'user::',
          limit,
          r => r.msp === msp && r.status === STATES.PENDING
        )
      ).map(view)
    );
  }

  async ListUsers(ctx, status, limit) {
    const msp = requireAdmin(ctx);
    const wanted = String(status || '').toUpperCase();

    if (wanted && !Object.values(STATES).includes(wanted)) {
      throw new Error('ERROR_STATUS_INVALID');
    }

    return JSON.stringify(
      (
        await collect(
          ctx,
          'user::',
          limit,
          r => r.msp === msp && (!wanted || r.status === wanted)
        )
      ).map(view)
    );
  }

  async GetAuditLog(ctx, limit) {
    const msp = requireAdmin(ctx);

    return JSON.stringify(
      await collect(ctx, 'audit::', limit, r => r.msp === msp)
    );
  }
}

module.exports = UserAuthContract;
