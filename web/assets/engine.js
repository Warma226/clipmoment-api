/* ClipMoment — moteur d'analyse : audio, transcription par morceaux, choix des moments. */
(function () {
  'use strict';
  const HOP = 0.25;              // une mesure d'intensité toutes les 0,25 s
  const SR = 16000;              // fréquence envoyée à Whisper
  const CHUNK = 600;             // morceaux d'environ 10 min (≈ 19 Mo en WAV 16 kHz mono)
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- Audio ---------- */

  async function decodeMono(file) {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC) throw new Error('Ton navigateur ne sait pas lire l\'audio. Mets-le à jour.');
    let buf = await file.arrayBuffer();
    let ctx = null;
    for (const sr of [SR, 22050, 44100]) { try { ctx = new AC(1, sr, sr); break; } catch (e) { /* ancien Safari */ } }
    if (!ctx) throw new Error('Impossible de préparer l\'audio sur ce navigateur.');
    let ab = await new Promise((res, rej) => {
      try { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); } catch (err) { rej(err); }
    }).catch(() => { throw new Error('La piste audio de cette vidéo est illisible ou absente.'); });
    buf = null;
    const ch = ab.numberOfChannels, n = ab.length, rate = ab.sampleRate;
    let mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    ab = null;
    if (rate !== SR) { // rééchantillonnage simple si le navigateur a imposé une autre fréquence
      const m = Math.floor(n * SR / rate), out = new Float32Array(m), k = rate / SR;
      for (let i = 0; i < m; i++) { const x = i * k, i0 = Math.floor(x), f = x - i0; out[i] = mono[i0] * (1 - f) + (mono[Math.min(n - 1, i0 + 1)] || 0) * f; }
      mono = out;
    }
    return { pcm: mono, duration: mono.length / SR };
  }

  function pct(a, p) { const b = Float32Array.from(a).sort(); return b[Math.min(b.length - 1, Math.floor(p * (b.length - 1)))]; }
  function smooth(a, r) {
    const n = a.length, o = new Float32Array(n), P = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) P[i + 1] = P[i] + a[i];
    for (let i = 0; i < n; i++) { const lo = Math.max(0, i - r), hi = Math.min(n, i + r + 1); o[i] = (P[hi] - P[lo]) / (hi - lo); }
    return o;
  }

  function energy(pcm) {
    const hop = Math.round(SR * HOP), n = Math.floor(pcm.length / hop), db = new Float32Array(Math.max(1, n));
    for (let i = 0; i < n; i++) { let s = 0; const o = i * hop; for (let j = 0; j < hop; j++) { const v = pcm[o + j]; s += v * v; } db[i] = 20 * Math.log10(Math.sqrt(s / hop) + 1e-5); }
    const lo = pct(db, 0.1), hi = pct(db, 0.99), span = Math.max(6, hi - lo);
    const e = db.map((v) => clamp((v - lo) / span, 0, 1));
    const es = smooth(e, 2), d = new Float32Array(e.length);
    for (let i = 1; i < e.length; i++) d[i] = Math.max(0, e[i] - e[i - 1]);
    let on = smooth(d, 3); const ho = pct(on, 0.98) || 1; on = on.map((v) => Math.min(1, v / ho));
    const f = new Float32Array(e.length); for (let i = 0; i < e.length; i++) f[i] = 0.65 * es[i] + 0.35 * on[i];
    return { e, es, on, f, hop: HOP };
  }

  // Points de coupe des morceaux, placés sur un silence proche de chaque 10e minute.
  function chunkBounds(feat, duration) {
    const cuts = [0];
    for (let t = CHUNK; t < duration - 30; t += CHUNK) {
      const a = Math.floor((t - 8) / HOP), b = Math.floor((t + 8) / HOP);
      let best = Math.floor(t / HOP);
      for (let k = Math.max(0, a); k <= Math.min(feat.e.length - 1, b); k++) if (feat.e[k] < feat.e[best]) best = k;
      cuts.push(best * HOP);
    }
    cuts.push(duration);
    const out = [];
    for (let i = 0; i < cuts.length - 1; i++) out.push([cuts[i], cuts[i + 1]]);
    return out;
  }

  function wavBlob(pcm, from, to) {
    const a = Math.floor(from * SR), b = Math.min(pcm.length, Math.floor(to * SR)), n = Math.max(0, b - a);
    const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const W = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    W(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); W(8, 'WAVE'); W(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true);
    v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); W(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = clamp(pcm[a + i], -1, 1); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* ---------- Appels API avec patience en cas de saturation ---------- */

  async function withRetry(fn, onWait, signal) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (signal && signal.aborted) throw e;
        const retryable = e.code === 'LIMITE_GROQ' || e.code === 'RESEAU' || (e.status >= 500 && e.code !== 'API_NON_CONFIGUREE');
        if (!retryable || attempt >= 5) throw e;
        const s = clamp(e.retryAfter || 6 * (attempt + 1), 3, 90);
        if (onWait) onWait(s);
        await sleep(s * 1000);
      }
    }
  }

  async function transcribe(projectId, pcm, bounds, language, onProgress, signal) {
    const words = [], segments = [];
    let lang = null;
    for (let i = 0; i < bounds.length; i++) {
      if (signal && signal.aborted) throw new DOMException('Annulé', 'AbortError');
      const [from, to] = bounds[i];
      onProgress(i, bounds.length, null);
      const blob = wavBlob(pcm, from, to);
      const res = await withRetry(() => {
        const fd = new FormData();
        fd.append('file', blob, 'morceau-' + (i + 1) + '.wav');
        fd.append('model', (window.CM_CONFIG && window.CM_CONFIG.STT_MODEL) || 'whisper-large-v3-turbo');
        fd.append('response_format', 'verbose_json');
        fd.append('timestamp_granularities[]', 'word');
        fd.append('timestamp_granularities[]', 'segment');
        fd.append('temperature', '0');
        if (language) fd.append('language', language);
        return CM.api('/transcribe?project=' + encodeURIComponent(projectId), { form: fd, signal });
      }, (s) => onProgress(i, bounds.length, s), signal);
      lang = lang || res.language;
      (res.words || []).forEach((w) => words.push([w[0], +(w[1] + from).toFixed(2), +(w[2] + from).toFixed(2)]));
      (res.segments || []).forEach((s) => segments.push([+(s[0] + from).toFixed(2), +(s[1] + from).toFixed(2), s[2]]));
    }
    onProgress(bounds.length, bounds.length, null);
    return { language: lang, words, segments };
  }

  /* ---------- Choix des moments ---------- */

  const LENGTHS = { auto: [20, 60], court: [15, 30], moyen: [30, 60], long: [60, 90] };

  function autoCount(duration) { return clamp(Math.round(duration / 150), 3, 12); }

  // Découpe la transcription en fenêtres d'environ 7 min pour rester sous les quotas gratuits de l'IA.
  function windows(segments) {
    const out = []; let cur = [];
    for (const s of segments) {
      cur.push(s);
      if (cur[cur.length - 1][1] - cur[0][0] >= 420) { out.push(cur); cur = cur.slice(-3); }
    }
    if (cur.length && (!out.length || cur[cur.length - 1][1] - cur[0][0] > 40)) out.push(cur);
    return out;
  }

  function overlap(a, b) { return a.start < b.end && b.start < a.end; }

  async function aiMoments(projectId, tr, opts, onProgress, signal) {
    const [min, max] = LENGTHS[opts.length] || LENGTHS.auto;
    const wins = windows(tr.segments);
    const per = clamp(Math.ceil((opts.count * 1.6) / Math.max(1, wins.length)), 2, 6);
    let all = [], failures = 0;
    for (let i = 0; i < wins.length; i++) {
      if (signal && signal.aborted) throw new DOMException('Annulé', 'AbortError');
      onProgress(i, wins.length, null);
      try {
        const r = await withRetry(() => CM.api('/moments', { json: {
          project_id: projectId, segments: wins[i].map((s) => [s[0], s[1], s[2]]),
          min, max, count: per, language: tr.language || opts.language || '' }, signal }), (s) => onProgress(i, wins.length, s), signal);
        all = all.concat(r.clips || []);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        failures++;
        if (e.code === 'NON_CONNECTE' || e.code === 'QUOTA_PROJET_DEPASSE') throw e;
      }
    }
    onProgress(wins.length, wins.length, null);
    all.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of all) if (!kept.some((k) => overlap(k, c))) kept.push(c);
    return { clips: kept.slice(0, opts.count), failed: failures === wins.length && wins.length > 0 };
  }

  // Secours sans IA : on choisit les passages les plus intenses du son.
  function energyMoments(feat, duration, opts) {
    const [min, max] = LENGTHS[opts.length] || LENGTHS.auto;
    const D = (min + max) / 2, f = feat.f, es = feat.es, n = f.length, w = Math.max(1, Math.round(D / HOP));
    if (w >= n - 1) return [{ start: 0, end: duration, score: 50, title: '', context: '', hook: '', reason: 'Vidéo entière.' }];
    const P = new Float64Array(n + 1); for (let i = 0; i < n; i++) P[i + 1] = P[i] + f[i];
    const m = n - w + 1, sc = new Float32Array(m);
    for (let s = 0; s < m; s++) sc[s] = (P[s + w] - P[s]) / w;
    const idx = Array.from({ length: m }, (_, i) => i).sort((a, b) => sc[b] - sc[a]);
    const gap = Math.round(2 / HOP), chosen = [];
    for (const s of idx) {
      const e = s + w;
      if (chosen.every((c) => e + gap <= c.s || s >= c.e + gap)) { chosen.push({ s, e, v: sc[s] }); if (chosen.length >= opts.count) break; }
    }
    return chosen.map((c) => ({ start: c.s * HOP, end: Math.min(duration, c.e * HOP), score: Math.round(clamp(c.v * 100, 1, 99)),
      title: '', context: '', hook: '', reason: 'Passage choisi d\'après l\'intensité du son.' }));
  }

  // Cale le début et la fin d'un clip sur des mots entiers, avec une petite marge.
  function snapToWords(clip, words, duration) {
    if (!words || !words.length) return clip;
    let a = -1, b = -1;
    for (let i = 0; i < words.length; i++) { if (words[i][2] > clip.start - 0.05) { a = i; break; } }
    for (let i = words.length - 1; i >= 0; i--) { if (words[i][1] < clip.end + 0.05) { b = i; break; } }
    if (a < 0 || b < a) return clip;
    clip.start = Math.max(0, +(words[a][1] - 0.12).toFixed(2));
    clip.end = Math.min(duration, +(words[b][2] + 0.3).toFixed(2));
    return clip;
  }

  window.CMEngine = { HOP, SR, decodeMono, energy, chunkBounds, wavBlob, transcribe, aiMoments, energyMoments, snapToWords, autoCount, LENGTHS, windows };
})();
