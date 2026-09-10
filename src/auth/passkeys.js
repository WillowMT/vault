import { randomBytes as defaultRandomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions as defaultGenerateAuthenticationOptions,
  generateRegistrationOptions as defaultGenerateRegistrationOptions,
  verifyAuthenticationResponse as defaultVerifyAuthenticationResponse,
  verifyRegistrationResponse as defaultVerifyRegistrationResponse
} from '@simplewebauthn/server';

const RP_ID = 'localhost';
const TIMEOUT = 60_000;
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

function canonicalBase64Url(value, name, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${name}`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length === 0 || (expectedLength !== undefined && bytes.length !== expectedLength) || bytes.toString('base64url') !== value) throw new Error(`Invalid ${name}`);
  return bytes;
}

function canonicalBase64(value, name, expectedLength) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${name}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== expectedLength || bytes.toString('base64') !== value) throw new Error(`Invalid ${name}`);
  return bytes;
}

function validateOrigin(origin) {
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('Invalid WebAuthn origin'); }
  if (parsed.origin !== origin || parsed.protocol !== 'http:' || parsed.hostname !== RP_ID || !parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Invalid WebAuthn origin');
}

function validateTransports(transports) {
  if (!Array.isArray(transports) || transports.length > TRANSPORTS.size || transports.some(value => !TRANSPORTS.has(value)) || new Set(transports).size !== transports.length) throw new Error('Invalid passkey transports');
  return [...transports];
}

function validateCounter(counter) {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid passkey counter');
  return counter;
}

function credentialFromMetadata(passkey) {
  if (!passkey || typeof passkey !== 'object') throw new Error('Invalid passkey metadata');
  const id = canonicalBase64Url(passkey.credentialId, 'passkey credential ID').toString('base64url');
  const publicKey = canonicalBase64Url(passkey.publicKey, 'passkey public key');
  const counter = validateCounter(passkey.counter);
  const transports = validateTransports(passkey.transports);
  const prfSalt = canonicalBase64(passkey.prfSalt, 'passkey PRF salt', 32);
  return { credential: { id, publicKey, counter, transports }, prfSalt };
}

function credentialFromRegistration(info, response) {
  const source = info?.credential;
  if (!source || typeof source !== 'object') throw new Error('Registration verification did not return a credential');
  const id = canonicalBase64Url(source.id, 'passkey credential ID').toString('base64url');
  if (response?.id !== id) throw new Error('Passkey credential does not match');
  if (!(source.publicKey instanceof Uint8Array) || source.publicKey.length === 0) throw new Error('Invalid passkey public key');
  return {
    id,
    publicKey: Buffer.from(source.publicKey),
    counter: validateCounter(source.counter),
    transports: validateTransports(source.transports ?? response?.response?.transports ?? [])
  };
}

function consume(state, now, phase) {
  if (!state || state.phase !== phase) throw new Error('No active WebAuthn challenge');
  if (now() > state.expiresAt) throw new Error('WebAuthn challenge expired');
  return state;
}

function authenticationVerificationOptions(response, pending, origin) {
  return {
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: origin,
    expectedRPID: RP_ID,
    credential: pending.credential,
    requireUserVerification: true
  };
}

function finishAuthentication(verification, pending, prfResult) {
  if (!verification?.verified) throw new Error('WebAuthn authentication verification failed');
  const info = verification.authenticationInfo;
  if (!info || (info.credentialID !== undefined && info.credentialID !== pending.credential.id)) throw new Error('Passkey credential does not match');
  const newCounter = validateCounter(info.newCounter);
  const prfOutput = canonicalBase64Url(prfResult, 'WebAuthn PRF output', 32);
  return { prfOutput, newCounter };
}

export function createPasskeyService({
  origin,
  now = Date.now,
  randomBytes = defaultRandomBytes,
  generateRegistrationOptions = defaultGenerateRegistrationOptions,
  verifyRegistrationResponse = defaultVerifyRegistrationResponse,
  generateAuthenticationOptions = defaultGenerateAuthenticationOptions,
  verifyAuthenticationResponse = defaultVerifyAuthenticationResponse
} = {}) {
  validateOrigin(origin);
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new Error('Invalid passkey service dependencies');
  let registration;
  let authentication;

  function random32(name) {
    const bytes = randomBytes(32);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error(`Invalid ${name} source`);
    return Buffer.from(bytes);
  }

  async function requestOptions(credential, prfSalt) {
    const challengeBytes = random32('WebAuthn challenge');
    const challenge = challengeBytes.toString('base64url');
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: [{ id: credential.id, transports: [...credential.transports] }],
      challenge: challengeBytes,
      timeout: TIMEOUT,
      userVerification: 'required',
      extensions: { prf: { eval: { first: prfSalt.toString('base64url') } } }
    });
    return { options, challenge, expiresAt: now() + TIMEOUT };
  }

  return {
    async beginRegistration({ userID, userName, userDisplayName = userName } = {}) {
      registration = undefined;
      const challengeBytes = random32('WebAuthn challenge');
      const prfSalt = random32('WebAuthn PRF salt');
      const challenge = challengeBytes.toString('base64url');
      const options = await generateRegistrationOptions({
        rpName: 'Vault',
        rpID: RP_ID,
        userID,
        userName,
        userDisplayName,
        challenge: challengeBytes,
        timeout: TIMEOUT,
        attestationType: 'none',
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required'
        },
        extensions: { prf: { eval: { first: prfSalt.toString('base64url') } } }
      });
      registration = { phase: 'attestation', challenge, expiresAt: now() + TIMEOUT, prfSalt };
      return options;
    },

    async verifyRegistration(response) {
      const pending = registration;
      registration = undefined;
      consume(pending, now, 'attestation');
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: RP_ID,
        requireUserVerification: true
      });
      if (!verification?.verified) throw new Error('WebAuthn registration verification failed');
      const credential = credentialFromRegistration(verification.registrationInfo, response);
      const next = await requestOptions(credential, pending.prfSalt);
      registration = { phase: 'confirmation', credential, prfSalt: pending.prfSalt, ...next };
      return next.options;
    },

    async verifyRegistrationConfirmation(response, prfResult) {
      const pending = registration;
      registration = undefined;
      consume(pending, now, 'confirmation');
      if (response?.id !== pending.credential.id) throw new Error('Passkey credential does not match');
      const verification = await verifyAuthenticationResponse(authenticationVerificationOptions(response, pending, origin));
      const result = finishAuthentication(verification, pending, prfResult);
      return {
        credentialId: pending.credential.id,
        publicKey: pending.credential.publicKey.toString('base64url'),
        counter: result.newCounter,
        transports: [...pending.credential.transports],
        prfSalt: pending.prfSalt.toString('base64'),
        ...result
      };
    },

    async beginAuthentication(passkey) {
      authentication = undefined;
      const { credential, prfSalt } = credentialFromMetadata(passkey);
      const pending = await requestOptions(credential, prfSalt);
      authentication = { phase: 'authentication', credential, ...pending };
      return pending.options;
    },

    async verifyAuthentication(response, prfResult) {
      const pending = authentication;
      authentication = undefined;
      consume(pending, now, 'authentication');
      if (response?.id !== pending.credential.id) throw new Error('Passkey credential does not match');
      const verification = await verifyAuthenticationResponse(authenticationVerificationOptions(response, pending, origin));
      return finishAuthentication(verification, pending, prfResult);
    }
  };
}
