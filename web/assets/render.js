/* ClipMoment — rendu vertical 9:16 : gabarits, titres, sous-titres animés, cadrage sur le visage, export. */
(function () {
  'use strict';
  const W = 720, H = 1280;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const TEMPLATES = {
    citation: { label: 'Citation', note: 'Citation entre guillemets dans des bandes blanches, façon chaîne TV.', captions: false },
    dynamique: { label: 'Sous-titres animés', note: 'Gros sous-titres mot par mot, le mot prononcé en couleur.', captions: true },
    sobre: { label: 'Sobre', note: 'Sous-titres blancs discrets, phrase par phrase.', captions: true },
  };

  const FONTS = {
    quote: '"Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif',
    bold: 'Montserrat, "Arial Black", Impact, sans-serif',
    body: '"Instrument Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  };

  function defaultStyle(template) {
    return { template: template || 'citation', titleSec: template === 'citation' || !template ? 14 : 3,
      captions: !!(TEMPLATES[template || 'citation'] || {}).captions, capY: 0.7, frame: 'auto', manualX: 0.5, track: null, edits: {} };
  }

  /* ---------- Sous-titres : regroupement des mots ---------- */

  function buildGroups(words, start, end, mode) {
    const ws = (words || []).filter((w) => w[2] > start + 0.02 && w[1] < end - 0.02);
    const karaoke = mode === 'dynamique';
    const maxN = karaoke ? 3 : 7, maxC = karaoke ? 18 : 38, stop = karaoke ? /[.!?…,;:]$/ : /[.!?…]$/;
    const out = []; let cur = [];
    const flush = () => { if (cur.length) { out.push({ words: cur, start: cur[0][1], end: cur[cur.length - 1][2] }); cur = []; } };
    for (const w of ws) {
      const prev = cur[cur.length - 1];
      const len = cur.reduce((s, x) => s + x[0].length + 1, 0);
      if (cur.length && (cur.length >= maxN || len + w[0].length > maxC || w[1] - prev[2] > 0.6)) flush();
      cur.push(w);
      if (stop.test(w[0])) flush();
    }
    flush();
    out.forEach((g, i) => { const nx = out[i + 1]; g.until = nx ? Math.min(nx.start, g.end + 0.8) : g.end + 0.6; g.key = g.start.toFixed(2); });
    return out;
  }

  /* ---------- Dessin ---------- */

  const tiny = document.createElement('canvas'); tiny.width = 18; tiny.height = 32;
  const tctx = tiny.getContext('2d');

  function trackAt(track, t) {
    if (!track || !track.length) return 0.5;
    if (t <= track[0][0]) return track[0][1];
    for (let i = 1; i < track.length; i++) {
      if (t < track[i][0]) {
        const a = track[i - 1], b = track[i];
        if (Math.abs(b[1] - a[1]) > 0.2) return a[1]; // changement de plan : pas de glissement
        return a[1] + (b[1] - a[1]) * ((t - a[0]) / (b[0] - a[0]));
      }
    }
    return track[track.length - 1][1];
  }

  function drawVideo(ctx, src, sw, sh, st, rel) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (!sw || !sh) return;
    const vertical = sh / sw >= 1.5;
    const mode = vertical && (st.frame === 'auto' || st.frame === 'manuel') ? 'cover' : st.frame;
    try {
      if (mode === 'flou' || mode === 'entier') {
        if (mode === 'flou') {
          const s = Math.max(18 / sw, 32 / sh);
          tctx.drawImage(src, (18 - sw * s) / 2, (32 - sh * s) / 2, sw * s, sh * s);
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(tiny, 0, 0, W, H);
          ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(0, 0, W, H);
        }
        const s = Math.min(W / sw, H / sh), dw = sw * s, dh = sh * s;
        ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
        return;
      }
      let s = H / sh; if (sw * s < W) s = W / sw;
      const dw = sw * s, dh = sh * s;
      const cx = mode === 'cover' ? 0.5 : st.frame === 'manuel' ? st.manualX : trackAt(st.track, rel);
      const x = clamp(W / 2 - cx * dw, W - dw, 0);
      ctx.drawImage(src, x, (H - dh) / 2, dw, dh);
    } catch (e) { /* image pas encore prête */ }
  }

  function wrap(ctx, text, maxW) {
    const words = String(text || '').split(/\s+/).filter(Boolean), lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }

  function fadeAlpha(rel, sec, len) {
    if (!sec || sec >= len) return 1;
    if (rel > sec) return 0;
    return clamp((sec - rel) / 0.3, 0, 1);
  }

  // Gabarit « Citation » : bandes blanches alignées à gauche, texte noir condensé, ligne de contexte.
  function drawQuote(ctx, clip, st, rel, len) {
    const a = fadeAlpha(rel, st.titleSec, len);
    if (a <= 0 || !(clip.title || clip.context)) return;
    ctx.save(); ctx.globalAlpha = a; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const x0 = 52, padX = 13, maxW = W - x0 * 2 - padX * 2;
    let size = 46;
    ctx.font = '700 ' + size + 'px ' + FONTS.quote;
    let lines = wrap(ctx, clip.title, maxW);
    while (lines.length > 4 && size > 34) { size -= 3; ctx.font = '700 ' + size + 'px ' + FONTS.quote; lines = wrap(ctx, clip.title, maxW); }
    lines = lines.slice(0, 5);
    const lh = Math.round(size * 1.24), cs = 26, clh = 38;
    ctx.font = '400 ' + cs + 'px ' + FONTS.quote;
    const clines = clip.context ? wrap(ctx, clip.context, maxW).slice(0, 2) : [];
    const block = lines.length * lh + (clines.length ? 10 + clines.length * clh : 0);
    let y = Math.min(H * 0.655, H - 170 - block);
    ctx.font = '700 ' + size + 'px ' + FONTS.quote;
    for (const ln of lines) {
      const w = ctx.measureText(ln).width;
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x0, y, w + padX * 2, lh);
      ctx.fillStyle = '#0B0B0B'; ctx.fillText(ln, x0 + padX, y + lh / 2 + 1);
      y += lh;
    }
    if (clines.length) {
      y += 10; ctx.font = '400 ' + cs + 'px ' + FONTS.quote;
      for (const ln of clines) {
        const w = ctx.measureText(ln).width;
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x0, y, w + 20, clh);
        ctx.fillStyle = '#1A1A1A'; ctx.fillText(ln, x0 + 10, y + clh / 2 + 1);
        y += clh;
      }
    }
    ctx.restore();
  }

  // Accroche en haut de l'écran (gabarits animé et sobre).
  function drawHook(ctx, clip, st, rel, len) {
    const text = (clip.hook || clip.title || '').trim();
    const a = fadeAlpha(rel, st.titleSec, len);
    if (!text || a <= 0) return;
    ctx.save(); ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let size = 42; ctx.font = '800 ' + size + 'px ' + FONTS.bold;
    let lines = wrap(ctx, text, W * 0.8);
    if (lines.length > 3) { size = 34; ctx.font = '800 ' + size + 'px ' + FONTS.bold; lines = wrap(ctx, text, W * 0.82).slice(0, 4); }
    const lh = size * 1.22, padX = 18, padY = 12;
    const bw = Math.max.apply(null, lines.map((l) => ctx.measureText(l).width)) + padX * 2, bh = lines.length * lh + padY * 2;
    const x = (W - bw) / 2, y = H * 0.1;
    ctx.fillStyle = '#FFFFFF'; roundRect(ctx, x, y, bw, bh, 14); ctx.fill();
    ctx.fillStyle = '#0B0B0B';
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y + padY + lh * i + lh / 2 + 1));
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawCaptions(ctx, groups, st, tAbs, brand) {
    const g = groups.find((x) => tAbs >= x.start - 0.05 && tAbs < x.until);
    if (!g) return;
    const edited = st.edits && st.edits[g.key] != null ? String(st.edits[g.key]) : null;
    const y = st.capY * H;
    ctx.save(); ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    if (st.template === 'dynamique') {
      const tokens = edited != null ? edited.split(/\s+/).filter(Boolean).map((w) => [w, -1, -1]) : g.words;
      let size = 60;
      const fontAt = (s) => '900 ' + s + 'px ' + FONTS.bold;
      ctx.font = fontAt(size);
      const txt = tokens.map((w) => w[0].toUpperCase());
      const sp = () => ctx.measureText(' ').width + size * 0.2;
      let lines = [[]], lw = [0];
      const maxW = W * 0.86;
      const layout = () => {
        lines = [[]]; lw = [0];
        txt.forEach((w, i) => {
          const ww = ctx.measureText(w).width, li = lines.length - 1;
          const need = lw[li] + (lines[li].length ? sp() : 0) + ww;
          if (need > maxW && lines[li].length) { lines.push([i]); lw.push(ww); } else { lines[li].push(i); lw[li] = need; }
        });
      };
      layout();
      while ((lines.length > 2 || Math.max.apply(null, lw) > maxW) && size > 34) { size -= 4; ctx.font = fontAt(size); layout(); }
      const lh = size * 1.18, top = y - (lines.length * lh) / 2;
      lines.forEach((li, r) => {
        let x = (W - lw[r]) / 2;
        const cy = top + lh * r + lh / 2;
        li.forEach((i) => {
          const w = tokens[i], word = txt[i], ww = ctx.measureText(word).width;
          const next = tokens[i + 1];
          const active = w[1] >= 0 && tAbs >= w[1] && tAbs < (next && next[1] >= 0 ? next[1] : w[2] + 0.4);
          ctx.save();
          ctx.translate(x + ww / 2, cy);
          if (active) ctx.scale(1.08, 1.08);
          ctx.textAlign = 'center';
          ctx.lineWidth = size * 0.2; ctx.strokeStyle = '#000'; ctx.strokeText(word, 0, 0);
          ctx.fillStyle = active ? (brand.highlight || '#FFE600') : '#FFFFFF'; ctx.fillText(word, 0, 0);
          ctx.restore();
          x += ww + sp();
        });
      });
    } else {
      const text = edited != null ? edited : g.words.map((w) => w[0]).join(' ');
      ctx.font = '600 40px ' + FONTS.body; ctx.textAlign = 'center';
      const lines = wrap(ctx, text, W * 0.84).slice(0, 3), lh = 52, top = y - (lines.length * lh) / 2;
      lines.forEach((l, i) => {
        const cy = top + lh * i + lh / 2;
        ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 12;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(l, W / 2, cy);
        ctx.shadowBlur = 0; ctx.fillStyle = '#FFFFFF'; ctx.fillText(l, W / 2, cy);
      });
    }
    ctx.restore();
  }

  const logoCache = { src: null, img: null };
  function logoImg(src) {
    if (!src) return null;
    if (logoCache.src !== src) { logoCache.src = src; logoCache.img = new Image(); logoCache.img.src = src; }
    return logoCache.img.complete && logoCache.img.naturalWidth ? logoCache.img : null;
  }

  function drawBrand(ctx, brand, prog) {
    const img = logoImg(brand.logo);
    if (img) {
      const s = Math.min(170 / img.naturalWidth, 80 / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.drawImage(img, W - 46 - w, 58, w, h);
    }
    if (brand.handle && brand.handle.trim()) {
      ctx.save(); ctx.font = '600 28px ' + FONTS.body; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 8; ctx.fillStyle = 'rgba(255,255,255,.88)';
      ctx.fillText(brand.handle.trim(), W / 2, H * 0.945); ctx.restore();
    }
    if (brand.progress) {
      ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(0, H - 10, W, 10);
      ctx.fillStyle = brand.highlight || '#FFE600'; ctx.fillRect(0, H - 10, W * clamp(prog, 0, 1), 10);
    }
  }

  /** Dessine une image complète du clip au temps absolu tAbs (en secondes dans la vidéo source). */
  function draw(ctx, src, sw, sh, clip, groups, tAbs, brand) {
    const st = clip.style, len = Math.max(0.1, clip.end - clip.start), rel = clamp(tAbs - clip.start, 0, len);
    ctx.save();
    drawVideo(ctx, src, sw, sh, st, rel);
    if (st.captions && groups) drawCaptions(ctx, groups, st, tAbs, brand || {});
    if (st.template === 'citation') drawQuote(ctx, clip, st, rel, len); else drawHook(ctx, clip, st, rel, len);
    drawBrand(ctx, brand || {}, rel / len);
    ctx.restore();
  }

  /* ---------- Suivi du visage ---------- */

  const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';
  let detP = null;
  function detector() {
    if (detP) return detP;
    detP = (async () => {
      if ('FaceDetector' in window) {
        try {
          const fd = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
          const probe = document.createElement('canvas'); probe.width = probe.height = 8;
          await fd.detect(probe);
          return { kind: 'natif', detect: async (c) => (await fd.detect(c)).map((f) => f.boundingBox) };
        } catch (e) { /* non disponible */ }
      }
      try {
        let v = null;
        for (const u of [MP, MP + '/vision_bundle.mjs', MP + '/+esm']) { try { v = await import(u); if (v && v.FaceDetector) break; } catch (e) { v = null; } }
        if (!v || !v.FaceDetector) return null;
        const fs = await v.FilesetResolver.forVisionTasks(MP + '/wasm');
        const d = await v.FaceDetector.createFromOptions(fs, { baseOptions: { modelAssetPath: MP_MODEL, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.45 });
        return { kind: 'mediapipe', detect: async (c) => d.detect(c).detections.map((x) => ({ x: x.boundingBox.originX, y: x.boundingBox.originY, width: x.boundingBox.width, height: x.boundingBox.height })) };
      } catch (e) { return null; }
    })();
    return detP;
  }

  function seek(v, t) {
    return new Promise((res) => {
      const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
      const to = setTimeout(done, 3000);
      v.addEventListener('seeked', done);
      try { v.currentTime = t; } catch (e) { done(); }
    });
  }

  /** Analyse le cadrage d'un clip : position horizontale du visage principal toutes les 0,5 s. */
  async function analyzeFraming(url, clip, onProgress, signal) {
    const det = await detector();
    if (!det) return { track: null, detector: null };
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(v);
    try {
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(res, 8000); });
      const sw = v.videoWidth, sh = v.videoHeight;
      if (!sw || sh / sw >= 1.5) return { track: null, detector: det.kind };
      const c = document.createElement('canvas'); c.width = 384; c.height = Math.round(384 * sh / sw);
      const cx = c.getContext('2d', { willReadFrequently: true });
      const raw = [], step = 0.5, len = clip.end - clip.start;
      for (let t = 0; t <= len + 0.01; t += step) {
        if (signal && signal.aborted) throw new DOMException('Annulé', 'AbortError');
        await seek(v, clip.start + t);
        cx.drawImage(v, 0, 0, c.width, c.height);
        let boxes = [];
        try { boxes = await det.detect(c); } catch (e) { boxes = []; }
        let best = null;
        for (const b of boxes) if (!best || b.width * b.height > best.width * best.height) best = b;
        raw.push([+t.toFixed(2), best ? (best.x + best.width / 2) / c.width : null]);
        if (onProgress) onProgress(Math.min(1, t / len));
      }
      if (!raw.some((p) => p[1] != null)) return { track: null, detector: det.kind };
      for (let i = 0; i < raw.length; i++) if (raw[i][1] == null) {
        let j = i; while (j < raw.length && raw[j][1] == null) j++;
        const fill = j < raw.length ? raw[j][1] : raw[i - 1][1];
        for (let k = i; k < j; k++) raw[k][1] = fill;
      }
      const out = []; let cur = raw[0][1];
      for (const [t, x] of raw) {
        if (Math.abs(x - cur) > 0.22) cur = x;            // changement de plan : saut direct
        else if (Math.abs(x - cur) > 0.03) cur += (x - cur) * 0.35; // petit mouvement : glissement doux
        out.push([t, +cur.toFixed(3)]);
      }
      return { track: out, detector: det.kind };
    } finally { v.removeAttribute('src'); v.load(); v.remove(); }
  }

  /* ---------- Export ---------- */

  function pickMime() {
    const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (const t of types) { try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t; } catch (e) { /* ignore */ } }
    return '';
  }

  window.CMRender = { W, H, TEMPLATES, defaultStyle, buildGroups, draw, analyzeFraming, detector, pickMime, trackAt };
})();
