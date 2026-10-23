import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.mjs';

const questions = { yes: { type: 'noul', instructions: 'Is this relevant?' } };
const good = { model: 'jev-fixture', answers: { yes: { type: 'noul', noul: 0.9 } } };

test('client sends the official contract, pins model and forbids credential redirects', async () => {
  const judge = createClient({ apiKey: 'fixture-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'jev-1.13.0');
    assert.deepEqual(body.questions, questions);
    return Response.json(good);
  } });
  assert.equal((await judge({ record: 'hello' }, questions)).answers.yes.noul, 0.9);
});

test('redirects are never followed with credentials', async () => {
  const judge = createClient({ apiKey: 'fixture', fetchImpl: async () => new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }) });
  await assert.rejects(judge({}, questions), /redirected/);
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

test('openrouter provider uses the Decisions endpoint, its own key and model IDs', async () => {
  const judge = createClient({ provider: 'openrouter', apiKey: 'or-key', model: 'cloudflare/clef-flash', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(options.headers.Authorization, 'Bearer or-key');
    assert.equal(JSON.parse(options.body).model, 'cloudflare/clef-flash');
    return Response.json({ ...good, usage: { input_tokens: 10, cost: 0.00001 } });
  } });
  assert.equal((await judge({}, questions)).usage.cost, 0.00001);
});

test('a self-hosted base URL targets /v1/systemone and needs no key', async () => {
  const judge = createClient({ baseUrl: 'http://localhost:8000/', apiKey: '', fetchImpl: async (url, options) => {
    assert.equal(url, 'http://localhost:8000/v1/systemone');
    assert.equal(options.headers.Authorization, undefined);
    return Response.json(good);
  } });
  await judge({}, questions);
});

test('unknown providers and malformed base URLs are rejected up front', () => {
  assert.throws(() => createClient({ provider: 'nope' }), /Unknown provider/);
  assert.throws(() => createClient({ baseUrl: 'ftp://x' }), /http/);
  assert.throws(() => createClient({ baseUrl: 'not a url' }), /Invalid base URL/);
});

test('a missing OpenRouter key names the right variable', async () => {
  const judge = createClient({ provider: 'openrouter', apiKey: '', fetchImpl: async () => { throw new Error('should not call'); } });
  await assert.rejects(judge({}, questions), /OPENROUTER_API_KEY.*No request was sent/);
});
