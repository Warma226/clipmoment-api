/**
 * ClipMoment — API (Cloudflare Worker, fichier unique, aucune compilation).
 *
 * Rôle : garder les clés secrètes hors du navigateur, vérifier la session du client,
 * débiter ses crédits, puis relayer vers Groq (transcription Whisper + IA qui choisit les moments).
 *
 * Variables à définir dans Cloudflare → Worker → Settings → Variables and Secrets :
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY     clé "anon" ou "publishable" de Supabase
 *   SUPABASE_SERVICE_KEY  clé "service_role" ou "secret" de Supabase   (Secret)
 *   GROQ_API_KEY          clé API Groq                                 (Secret)
 *   ALLOWED_ORIGINS       adresse(s) du site, séparées par des virgules (ex. https://clipmoment.pages.dev)
 *   GROQ_STT_MODEL        facultatif, défaut : whisper-large-v3-turbo
 *   GROQ_LLM_MODEL        facultatif, défaut : openai/gpt-oss-120b
 */

const GROQ = 'https://api.groq.com/openai/v1';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') {
        return json({ ok: true, stt: sttModel(env), llm: llmModel(env), configured: isConfigured(env) }, 200, cors);
      }
      if (!isConfigured(env)) return json({ error: 'API_NON_CONFIGUREE' }, 500, cors);
      if (request.method !== 'POST') return json({ error: 'METHODE' }, 405, cors);

      const user = await getUser(request, env);
      if (!user) return json({ error: 'NON_CONNECTE' }, 401, cors);

      switch (url.pathname) {
        case '/analyze/start': return await startAnalysis(request, env, user, cors);
        case '/analyze/cancel': return await cancelAnalysis(request, env, user, cors);
        case '/transcribe': return await transcribe(request, env, user, url, cors);
        case '/moments': return await moments(request, env, user, cors);
        default: return json({ error: 'INTROUVABLE' }, 404, cors);
      }
    } catch (err) {
      const code = err && err.code ? err.code : 'ERREUR_SERVEUR';
      const status = err && err.status ? err.status : 500;
      return json({ error: code, detail: err && err.detail ? String(err.detail).slice(0, 300) : undefined }, status, cors);
    }
  },
};

/* ---------------- Utilitaires ---------------- */

function isConfigured(env) {
  return !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_KEY && env.GROQ_API_KEY);
}
const sttModel = (env) => env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const llmModel = (env) => env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b';

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  let allow = '*';
  if (allowed.length) allow = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}),
  });
}

function fail(code, status, detail) {
  const e = new Error(code);
  e.code = code; e.status = status || 400; e.detail = detail;
  return e;
}

function supaHeaders(key) {
  const h = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key; // anciennes clés JWT
  return h;
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u && u.id ? u : null;
}

async function rpc(env, fn, args) {
  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: supaHeaders(env.SUPABASE_SERVICE_KEY),
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const msg = data && data.message ? data.message : 'ERREUR_BASE';
    const known = ['CREDITS_INSUFFISANTS', 'VIDEO_TROP_LONGUE', 'DUREE_INVALIDE'];
    throw fail(known.includes(msg) ? msg : 'ERREUR_BASE', known.includes(msg) ? 402 : 500, msg);
  }
  return data;
}

async function readJson(request) {
  try { return await request.json(); } catch (e) { throw fail('JSON_INVALIDE', 400); }
}

const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);

/* ---------------- Analyse : début / annulation ---------------- */

async function startAnalysis(request, env, user, cors) {
  const b = await readJson(request);
  const seconds = Math.ceil(Number(b.seconds));
  if (!Number.isFinite(seconds) || seconds <= 0) throw fail('DUREE_INVALIDE', 400);
  const r = await rpc(env, 'start_analysis', {
    p_user: user.id,
    p_seconds: seconds,
    p_title: String(b.title || b.file_name || 'Vidéo').slice(0, 200),
    p_file_name: String(b.file_name || '').slice(0, 300),
    p_file_size: Math.max(0, Math.round(Number(b.file_size) || 0)),
  });
  return json(r, 200, cors);
}

async function cancelAnalysis(request, env, user, cors) {
  const b = await readJson(request);
  if (!isUuid(b.project_id)) throw fail('PROJET_INVALIDE', 400);
  const r = await rpc(env, 'cancel_analysis', { p_user: user.id, p_project: b.project_id });
  return json(r, 200, cors);
}

/* ---------------- Transcription (Groq Whisper) ---------------- */

async function transcribe(request, env, user, url, cors) {
  const project = url.searchParams.get('project');
  if (!isUuid(project)) throw fail('PROJET_INVALIDE', 400);
  const ok = await rpc(env, 'can_transcribe', { p_user: user.id, p_project: project });
  if (ok !== true) throw fail('QUOTA_PROJET_DEPASSE', 403);

  const ctype = request.headers.get('Content-Type') || '';
  if (!ctype.startsWith('multipart/form-data')) throw fail('FORMAT_INVALIDE', 400);

  // Le corps (audio + paramètres) est transmis tel quel à Groq, sans être relu : peu de calcul côté Worker.
  const res = await fetch(GROQ + '/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'Content-Type': ctype },
    body: request.body,
  });
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    const detail = await res.text();
    const h = Object.assign({}, cors);
    if (retry) h['Retry-After'] = retry;
    const code = res.status === 429 ? 'LIMITE_GROQ' : res.status === 413 ? 'AUDIO_TROP_LOURD' : 'ERREUR_TRANSCRIPTION';
    return json({ error: code, detail: detail.slice(0, 300) }, res.status === 429 ? 429 : 502, h);
  }
  const data = await res.json();
  const duration = Number(data.duration) || 0;
  await rpc(env, 'add_used_seconds', { p_project: project, p_seconds: duration });

  const r1 = (n) => Math.round(n * 100) / 100;
  return json({
    language: data.language || null,
    duration,
    words: (data.words || []).map((w) => [String(w.word).trim(), r1(w.start), r1(w.end)]),
    segments: (data.segments || []).map((s) => [r1(s.start), r1(s.end), String(s.text).trim()]),
  }, 200, cors);
}

/* ---------------- Moments viraux (Groq LLM) ---------------- */

const SYSTEM = `Tu es un monteur expert en vidéos courtes virales (TikTok, Reels, YouTube Shorts) pour des médias francophones.
On te donne un extrait de transcription horodatée d'une vidéo longue. Tu choisis les passages qui, découpés seuls, ont le plus de chances de devenir viraux.

Critères, par ordre d'importance :
1. Le passage se comprend seul, sans le reste de la vidéo, et forme une idée complète.
2. Il commence au début d'une phrase et accroche dès les 3 premières secondes.
3. Il contient une émotion forte, une opinion tranchée, un conflit, une révélation, une chute drôle, une phrase qu'on a envie de citer, ou un conseil concret.
4. Il se termine à la fin d'une phrase, idéalement sur une chute.

Pour chaque passage, écris :
- "title" : un titre-citation dans la langue de la vidéo, comme le post d'une chaîne de télé sur les réseaux. Reprends une phrase forte réellement prononcée, entre guillemets « », avec 1 ou 2 mots-clés en MAJUSCULES. 90 caractères maximum.
- "context" : une ligne de contexte courte (70 caractères maximum), par exemple « Le coup de gueule de … ». Ne cite un nom que s'il apparaît dans la transcription.
- "hook" : une accroche très courte de 3 à 6 mots pour le haut de l'écran.
- "score" : de 0 à 100, ton estimation du potentiel viral.
- "reason" : une phrase en français qui explique pourquoi ce passage peut marcher.

Règles strictes :
- "start" et "end" sont en secondes et viennent des horodatages fournis.
- Les passages ne se chevauchent pas.
- Réponds uniquement avec un objet JSON : {"clips":[{"start":0,"end":0,"title":"","context":"","hook":"","score":0,"reason":""}]}`;

async function moments(request, env, user, cors) {
  const b = await readJson(request);
  if (!isUuid(b.project_id)) throw fail('PROJET_INVALIDE', 400);
  const segs = Array.isArray(b.segments) ? b.segments.slice(0, 600) : [];
  if (!segs.length) throw fail('TRANSCRIPTION_VIDE', 400);
  const min = clampNum(b.min, 5, 180, 20), max = clampNum(b.max, min + 5, 240, 60);
  const count = clampNum(b.count, 1, 10, 3);

  const allowed = await rpc(env, 'use_moments_call', { p_user: user.id, p_project: b.project_id });
  if (allowed !== true) throw fail('QUOTA_PROJET_DEPASSE', 403);

  let lines = '', total = 0;
  for (const s of segs) {
    const line = '[' + Number(s[0]).toFixed(1) + '-' + Number(s[1]).toFixed(1) + '] ' + String(s[2] || '').slice(0, 400) + '\n';
    if (total + line.length > 14000) break;
    lines += line; total += line.length;
  }
  const first = Number(segs[0][0]) || 0, last = Number(segs[segs.length - 1][1]) || 0;
  const userMsg = `Langue de la vidéo : ${b.language || 'inconnue'}.
Trouve jusqu'à ${count} passages de ${min} à ${max} secondes chacun.
Transcription (de ${first.toFixed(0)} s à ${last.toFixed(0)} s) :
${lines}`;

  const model = llmModel(env);
  const body = {
    model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }],
    temperature: 0.4,
    max_completion_tokens: 3000,
    response_format: { type: 'json_object' },
  };
  if (model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';

  let res = await callGroqChat(env, body);
  if (res.status === 400) { // certains modèles refusent le mode JSON : on réessaie sans
    delete body.response_format;
    res = await callGroqChat(env, body);
  }
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    const detail = await res.text();
    const h = Object.assign({}, cors);
    if (retry) h['Retry-After'] = retry;
    return json({ error: res.status === 429 ? 'LIMITE_GROQ' : 'ERREUR_IA', detail: detail.slice(0, 300) }, res.status === 429 ? 429 : 502, h);
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content || '' : '';
  const clips = parseClips(content, first, last, min, max).slice(0, count);
  return json({ clips, model }, 200, cors);
}

function callGroqChat(env, body) {
  return fetch(GROQ + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function clampNum(v, lo, hi, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

function parseClips(content, first, last, min, max) {
  let txt = String(content).replace(/```(json)?/g, '');
  const a = txt.indexOf('{'), z = txt.lastIndexOf('}');
  if (a < 0 || z <= a) return [];
  let obj;
  try { obj = JSON.parse(txt.slice(a, z + 1)); } catch (e) { return []; }
  const arr = Array.isArray(obj) ? obj : Array.isArray(obj.clips) ? obj.clips : [];
  const valid = [];
  for (const c of arr) {
    const s = Number(c.start), e = Number(c.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    if (s < first - 3 || e > last + 3) continue;
    const d = e - s;
    if (d < min * 0.6 || d > max * 1.5) continue;
    valid.push(c);
  }
  valid.sort((x, y) => clampNum(y.score, 0, 100, 50) - clampNum(x.score, 0, 100, 50));
  const out = [];
  for (const c of valid) {
    const s = Number(c.start), e = Number(c.end);
    if (out.some((o) => s < o.end && e > o.start)) continue; // on garde le meilleur score en cas de chevauchement
    out.push({
      start: Math.round(s * 10) / 10,
      end: Math.round(e * 10) / 10,
      title: String(c.title || '').slice(0, 120),
      context: String(c.context || '').slice(0, 90),
      hook: String(c.hook || '').slice(0, 60),
      score: Math.round(clampNum(c.score, 0, 100, 50)),
      reason: String(c.reason || '').slice(0, 220),
    });
  }
  return out.sort((x, y) => y.score - x.score);
}
