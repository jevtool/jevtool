const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export function createClient({ apiKey = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY,
  model = process.env.JEV_MODEL || 'jev-1.13.0', fetchImpl = globalThis.fetch,
  timeoutMs = 15_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  return async function judge(state, questions) {
    if (!apiKey) throw new Error('Set TYPESAFE_API_KEY to use Jev. No request was sent.');
    const body = JSON.stringify({ model, state, questions });
    if (Buffer.byteLength(body) > 96 * 1024) throw new Error('Judgment context exceeds 96 KiB. Narrow the acceptance criteria or input.');
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body, signal: AbortSignal.timeout(timeoutMs) });
      } catch { throw new Error('Jev request failed or timed out. No semantic checks were approved.'); }
      if ([429, 529].includes(response.status) && attempt === 0) {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get('retry-after') || 0);
        await sleep(Math.min(2000, Math.max(500, Number.isFinite(retryAfter) ? retryAfter * 1000 : 500)));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        // Do not echo provider error bodies, which can contain request data.
        throw new Error(`Jev returned HTTP ${response.status}. No semantic checks were approved.`);
      }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 512 * 1024) throw new Error('Jev response exceeds the response limit.');
        chunks.push(chunk);
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error('Jev returned invalid JSON.'); }
      for (const id of Object.keys(questions)) {
        const answer = result?.answers?.[id];
        if (!answer || answer.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
          throw new Error(`Jev returned an invalid or missing Noul answer for ${id}.`);
        }
      }
      if (typeof result.model !== 'string' || !result.model) throw new Error('Jev response is missing the resolved model.');
      return result;
    }
  };
}
