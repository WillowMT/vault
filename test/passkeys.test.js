import test from 'node:test';
import assert from 'node:assert/strict';
import { createPasskeyService } from '../src/auth/passkeys.js';

const origin = 'http://localhost:43127';
const credentialId = Buffer.from('credential-id').toString('base64url');
const publicKey = Buffer.from('cose-public-key');
const prfOutput = Buffer.alloc(32, 9);

function createHarness(overrides = {}) {
  let now = 1_000;
  let randomValue = 0;
  const calls = {
    registrationOptions: [],
    registrationVerification: [],
    authenticationOptions: [],
    authenticationVerification: []
  };
  const credential = {
    id: credentialId,
    publicKey,
    counter: 4,
    transports: ['internal', 'hybrid']
  };
  const dependencies = {
    now: () => now,
    randomBytes: size => Buffer.alloc(size, ++randomValue),
    async generateRegistrationOptions(options) {
      calls.registrationOptions.push(options);
      return { challenge: Buffer.from(options.challenge).toString('base64url'), options };
    },
    async verifyRegistrationResponse(options) {
      calls.registrationVerification.push(options);
      return { verified: true, registrationInfo: { credential } };
    },
    async generateAuthenticationOptions(options) {
      calls.authenticationOptions.push(options);
      return { challenge: Buffer.from(options.challenge).toString('base64url'), options };
    },
    async verifyAuthenticationResponse(options) {
      calls.authenticationVerification.push(options);
      return { verified: true, authenticationInfo: { credentialID: options.response.id, newCounter: 7 } };
    },
    ...overrides
  };
  return {
    calls,
    credential,
    service: createPasskeyService({ origin, ...dependencies }),
    advance(milliseconds) { now += milliseconds; }
  };
}

function storedPasskey(overrides = {}) {
  return {
    credentialId,
    publicKey: publicKey.toString('base64url'),
    counter: 4,
    transports: ['internal', 'hybrid'],
    prfSalt: Buffer.alloc(32, 2).toString('base64'),
    ...overrides
  };
}

async function reachRegistrationConfirmation(harness) {
  const creation = await harness.service.beginRegistration({
    userID: Buffer.from('vault-user'),
    userName: 'vault',
    userDisplayName: 'SecretCLI vault'
  });
  const confirmation = await harness.service.verifyRegistration({ id: credentialId });
  return { creation, confirmation };
}

test('registration and confirmation options require a local platform passkey, UV, and PRF', async () => {
  const harness = createHarness();
  const { creation, confirmation } = await reachRegistrationConfirmation(harness);
  const registration = harness.calls.registrationOptions[0];
  const authentication = harness.calls.authenticationOptions[0];

  assert.equal(creation.options.rpID, 'localhost');
  assert.equal(creation.options.rpName, 'SecretCLI');
  assert.equal(creation.options.timeout, 60_000);
  assert.equal(creation.options.attestationType, 'none');
  assert.deepEqual(creation.options.authenticatorSelection, {
    authenticatorAttachment: 'platform',
    residentKey: 'required',
    requireResidentKey: true,
    userVerification: 'required'
  });
  assert.equal(registration.extensions.prf.eval.first, Buffer.alloc(32, 2).toString('base64url'));
  assert.equal(confirmation.options.rpID, 'localhost');
  assert.equal(confirmation.options.userVerification, 'required');
  assert.deepEqual(confirmation.options.allowCredentials, [{
    id: credentialId,
    transports: ['internal', 'hybrid']
  }]);
  assert.equal(authentication.extensions.prf.eval.first, registration.extensions.prf.eval.first);
  assert.notEqual(creation.challenge, confirmation.challenge);
});

test('registration verification and confirmation return vault enrollment metadata and PRF output', async () => {
  const harness = createHarness();
  await reachRegistrationConfirmation(harness);
  const response = { id: credentialId };
  const result = await harness.service.verifyRegistrationConfirmation(response, prfOutput.toString('base64url'));

  assert.deepEqual(harness.calls.registrationVerification[0], {
    response: { id: credentialId },
    expectedChallenge: Buffer.alloc(32, 1).toString('base64url'),
    expectedOrigin: origin,
    expectedRPID: 'localhost',
    requireUserVerification: true
  });
  assert.equal(result.credentialId, credentialId);
  assert.equal(result.publicKey, publicKey.toString('base64url'));
  assert.equal(result.counter, 7);
  assert.deepEqual(result.transports, ['internal', 'hybrid']);
  assert.equal(result.prfSalt, Buffer.alloc(32, 2).toString('base64'));
  assert.deepEqual(result.prfOutput, prfOutput);
  assert.equal(result.newCounter, 7);
  assert.deepEqual(harness.calls.authenticationVerification[0], {
    response,
    expectedChallenge: Buffer.alloc(32, 3).toString('base64url'),
    expectedOrigin: origin,
    expectedRPID: 'localhost',
    credential: {
      id: credentialId,
      publicKey,
      counter: 4,
      transports: ['internal', 'hybrid']
    },
    requireUserVerification: true
  });
});

test('normal authentication uses stored vault passkey metadata', async () => {
  const harness = createHarness();
  const passkey = storedPasskey();
  const options = await harness.service.beginAuthentication(passkey);
  const response = { id: credentialId };
  const result = await harness.service.verifyAuthentication(response, prfOutput.toString('base64url'));

  assert.equal(options.options.rpID, 'localhost');
  assert.equal(options.options.userVerification, 'required');
  assert.deepEqual(options.options.allowCredentials, [{ id: credentialId, transports: passkey.transports }]);
  assert.equal(options.options.extensions.prf.eval.first, Buffer.alloc(32, 2).toString('base64url'));
  assert.deepEqual(harness.calls.authenticationVerification[0], {
    response,
    expectedChallenge: Buffer.alloc(32, 1).toString('base64url'),
    expectedOrigin: origin,
    expectedRPID: 'localhost',
    credential: {
      id: credentialId,
      publicKey,
      counter: 4,
      transports: ['internal', 'hybrid']
    },
    requireUserVerification: true
  });
  assert.deepEqual(result, { prfOutput, newCounter: 7 });
});

test('wrong credentials are rejected before invoking the verifier and consume the challenge', async () => {
  const harness = createHarness();
  await harness.service.beginAuthentication(storedPasskey());
  await assert.rejects(harness.service.verifyAuthentication({ id: 'd3Jvbmc' }, prfOutput.toString('base64url')), /credential/i);
  assert.equal(harness.calls.authenticationVerification.length, 0);
  await assert.rejects(harness.service.verifyAuthentication({ id: credentialId }, prfOutput.toString('base64url')), /challenge/i);
});

test('false and throwing verifiers consume challenges for registration and authentication', async () => {
  const falseHarness = createHarness({
    async verifyRegistrationResponse(options) {
      falseHarness.calls.registrationVerification.push(options);
      return { verified: false };
    }
  });
  await falseHarness.service.beginRegistration({ userID: Buffer.from('user'), userName: 'vault' });
  await assert.rejects(falseHarness.service.verifyRegistration({ id: credentialId }), /verification/i);
  await assert.rejects(falseHarness.service.verifyRegistration({ id: credentialId }), /challenge/i);

  const failure = new Error('signature rejected');
  const throwHarness = createHarness({ async verifyAuthenticationResponse() { throw failure; } });
  await throwHarness.service.beginAuthentication(storedPasskey());
  await assert.rejects(throwHarness.service.verifyAuthentication({ id: credentialId }, prfOutput.toString('base64url')), error => error === failure);
  await assert.rejects(throwHarness.service.verifyAuthentication({ id: credentialId }, prfOutput.toString('base64url')), /challenge/i);
});

test('expired and replayed challenges cannot be verified', async () => {
  const harness = createHarness();
  await harness.service.beginAuthentication(storedPasskey());
  harness.advance(60_001);
  await assert.rejects(harness.service.verifyAuthentication({ id: credentialId }, prfOutput.toString('base64url')), /expired/i);
  assert.equal(harness.calls.authenticationVerification.length, 0);

  await harness.service.beginAuthentication(storedPasskey());
  await harness.service.verifyAuthentication({ id: credentialId }, prfOutput.toString('base64url'));
  await assert.rejects(harness.service.verifyAuthentication({ id: credentialId }, prfOutput.toString('base64url')), /challenge/i);
  assert.equal(harness.calls.authenticationVerification.length, 1);
});

test('starting a flow replaces its previous active challenge', async () => {
  const harness = createHarness();
  await harness.service.beginAuthentication(storedPasskey());
  await harness.service.beginAuthentication(storedPasskey());
  await harness.service.verifyAuthentication({ id: credentialId }, prfOutput.toString('base64url'));
  assert.equal(harness.calls.authenticationVerification[0].expectedChallenge, Buffer.alloc(32, 2).toString('base64url'));
});

test('missing or malformed canonical base64url PRF output is rejected only after signature verification', async () => {
  for (const value of [undefined, '', 'not+base64url', 'YQ', Buffer.alloc(31).toString('base64url'), `${prfOutput.toString('base64url')}=`]) {
    const harness = createHarness();
    await harness.service.beginAuthentication(storedPasskey());
    await assert.rejects(harness.service.verifyAuthentication({ id: credentialId }, value), /PRF/i);
    assert.equal(harness.calls.authenticationVerification.length, 1);
  }
});

test('false authentication verification does not decode PRF output and cannot be retried', async () => {
  const harness = createHarness({
    async verifyAuthenticationResponse(options) {
      harness.calls.authenticationVerification.push(options);
      return { verified: false, authenticationInfo: { newCounter: 5 } };
    }
  });
  await harness.service.beginAuthentication(storedPasskey());
  await assert.rejects(harness.service.verifyAuthentication({ id: credentialId }, 'malformed+'), /verification/i);
  await assert.rejects(harness.service.verifyAuthentication({ id: credentialId }, prfOutput.toString('base64url')), /challenge/i);
});
