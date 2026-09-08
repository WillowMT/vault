import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/server/session.js';
test('malformed Unicode launch tokens reject as unauthenticated',()=>{
  const session=createSession();session.renew();
  assert.throws(()=>session.exchange('é'.repeat(64)),error=>error.status===401);
});
test('launch renewal invalidates unused links and closed sessions reject all tokens',()=>{
  const session=createSession(),old=session.renew(),current=session.renew();
  assert.throws(()=>session.exchange(old),error=>error.status===401);
  const result=session.exchange(current);session.authenticate({headers:{cookie:result.cookie.split(';')[0]}});
  session.close();assert.throws(()=>session.authenticate({headers:{cookie:result.cookie}}),error=>error.status===401);
});
test('authorize issues a session without a launch token',()=>{
  const session=createSession(),result=session.authorize();
  assert.match(result.cookie,/^secretcli=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.match(result.csrfToken,/^[a-f0-9]{64}$/);
  session.authenticate({headers:{cookie:result.cookie.split(';')[0]}});
});
