// Tests de l'API avec Supabase et Groq simulés. Lancer : node tests/worker.test.mjs
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';

const env = {
  SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'sb_secret_x',
  GROQ_API_KEY: 'gsk_x', ALLOWED_ORIGINS: 'https://clipmoment.pages.dev',
};
const PID = '2cdf67a5-654d-4694-971e-c3c3685668e1';
const calls = [];
let groqChatContent = '';
let groqStatus = 200;

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, init });
  if (url.endsWith('/auth/v1/user')) {
    return init.headers.Authorization === 'Bearer good'
      ? Response.json({ id: 'u1', email: 'a@b.c' }) : new Response('{}', { status: 401 });
  }
  if (url.includes('/rest/v1/rpc/')) {
    const fn = url.split('/rpc/')[1];
    const args = JSON.parse(init.body);
    assert.equal(init.headers.apikey, 'sb_secret_x');
    assert.equal(init.headers.Authorization, undefined);
    if (fn === 'start_analysis') {
      if (args.p_seconds > 600) return Response.json({ message: 'CREDITS_INSUFFISANTS' }, { status: 400 });
      return Response.json({ project_id: PID, cost: Math.ceil(args.p_seconds / 60), credits: 10 });
    }
    if (fn === 'can_transcribe' || fn === 'use_moments_call') return Response.json(true);
    if (fn === 'add_used_seconds') { assert.equal(args.p_seconds, 61.5); return new Response(null, { status: 204 }); }
    if (fn === 'cancel_analysis') return Response.json({ refunded: 2 });
  }
  if (url.endsWith('/audio/transcriptions')) {
    if (groqStatus === 429) return new Response('rate', { status: 429, headers: { 'retry-after': '7' } });
    return Response.json({ language: 'french', duration: 61.5,
      words: [{ word: ' Bonjour', start: 0.1, end: 0.456 }], segments: [{ start: 0, end: 3.2, text: ' Bonjour à tous.' }] });
  }
  if (url.endsWith('/chat/completions')) {
    const body = JSON.parse(init.body);
    assert.equal(body.reasoning_effort, 'low');
    return Response.json({ choices: [{ message: { content: groqChatContent } }] });
  }
  throw new Error('fetch inattendu ' + url);
};

const req = (path, body, opts = {}) => new Request('https://api.example.com' + path, Object.assign({
  method: 'POST', headers: Object.assign({ Authorization: 'Bearer good', Origin: 'https://clipmoment.pages.dev', 'Content-Type': 'application/json' }, opts.headers || {}),
  body: typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body),
}, opts.init || {}));

// santé
let r = await worker.fetch(new Request('https://api.example.com/health'), env);
assert.equal((await r.json()).configured, true);

// CORS
r = await worker.fetch(new Request('https://api.example.com/moments', { method: 'OPTIONS', headers: { Origin: 'https://clipmoment.pages.dev' } }), env);
assert.equal(r.status, 204);
assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://clipmoment.pages.dev');

// non connecté
r = await worker.fetch(req('/analyze/start', { seconds: 30 }, { headers: { Authorization: 'Bearer bad' } }), env);
assert.equal(r.status, 401);

// début d'analyse
r = await worker.fetch(req('/analyze/start', { seconds: 125.3, file_name: 'v.mp4', file_size: 10 }), env);
assert.deepEqual(await r.json(), { project_id: PID, cost: 3, credits: 10 });

// crédits insuffisants
r = await worker.fetch(req('/analyze/start', { seconds: 900 }), env);
assert.equal(r.status, 402);
assert.equal((await r.json()).error, 'CREDITS_INSUFFISANTS');

// transcription
const fd = new FormData();
fd.append('file', new Blob([new Uint8Array(100)], { type: 'audio/wav' }), 'a.wav');
fd.append('model', 'whisper-large-v3-turbo');
const tr = new Request('https://api.example.com/transcribe?project=' + PID, { method: 'POST', headers: { Authorization: 'Bearer good' }, body: fd });
r = await worker.fetch(tr, env);
const t = await r.json();
assert.equal(r.status, 200);
assert.deepEqual(t.words[0], ['Bonjour', 0.1, 0.46]);
assert.deepEqual(t.segments[0], [0, 3.2, 'Bonjour à tous.']);

// limite Groq
groqStatus = 429;
r = await worker.fetch(new Request('https://api.example.com/transcribe?project=' + PID, { method: 'POST', headers: { Authorization: 'Bearer good' }, body: fd }), env);
assert.equal(r.status, 429);
assert.equal(r.headers.get('Retry-After'), '7');

// moments
groqChatContent = '```json\n{"clips":[{"start":10,"end":40,"title":"« C\'est la TRAHISON »","context":"Le coup de gueule","hook":"Il explose","score":91,"reason":"Opinion forte."},' +
  '{"start":20,"end":50,"title":"chevauche","score":99},{"start":100,"end":101,"title":"trop court","score":80},{"start":60,"end":95,"title":"« Deux »","score":70}]}\n```';
r = await worker.fetch(req('/moments', { project_id: PID, segments: [[0, 5, 'a'], [5, 120, 'b']], min: 20, max: 60, count: 3, language: 'fr' }), env);
const m = await r.json();
assert.equal(r.status, 200, JSON.stringify(m));
assert.deepEqual(m.clips.map((c) => [c.start, c.end, c.score]), [[20, 50, 99], [60, 95, 70]]);

// annulation
r = await worker.fetch(req('/analyze/cancel', { project_id: PID }), env);
assert.equal((await r.json()).refunded, 2);

console.log('Tous les tests de l\'API passent (' + calls.length + ' appels simulés).');
