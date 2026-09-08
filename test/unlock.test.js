import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startEnrollmentServer, startLockedServer } from '../src/server/server.js';

const passkey = {
  credentialId: Buffer.from('credential').toString('base64url'),
  publicKey: Buffer.from('public key').toString('base64url'),
  counter: 2,
  transports: ['internal'],
  prfSalt: Buffer.alloc(32, 3).toString('base64')
};

function fakeVault() {
  return {
    vaultId: '73a1f10f-9275-47fb-89e2-1f9a65cdbc91',
    list: () => [],
    folders: () => [],
    summary: () => ({ files: 0, bytes: 0 })
  };
}

function post(app, path, value) {
  return fetch(app.origin + path, {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
}

test('locked server advertises localhost and restricts assets and vault APIs', async t => {
  const prepared = { passkey, closeCalls: 0, close() { this.closeCalls++; } };
  const service = { async beginAuthentication(value) { assert.equal(value, passkey); return { challenge: 'options' }; } };
  const app = await startLockedServer(prepared, { passkeyService: service });
  t.after(() => app.close());

  assert.match(app.origin, /^http:\/\/localhost:\d+$/);
  assert.equal((await fetch(app.origin + '/')).status, 200);
  assert.equal((await fetch(app.origin + '/styles.css')).status, 200);
  assert.equal((await fetch(app.origin + '/app.js')).status, 404);
  assert.equal((await fetch(app.origin + '/api/entries')).status, 401);
  assert.equal((await post(app, '/api/session', {})).status, 401);
  const options = await post(app, '/api/passkey/authentication/options', {});
  assert.equal(options.status, 200);
  assert.deepEqual(await options.json(), { challenge: 'options' });

  const forged = await new Promise((resolve, reject) => {
    const req = request(app.origin + '/', { headers: { Host: `127.0.0.1:${new URL(app.origin).port}` } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(forged, 403);
});

test('verified passkey unlock transitions the same server and issues a session', async t => {
  const vault = fakeVault(), prfOutput = Buffer.alloc(32, 8), calls = [];
  const prepared = {
    passkey,
    async unlockWithPasskey(prf, counter) { calls.push(['unlock', prf, counter]); return vault; },
    async close() {}
  };
  const service = {
    async beginAuthentication() { return { challenge: 'begin' }; },
    async verifyAuthentication(credential, prf) { calls.push(['verify', credential, prf]); return { prfOutput, newCounter: 7 }; }
  };
  let unlocked;
  const app = await startLockedServer(prepared, { passkeyService: service, onUnlock(value) { unlocked = value; } });
  t.after(() => app.close());
  await post(app, '/api/passkey/authentication/options', {});
  const response = await post(app, '/api/passkey/authentication/verify', { credential: { id: 'credential' }, prf: 'prf-result' });

  assert.equal(response.status, 200);
  assert.equal(unlocked, vault);
  assert.deepEqual(calls[0], ['verify', { id: 'credential' }, 'prf-result']);
  assert.equal(calls[1][0], 'unlock');
  assert.equal(calls[1][1], prfOutput);
  assert.equal(calls[1][2], 7);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const { csrfToken } = await response.json();
  assert.match(csrfToken, /^[a-f0-9]{64}$/);
  assert.equal((await fetch(app.origin + '/api/entries', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(app.origin + '/app.js')).status, 200);
});

test('failed passkey verification is safe and leaves the server locked', async t => {
  const prepared = { passkey, async close() {} };
  const service = {
    async beginAuthentication() { return {}; },
    async verifyAuthentication() { throw new Error('signature details and credential leaked'); }
  };
  const app = await startLockedServer(prepared, { passkeyService: service });
  t.after(() => app.close());
  await post(app, '/api/passkey/authentication/options', {});
  const response = await post(app, '/api/passkey/authentication/verify', { credential: {}, prf: 'bad' });
  assert.equal(response.status, 401);
  assert.doesNotMatch((await response.json()).error, /signature|credential leaked/i);
  assert.equal((await fetch(app.origin + '/api/entries')).status, 401);
});

test('terminal recovery transitions locked server and returns a fresh launch URL', async t => {
  const vault = fakeVault(), password = Buffer.from('recovery password');
  let received, unlocked;
  const prepared = {
    passkey,
    async unlockWithPassword(value) { received = Buffer.from(value); return vault; },
    async close() {}
  };
  const app = await startLockedServer(prepared, { passkeyService: {}, onUnlock(value) { unlocked = value; } });
  t.after(() => app.close());
  const launchUrl = await app.recover(password);
  assert.equal(received.toString(), password.toString());
  assert.equal(unlocked, vault);
  assert.match(launchUrl, new RegExp(`^${app.origin}/#`));
  const token = new URL(launchUrl).hash.slice(1);
  const session = await post(app, '/api/session', { token });
  assert.equal(session.status, 200);
});

test('enrollment verifies attestation then confirmation before enrolling and authorizing', async t => {
  const vault = fakeVault(), password = Buffer.from('recovery password'), prfOutput = Buffer.alloc(32, 9), calls = [];
  vault.enrollPasskey = async (passwordCopy, metadata, prf) => {
    calls.push(['enroll', Buffer.from(passwordCopy), metadata, prf]);
  };
  const metadata = { ...passkey, prfOutput, newCounter: 6 };
  const service = {
    async beginRegistration(value) { calls.push(['begin', value]); return { challenge: 'registration' }; },
    async verifyRegistration(credential) { calls.push(['attestation', credential]); return { challenge: 'confirmation' }; },
    async verifyRegistrationConfirmation(credential, prf) { calls.push(['confirmation', credential, prf]); return metadata; }
  };
  let enrolled;
  const app = await startEnrollmentServer(vault, password, { passkeyService: service, onEnroll(value) { enrolled = value; } });
  t.after(() => app.close());

  assert.equal((await fetch(app.origin + '/api/entries')).status, 401);
  const options = await post(app, '/api/passkey/registration/options', {});
  assert.equal(options.status, 200);
  const confirmation = await post(app, '/api/passkey/registration/verify', { credential: { id: 'new' } });
  assert.deepEqual(await confirmation.json(), { challenge: 'confirmation' });
  const response = await post(app, '/api/passkey/registration/confirm', { credential: { id: 'new' }, prf: 'result' });
  assert.equal(response.status, 200);
  assert.equal(enrolled, vault);
  assert.deepEqual(calls[0][1], {
    userID: Buffer.from(vault.vaultId),
    userName: vault.vaultId,
    userDisplayName: 'SecretCLI vault'
  });
  assert.deepEqual(calls[3][2], passkey);
  assert.equal(calls[3][3], prfOutput);
  assert.equal((await fetch(app.origin + '/api/entries', { headers: { Cookie: response.headers.get('set-cookie').split(';')[0] } })).status, 200);
  assert.equal(password.toString(), 'recovery password');
});

test('passkey requests allow 64 KiB while ordinary JSON remains limited to 16 KiB', async t => {
  const vault = fakeVault();
  const prepared = { passkey, async unlockWithPasskey() { return vault; }, async close() {} };
  const service = {
    async beginAuthentication() { return {}; },
    async verifyAuthentication() { return { prfOutput: Buffer.alloc(32), newCounter: 3 }; }
  };
  const app = await startLockedServer(prepared, { passkeyService: service });
  t.after(() => app.close());
  const credential = { padding: 'x'.repeat(20_000) };
  const unlocked = await post(app, '/api/passkey/authentication/verify', { credential, prf: 'value' });
  assert.equal(unlocked.status, 200);
  const cookie = unlocked.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await unlocked.json();
  const ordinary = await fetch(app.origin + '/api/folders', {
    method: 'POST',
    headers: { Origin: app.origin, Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(20_000) })
  });
  assert.equal(ordinary.status, 413);
});

test('closing a locked server releases the prepared vault once', async () => {
  const prepared = { passkey, closeCalls: 0, async close() { this.closeCalls++; } };
  const app = await startLockedServer(prepared, { passkeyService: {} });
  await Promise.all([app.close(), app.close()]);
  assert.equal(prepared.closeCalls, 1);
});

test('closing during passkey unlock asks the prepared vault to cancel ownership', async () => {
  let rejectUnlock;
  let started;
  const unlockStarted = new Promise(resolve => { started = resolve; });
  const unlocking = new Promise((_resolve, reject) => { rejectUnlock = reject; });
  const prepared = {
    passkey,
    unlockWithPasskey() { started(); return unlocking; },
    async close() { rejectUnlock(new Error('Prepared vault is closed')); await unlocking.catch(() => {}); }
  };
  const service = { async verifyAuthentication() { return { prfOutput: Buffer.alloc(32), newCounter: 3 }; } };
  const app = await startLockedServer(prepared, { passkeyService: service });
  const response = post(app, '/api/passkey/authentication/verify', { credential: {}, prf: 'value' }).catch(() => undefined);
  await unlockStarted;
  await app.close();
  await response;
});

test('closing during enrollment waits before clearing the private password copy', async () => {
  const password = Buffer.from('recovery password');
  let passwordCopy, releaseEnrollment, started;
  const enrollmentStarted = new Promise(resolve => { started = resolve; });
  const enrollmentGate = new Promise(resolve => { releaseEnrollment = resolve; });
  const vault = fakeVault();
  vault.enrollPasskey = async value => {
    passwordCopy = value;
    started();
    await enrollmentGate;
  };
  const service = {
    async verifyRegistrationConfirmation() {
      return { ...passkey, prfOutput: Buffer.alloc(32), newCounter: 3 };
    }
  };
  const app = await startEnrollmentServer(vault, password, { passkeyService: service });
  const response = post(app, '/api/passkey/registration/confirm', { credential: {}, prf: 'value' }).catch(() => undefined);
  await enrollmentStarted;
  const closing = app.close();
  assert.equal(passwordCopy.toString(), password.toString());
  releaseEnrollment();
  await closing;
  await response;
  assert.deepEqual(passwordCopy, Buffer.alloc(passwordCopy.length));
  assert.equal(password.toString(), 'recovery password');
});
