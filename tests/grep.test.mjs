import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecords, semanticGrep } from '../src/grep.mjs';

test('JSONL keeps original line numbers and bytes', async () => {
  const records = parseRecords('{"payment":"success","entitlement":"missing"}\n\n{"payment":"failed"}\n', 'events.jsonl', 'jsonl');
  const report = await semanticGrep({ query: 'Payment succeeded but entitlement is missing', records,
    judge: async (_state, questions) => {
      assert.deepEqual(Object.keys(questions), ['record_0', 'record_1']);
      return { model: 'fixture', answers: { record_0: { noul: 0.95 }, record_1: { noul: 0.05 } } };
    } });
  assert.equal(report.matches[0].text, records[0].text);
  assert.equal(report.matches[0].line, 1);
  assert.equal(records[1].line, 3);
  assert.equal(report.rejected, 1);
});

test('uncertain records are returned separately', async () => {
  const report = await semanticGrep({ query: 'needs a refund', records: parseRecords('unclear'),
    judge: async () => ({ model: 'fixture', answers: { record_0: { noul: 0.6 } } }) });
  assert.equal(report.status, 'review');
  assert.equal(report.matches.length, 0);
  assert.equal(report.review.length, 1);
});

test('invalid inputs fail before spending API calls', () => {
  assert.throws(() => parseRecords('{bad json}', 'input', 'jsonl'), /Invalid JSONL/);
  assert.throws(() => parseRecords('x'.repeat(2001)), /2000 characters/);
  assert.throws(() => parseRecords(Array(1001).fill('row').join('\n')), /1000 records/);
});

test('later batch failure rejects the entire filter instead of emitting partial matches', async () => {
  let calls = 0;
  await assert.rejects(semanticGrep({ query: 'relevant', records: parseRecords(Array(21).fill('row').join('\n')),
    judge: async (_state, questions) => {
      calls++;
      if (calls === 2) throw new Error('provider unavailable');
      return { model: 'fixture', answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0.95 }])) };
    } }), /provider unavailable/);
});
