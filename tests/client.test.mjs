import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.mjs';

const questions = { yes: { type: 'noul', instructions: 'Is this relevant?' } };
const good = { model: 'jev-fixture', answers: { yes: { type: 'noul', noul: 0.9 } } };

test('client sends the official contract, pins model and forbids credential redirects', async () => {
  const judge = createClient({ apiKey: 'fixture-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'jev-1.13.0');
    assert.deepEqual(body.questions, questions);
    return Response.json(good);
  } });
  assert.equal((await judge({ record: 'hello' }, questions)).answers.yes.noul, 0.9);
});

test('client retries bounded rate limiting', async () => {
  let calls = 0;
  const judge = createClient({ apiKey: 'fixture-key', sleep: async () => {}, fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : Response.json(good);
  } });
  await judge({}, questions);
  assert.equal(calls, 2);
});

test('missing credentials do not send a request', async () => {
  const judge = createClient({ apiKey: '', fetchImpl: async () => { throw new Error('should not call'); } });
  await assert.rejects(judge({}, questions), /No request was sent/);
});

test('provider errors do not expose the body', async () => {
  const judge = createClient({ apiKey: 'fixture', fetchImpl: async () => new Response('secret request data', { status: 401 }) });
  await assert.rejects(judge({}, questions), error => error.message.includes('HTTP 401') && !error.message.includes('secret'));
});

test('invalid types, absent answers and malformed payloads fail closed', async () => {
  for (const response of [Response.json({ model: 'fixture', answers: {} }),
    Response.json({ model: 'fixture', answers: { yes: { type: 'noul', noul: 2 } } }),
    Response.json({ model: 'fixture', answers: { yes: { type: 'score', noul: 0.9 } } }),
    new Response('not JSON')]) {
    const judge = createClient({ apiKey: 'fixture', fetchImpl: async () => response });
    await assert.rejects(judge({}, questions));
  }
});

test('network failures cannot become successful judgments', async () => {
  const judge = createClient({ apiKey: 'fixture', fetchImpl: async () => { throw new Error('private diagnostic'); } });
  await assert.rejects(judge({}, questions), /No semantic checks were approved/);
});
