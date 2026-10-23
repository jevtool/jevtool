const env = typeof process === 'object' && process?.env ? process.env : {};

// Every provider speaks the same System One wire: { model, state, questions } in,
// { model, answers, usage } out. Only the endpoint and the key differ.
export const PROVIDERS = {
  typesafe: { endpoint: 'https://api.typesafe.ai/v1/systemone', keyEnv: ['TYPESAFE_API_KEY', 'JEV_API_KEY'],
    defaultModel: 'jev-1.13.0', keyHelp: 'Create a key at https://console.typesafe.ai and set TYPESAFE_API_KEY' },
  openrouter: { endpoint: 'https://openrouter.ai/api/alpha/decisions', keyEnv: ['OPENROUTER_API_KEY'],
    defaultModel: 'typesafe/jev-1.13', keyHelp: 'Create a key at https://openrouter.ai/keys and set OPENROUTER_API_KEY' },
};

export function resolveProvider({ provider = env.JEVTOOL_PROVIDER || 'typesafe', baseUrl = env.TYPESAFE_BASE_URL } = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`Unknown provider "${provider}". Use ${Object.keys(PROVIDERS).join(' or ')}.`);
  if (baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error(`Invalid base URL: ${baseUrl}`); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('The base URL must start with http:// or https://.');
    // Self-hosted servers (Kev, Laya, decider, …) expose the TypeSafe path.
    return { ...spec, name: provider, endpoint: url.href.replace(/\/+$/, '') + '/v1/systemone', selfHosted: true };
  }
  return { ...spec, name: provider, selfHosted: false };
}

export const apiKeyFor = spec => spec.keyEnv.map(name => env[name]).find(Boolean) || '';

export function createClient({ provider, baseUrl, apiKey, model, fetchImpl = globalThis.fetch,
  timeoutMs = 15_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const spec = resolveProvider({ provider, baseUrl });
  const ENDPOINT = spec.endpoint;
  const key = apiKey ?? apiKeyFor(spec);
  const resolvedModel = model ?? env.JEV_MODEL ?? spec.defaultModel;
  return async function judge(state, questions) {
    if (!key && !spec.selfHosted) throw new Error(`No ${spec.keyEnv[0]} found. ${spec.keyHelp}. No request was sent.`);
    const body = JSON.stringify({ model: resolvedModel, state, questions });
    if (new TextEncoder().encode(body).byteLength > 96 * 1024) throw new Error('Judgment context exceeds 96 KiB. Narrow the acceptance criteria or input.');
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        // 'manual' rather than 'error': the Workers runtime rejects 'error'. A 3xx is
        // then treated as a failure below, so credentials never follow a redirect.
        response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'manual',
          headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
          body, signal: AbortSignal.timeout(timeoutMs) });
      } catch { throw new Error('Jev request failed or timed out. No semantic checks were approved.'); }
      if ([429, 529].includes(response.status) && attempt === 0) {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get('retry-after') || 0);
        await sleep(Math.min(2000, Math.max(500, Number.isFinite(retryAfter) ? retryAfter * 1000 : 500)));
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('Jev endpoint redirected; refusing to follow with credentials. No semantic checks were approved.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        // Do not echo provider error bodies, which can contain request data.
        throw new Error(`Jev returned HTTP ${response.status}. No semantic checks were approved.`);
      }
      const chunks = []; let bytes = 0;
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 512 * 1024) { await reader.cancel(); throw new Error('Jev response exceeds the response limit.'); }
        chunks.push(value);
      }
      const joined = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      let result;
      try { result = JSON.parse(new TextDecoder().decode(joined)); }
      catch { throw new Error('Jev returned invalid JSON.'); }
      for (const [id, question] of Object.entries(questions)) validateAnswer(id, question, result?.answers?.[id]);
      if (typeof result.model !== 'string' || !result.model) throw new Error('Jev response is missing the resolved model.');
      return result;
    }
  };
}

const isProbability = value => Number.isFinite(value) && value >= 0 && value <= 1;

// Fail closed: every requested question must come back with an answer of its own type.
export function validateAnswer(id, question, answer) {
  const type = question?.type;
  if (!answer || answer.type !== type) throw new Error(`Jev returned an invalid or missing ${type ?? 'unknown'} answer for ${id}.`);
  if (type === 'noul') {
    if (!isProbability(answer.noul)) throw new Error(`Jev returned an invalid or missing Noul answer for ${id}.`);
  } else if (type === 'choice' || type === 'score') {
    const probabilities = answer.probabilities;
    if (!probabilities || typeof probabilities !== 'object' || !Object.values(probabilities).every(isProbability)) {
      throw new Error(`Jev returned invalid probabilities for ${id}.`);
    }
    if (!isProbability(answer.confidence)) throw new Error(`Jev returned an invalid confidence for ${id}.`);
    if (type === 'choice' && !(answer.choice in probabilities)) throw new Error(`Jev returned an unknown option for ${id}.`);
    if (type === 'score' && !Number.isFinite(answer.score)) throw new Error(`Jev returned an invalid score for ${id}.`);
  } else {
    throw new Error(`Unsupported question type for ${id}: ${type}.`);
  }
}
