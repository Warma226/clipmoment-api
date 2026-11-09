/* ClipMoment — application (studio client). */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const { el, toast, fmtTime, errMsg } = CM;
  const E = window.CMEngine, R = window.CMRender;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const S = {
    session: null, profile: null, settings: {}, brand: {},
    file: null, url: null, meta: null,
    project: null, clips: [], sel: -1, groups: [],
    playing: false, dirty: true, exporting: null, analyzing: null, framing: null, result: null, saveTimer: null,
  };

  document.querySelectorAll('[data-brand]').forEach((n) => { n.textContent = CM.brand; });
  if (CM.DEMO) $('#demo-banner').hidden = false;

  /* ---------------- Vues ---------------- */
  const VIEWS = ['auth', 'newpass', 'home', 'analyse', 'clips', 'editor'];
  function show(v) {
    VIEWS.forEach((n) => { $('#v-' + n).hidden = n !== v; });
    if (v !== 'editor') { const vid = $('#vid'); if (!vid.paused) vid.pause(); }
    window.scrollTo(0, 0);
    S.view = v;
  }

  /* ---------------- Connexion ---------------- */
  let authMode = 'login';
  function setAuthMode(m) {
    authMode = m;
    $('#auth-err').hidden = true; $('#auth-ok').hidden = true;
    $('#auth-title').textContent = m === 'signup' ? 'Créer un compte' : m === 'forgot' ? 'Mot de passe oublié' : 'Connexion';
    $('#auth-sub').textContent = m === 'signup' ? 'Tes premiers crédits sont offerts à l\'inscription.'
      : m === 'forgot' ? 'Indique ton adresse : tu recevras un lien pour choisir un nouveau mot de passe.'
        : 'Connecte-toi pour retrouver tes projets et tes crédits.';
    $('#auth-submit').textContent = m === 'signup' ? 'Créer mon compte' : m === 'forgot' ? 'Recevoir le lien' : 'Se connecter';
    $('#auth-switch').textContent = m === 'login' ? 'Créer un compte' : 'J\'ai déjà un compte';
    $('#auth-pass-row').hidden = m === 'forgot';
    $('#auth-forgot').hidden = m !== 'login';
    $('#auth-pass').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
  }
  $('#auth-switch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
  $('#auth-forgot').addEventListener('click', () => setAuthMode('forgot'));
  const AUTH_ERRORS = [
    [/invalid login/i, 'E-mail ou mot de passe incorrect.'],
    [/already registered|already been registered/i, 'Un compte existe déjà avec cette adresse. Connecte-toi.'],
    [/not confirmed/i, 'Confirme d\'abord ton adresse avec le lien reçu par e-mail, puis connecte-toi.'],
    [/at least 6/i, 'Le mot de passe doit faire au moins 6 caractères.'],
    [/rate limit|too many/i, 'Trop de tentatives. Patiente quelques minutes puis réessaie.'],
    [/invalid.*email|valid email/i, 'Cette adresse e-mail n\'est pas valide.'],
  ];
  function authErr(e) {
    const m = String(e && e.message || e);
    for (const [re, t] of AUTH_ERRORS) if (re.test(m)) return t;
    return errMsg(e);
  }
  $('#auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('#auth-email').value.trim(), pass = $('#auth-pass').value;
    const err = $('#auth-err'), ok = $('#auth-ok'), btn = $('#auth-submit');
    err.hidden = true; ok.hidden = true;
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Indique une adresse e-mail valide.'; err.hidden = false; return; }
    if (authMode !== 'forgot' && pass.length < 6) { err.textContent = 'Le mot de passe doit faire au moins 6 caractères.'; err.hidden = false; return; }
    btn.disabled = true;
    try {
      if (authMode === 'login') { await CM.auth.signIn(email, pass); await boot(); }
      else if (authMode === 'signup') {
        const r = await CM.auth.signUp(email, pass);
        if (r && r.session) await boot();
        else { setAuthMode('login'); ok.textContent = 'Compte créé. Ouvre le lien reçu par e-mail pour l\'activer, puis connecte-toi.'; ok.hidden = false; }
      } else { await CM.auth.reset(email); ok.textContent = 'Si un compte existe avec cette adresse, un lien vient d\'être envoyé.'; ok.hidden = false; }
    } catch (e) { err.textContent = authErr(e); err.hidden = false; }
    finally { btn.disabled = false; }
  });
  $('#newpass-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const p = $('#newpass').value;
    if (p.length < 6) { toast('Le mot de passe doit faire au moins 6 caractères.', 'err'); return; }
    try { await CM.auth.updatePassword(p); toast('Mot de passe enregistré.'); history.replaceState(null, '', 'app.html'); await boot(); }
    catch (e) { toast(authErr(e), 'err'); }
  });
  $('#logout').addEventListener('click', async () => { await CM.auth.signOut(); location.reload(); });

  CM.auth.onChange((s, ev) => {
    if (ev === 'PASSWORD_RECOVERY') { show('newpass'); return; }
    if (!s && S.session) location.reload();
  });

  async function boot() {
    const s = await CM.auth.session();
    S.session = s;
    if (!s) { setAuthMode('login'); show('auth'); $('#credits-btn').hidden = true; $('#logout').hidden = true; return; }
    $('#logout').hidden = false; $('#credits-btn').hidden = false;
    try { S.profile = await CM.db.profile(); } catch (e) { S.profile = { credits: 0, email: s.user.email }; }
    setCredits(S.profile.credits);
    $('#admin-link').hidden = !S.profile.is_admin;
    S.settings = await CM.loadSettings();
    $('#max-tag').textContent = (Number(S.settings.max_minutes) || 30) + ' min max';
    loadBrand();
    show('home');
    renderProjects();
  }

  function setCredits(n) { if (S.profile) S.profile.credits = n; $('#credits').textContent = String(n); }

  /* ---------------- Choix de la vidéo ---------------- */
  function loadVideoMeta(url) {
    return new Promise((res, rej) => {
      const v = $('#pick-vid');
      const ok = () => { cleanup(); try { v.currentTime = Math.min(1, (v.duration || 0) / 3); } catch (e) { /* aperçu */ } res({ dur: v.duration, w: v.videoWidth, h: v.videoHeight }); };
      const ko = () => { cleanup(); rej(new Error('Cette vidéo ne s\'ouvre pas dans ton navigateur. Essaie un fichier MP4 (H.264).')); };
      const t = setTimeout(ko, 20000);
      function cleanup() { clearTimeout(t); v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', ko); }
      v.addEventListener('loadedmetadata', ok); v.addEventListener('error', ko);
      v.src = url; v.load();
    });
  }

  async function useFile(f) {
    if (S.url) URL.revokeObjectURL(S.url);
    S.file = f; S.url = URL.createObjectURL(f);
    const meta = await loadVideoMeta(S.url);
    if (!isFinite(meta.dur) || !meta.dur) throw new Error('Impossible de lire la durée de cette vidéo. Essaie un fichier MP4.');
    S.meta = meta;
    const vid = $('#vid'); vid.src = S.url; vid.load();
    return meta;
  }

  const homeErr = (msg) => { const n = $('#home-err'); n.textContent = msg || ''; n.hidden = !msg; };

  async function pickFile(f) {
    homeErr('');
    try { await useFile(f); }
    catch (e) { homeErr(e.message); $('#picked').hidden = true; return; }
    $('#picked').hidden = false; $('#drop').hidden = true;
    $('#pick-name').textContent = f.name;
    const m = S.meta;
    $('#pick-meta').textContent = fmtTime(m.dur) + ' · ' + m.w + '×' + m.h + ' · ' + (f.size / 1048576).toFixed(f.size > 1e8 ? 0 : 1) + ' Mo';
    updateCost();
  }
  function updateCost() {
    if (!S.meta) return;
    const maxMin = Number(S.settings.max_minutes) || 30, cost = Math.ceil(S.meta.dur / 60);
    $('#cost').textContent = cost + (cost > 1 ? ' crédits' : ' crédit');
    const credits = S.profile ? S.profile.credits : 0;
    const start = $('#start');
    if (S.meta.dur > maxMin * 60 + 5) {
      $('#cost-note').textContent = 'Cette vidéo dépasse ' + maxMin + ' min. Coupe-la en plusieurs parties.';
      start.disabled = true;
    } else if (cost > credits) {
      $('#cost-note').textContent = 'Il te reste ' + credits + ' crédit' + (credits > 1 ? 's' : '') + '. Recharge ton compte pour analyser cette vidéo.';
      start.disabled = false; start.textContent = 'Recharger mes crédits';
      start.dataset.mode = 'recharge'; return;
    } else {
      $('#cost-note').textContent = '1 crédit par minute · il t\'en reste ' + credits;
      start.disabled = false;
    }
    start.textContent = 'Trouver les meilleurs moments'; start.dataset.mode = 'start';
  }
  $('#file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) pickFile(f); });
  $('#pick-change').addEventListener('click', () => $('#file').click());
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) pickFile(f); });
  $('#start').addEventListener('click', () => { if ($('#start').dataset.mode === 'recharge') openCredits(); else startAnalysis(); });

  /* ---------------- Projets ---------------- */
  async function renderProjects() {
    const box = $('#projects'); box.textContent = '';
    let list = [];
    try { list = await CM.db.projects(); } catch (e) { toast(errMsg(e), 'err'); }
    $('#proj-empty').hidden = list.length > 0;
    $('#proj-count').textContent = list.length ? list.length + ' projet' + (list.length > 1 ? 's' : '') : '';
    list.forEach((p) => {
      const n = (p.clips || []).length;
      const d = new Date(p.created_at);
      box.appendChild(el('button', { class: 'proj', type: 'button', onclick: () => openProject(p.id) }, [
        el('b', { text: p.title || p.file_name || 'Vidéo' }),
        el('span', { class: 'muted small', text: (p.status === 'analyse' ? 'Analyse interrompue' : n + ' clip' + (n > 1 ? 's' : '')) + ' · ' + fmtTime(p.duration) + ' · ' + d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) }),
      ]));
    });
  }

  async function openProject(id) {
    let p;
    try { p = await CM.db.project(id); } catch (e) { toast(errMsg(e), 'err'); return; }
    if (p.status === 'analyse' || !p.clips) { toast('Cette analyse n\'est pas allée au bout. Relance-la avec la vidéo.', 'err'); return; }
    setProject(p);
    if (S.file && !(S.file.name === p.file_name && S.file.size === Number(p.file_size))) { S.file = null; if (S.url) URL.revokeObjectURL(S.url); S.url = null; }
    openClips();
  }

  function setProject(p) {
    S.project = p;
    S.clips = (p.clips || []).map((c, i) => Object.assign({ id: c.id || 'c' + i }, c, { style: Object.assign(R.defaultStyle(c.style && c.style.template), c.style || {}) }));
  }

  /* ---------------- Analyse ---------------- */
  function step(name, state, detail) {
    const li = $('#steps [data-step="' + name + '"]');
    li.classList.toggle('on', state === 'on'); li.classList.toggle('done', state === 'done');
    if (detail != null) li.querySelector('[data-detail]').textContent = detail ? ' — ' + detail : '';
  }
  const anBar = (p) => { $('#an-bar').style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%'; };

  async function startAnalysis() {
    if (!S.file || !S.meta || S.analyzing) return;
    homeErr('');
    const dur = S.meta.dur;
    const opts = { language: $('#opt-lang').value, length: $('#opt-len').value, template: $('#opt-tpl').value,
      count: Number($('#opt-count').value) || E.autoCount(dur) };
    ['audio', 'stt', 'ai'].forEach((n) => step(n, '', ''));
    $('#an-err').hidden = true; $('#an-back').hidden = true; $('#an-cancel').hidden = false; anBar(0);
    $('#an-title').textContent = 'Analyse de « ' + S.file.name + ' »';
    show('analyse');
    const ac = new AbortController();
    S.analyzing = { ac, pid: null };
    let start;
    try {
      start = await CM.api('/analyze/start', { json: { seconds: Math.ceil(dur), title: S.file.name.replace(/\.[^.]+$/, ''), file_name: S.file.name, file_size: S.file.size } });
    } catch (e) { S.analyzing = null; show('home'); homeErr(errMsg(e)); return; }
    setCredits(start.credits);
    const pid = start.project_id; S.analyzing.pid = pid;
    let transcribed = false;
    try {
      step('audio', 'on', 'décodage de la piste son');
      const { pcm, duration } = await E.decodeMono(S.file);
      const feat = E.energy(pcm);
      step('audio', 'done', fmtTime(duration)); anBar(0.08);

      const bounds = E.chunkBounds(feat, duration);
      step('stt', 'on', bounds.length > 1 ? 'morceau 1 sur ' + bounds.length : 'en cours');
      const tr = await E.transcribe(pid, pcm, bounds, opts.language, (i, n, wait) => {
        step('stt', 'on', wait ? 'service saturé, nouvel essai dans ' + Math.round(wait) + ' s' : (n > 1 ? 'morceau ' + Math.min(i + 1, n) + ' sur ' + n : 'en cours'));
        anBar(0.08 + 0.62 * (i / n));
      }, ac.signal);
      transcribed = true;
      step('stt', 'done', tr.words.length + ' mots'); anBar(0.7);

      step('ai', 'on', 'lecture de la transcription');
      let res = { clips: [], failed: true };
      if (tr.words.length >= 15) {
        res = await E.aiMoments(pid, tr, opts, (i, n, wait) => {
          step('ai', 'on', wait ? 'IA saturée, nouvel essai dans ' + Math.round(wait) + ' s' : (n > 1 ? 'partie ' + Math.min(i + 1, n) + ' sur ' + n : 'en cours'));
          anBar(0.7 + 0.28 * (i / Math.max(1, n)));
        }, ac.signal);
      }
      let clips = res.clips, fallback = false;
      if (!clips.length) { clips = E.energyMoments(feat, duration, opts); fallback = true; }
      clips = clips.map((c, i) => {
        const x = E.snapToWords(Object.assign({}, c), tr.words, duration);
        x.id = 'c' + Date.now().toString(36) + i;
        x.style = R.defaultStyle(opts.template);
        if (!x.title && opts.template === 'citation') x.style.captions = true;
        return x;
      }).sort((a, b) => b.score - a.score);
      step('ai', 'done', clips.length + ' clips' + (fallback ? ' (choisis d\'après le son)' : '')); anBar(1);

      const transcript = { language: tr.language, words: tr.words, segments: tr.segments };
      const project = { id: pid, title: S.file.name.replace(/\.[^.]+$/, ''), file_name: S.file.name, file_size: S.file.size, duration, language: tr.language, transcript, clips, status: 'pret' };
      setProject(project);
      try { await CM.db.updateProject(pid, { transcript, clips: S.clips, status: 'pret', language: tr.language }); }
      catch (e) { toast('Les clips sont prêts mais n\'ont pas pu être enregistrés en ligne : ' + errMsg(e), 'err'); }
      S.analyzing = null;
      if (fallback) toast(tr.words.length < 15 ? 'Peu de paroles détectées : les clips ont été choisis d\'après le son.' : errMsg({ code: 'ERREUR_IA' }));
      openClips();
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      let refunded = 0;
      if (!transcribed) {
        try { const r = await CM.api('/analyze/cancel', { json: { project_id: pid } }); refunded = r.refunded || 0; if (r.credits != null) setCredits(r.credits); } catch (_) { /* ignore */ }
      }
      S.analyzing = null;
      if (aborted) { show('home'); toast('Analyse annulée.' + (refunded ? ' ' + refunded + ' crédit' + (refunded > 1 ? 's' : '') + ' rendu' + (refunded > 1 ? 's' : '') + '.' : '')); return; }
      $$('#steps li.on').forEach((li) => li.classList.remove('on'));
      const box = $('#an-err');
      box.textContent = errMsg(e) + (refunded ? ' Tes ' + refunded + ' crédit' + (refunded > 1 ? 's ont' : ' a') + ' été rendu' + (refunded > 1 ? 's' : '') + '.' : '');
      box.hidden = false; $('#an-cancel').hidden = true; $('#an-back').hidden = false;
    }
  }
  $('#an-cancel').addEventListener('click', () => { if (S.analyzing) S.analyzing.ac.abort(); });
  $('#an-back').addEventListener('click', () => { show('home'); renderProjects(); updateCost(); });

  /* ---------------- Grille des clips ---------------- */
  let thumbJob = 0;
  function openClips() {
    const p = S.project;
    $('#clips-title').textContent = p.title || p.file_name || 'Projet';
    $('#clips-meta').textContent = S.clips.length + ' clips · vidéo de ' + fmtTime(p.duration) + (p.language ? ' · ' + p.language : '');
    $('#need-file').hidden = !!S.url;
    $('#need-name').textContent = p.file_name || '';
    renderCards();
    show('clips');
  }
  function words() { return S.project && S.project.transcript ? S.project.transcript.words || [] : []; }

  function renderCards() {
    const box = $('#cards'); box.textContent = '';
    S.clips.forEach((c, i) => {
      const cv = el('canvas', { width: 270, height: 480, 'aria-hidden': 'true' });
      const len = c.end - c.start;
      box.appendChild(el('article', { class: 'card' }, [
        el('button', { class: 'thumb', type: 'button', 'aria-label': 'Modifier le clip ' + (i + 1), onclick: () => openEditor(i) }, [
          cv,
          el('span', { class: 'score', title: 'Potentiel viral estimé' }, [el('i'), String(c.score) + '/100']),
          el('span', { class: 'dur', text: Math.round(len) + ' s' }),
        ]),
        el('div', { class: 'body' }, [
          el('span', { class: 't', text: c.title || c.hook || 'Clip ' + (i + 1) }),
          el('span', { class: 'muted small mono', text: fmtTime(c.start) + ' → ' + fmtTime(c.end) }),
          c.reason ? el('span', { class: 'why', text: c.reason }) : null,
        ]),
        el('div', { class: 'act' }, [el('button', { class: 'btn small', type: 'button', text: 'Modifier', onclick: () => openEditor(i) })]),
      ]));
      c._thumb = cv;
    });
    drawThumbs();
  }

  async function drawThumbs() {
    const job = ++thumbJob;
    const big = document.createElement('canvas'); big.width = R.W; big.height = R.H;
    const bctx = big.getContext('2d');
    let v = null;
    if (S.url) {
      v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = S.url;
      v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none';
      document.body.appendChild(v);
      await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); });
    }
    try {
      for (const c of S.clips) {
        if (job !== thumbJob) return;
        const t = c.start + Math.min(1.2, (c.end - c.start) / 3);
        if (v && v.videoWidth) {
          await new Promise((r) => { const d = () => { v.removeEventListener('seeked', d); clearTimeout(to); r(); }; const to = setTimeout(d, 2500); v.addEventListener('seeked', d); try { v.currentTime = t; } catch (e) { d(); } });
        }
        const groups = R.buildGroups(words(), c.start, c.end, c.style.template);
        R.draw(bctx, v, v ? v.videoWidth : 0, v ? v.videoHeight : 0, c, groups, t, S.brand);
        const tc = c._thumb.getContext('2d');
        tc.drawImage(big, 0, 0, c._thumb.width, c._thumb.height);
      }
    } finally { if (v) { v.removeAttribute('src'); v.load(); v.remove(); } }
  }

  $('#clips-back').addEventListener('click', () => { show('home'); renderProjects(); });
  $('#refile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const meta = await useFile(f);
      if (S.project && Math.abs(meta.dur - S.project.duration) > 3) toast('Attention : cette vidéo n\'a pas la même durée que celle du projet.', 'err');
      $('#need-file').hidden = true; renderCards();
    } catch (err) { toast(err.message, 'err'); }
  });

  /* ---------------- Sauvegarde ---------------- */
  function scheduleSave() {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(async () => {
      if (!S.project) return;
      const clips = S.clips.map((c) => { const o = Object.assign({}, c); delete o._thumb; return o; });
      try { await CM.db.updateProject(S.project.id, { clips }); } catch (e) { toast('Modifications non enregistrées : ' + errMsg(e), 'err'); }
    }, 1200);
  }

  /* ---------------- Éditeur ---------------- */
  const vid = $('#vid'), cv = $('#cv'), ctx = cv.getContext('2d');
  const cur = () => S.clips[S.sel];

  function regroup() { const c = cur(); S.groups = c ? R.buildGroups(words(), c.start, c.end, c.style.template) : []; renderCapEdit(); S.dirty = true; }

  function openEditor(i) {
    S.sel = i;
    const c = cur(); if (!c) return;
    const st = c.style;
    $('#ed-title').textContent = 'Clip ' + (i + 1);
    $('#ed-score').textContent = 'Potentiel ' + c.score + '/100';
    $('#ed-reason').textContent = c.reason || '';
    $('#tpl-' + st.template).checked = true;
    $('#in-title').value = c.title || ''; $('#in-context').value = c.context || ''; $('#in-hook').value = c.hook || '';
    $('#in-titlesec').value = String(st.titleSec);
    $('#in-caps').checked = !!st.captions; $('#in-capy').value = Math.round(st.capY * 100);
    $('#fr-' + st.frame).checked = true; $('#in-manual').value = Math.round(st.manualX * 100);
    $('#result').hidden = true;
    tplFields(); frameFields();
    regroup(); updTrim();
    show('editor');
    if (S.url) { vid.pause(); try { vid.currentTime = c.start; } catch (e) { /* attente des métadonnées */ } }
    else toast('Resélectionne la vidéo d\'origine pour voir l\'aperçu.', 'err');
    maybeFraming();
  }

  function tplFields() {
    const t = cur().style.template;
    $('#f-context').hidden = t !== 'citation';
    $('#f-hook').hidden = t === 'citation';
    $('#f-title').querySelector('.lbl').textContent = t === 'citation' ? 'Titre-citation' : 'Titre (si pas d\'accroche)';
  }
  function frameFields() {
    const st = cur().style;
    $('#f-manual').hidden = st.frame !== 'manuel';
    const n = $('#frame-note');
    if (st.frame === 'auto') n.textContent = S.framing ? 'Recherche du visage…' : st.track ? 'Le cadrage suit le visage principal.' : (st._noDetector ? 'Suivi du visage indisponible sur ce navigateur : choisis « Manuel ».' : '');
    else n.textContent = st.frame === 'flou' ? 'La vidéo entière au centre, sur un fond flou.' : st.frame === 'entier' ? 'La vidéo entière, avec des bandes noires.' : '';
  }
  function updTrim() {
    const c = cur();
    $('#t-start').textContent = fmtTime(c.start, true); $('#t-end').textContent = fmtTime(c.end, true);
    $('#export').textContent = 'Exporter le clip (' + Math.round(c.end - c.start) + ' s)';
    $('#export').disabled = !S.url;
  }

  async function maybeFraming() {
    const c = cur();
    if (!c || !S.url || c.style.frame !== 'auto' || c.style.track || S.framing) return;
    if (S.meta && S.meta.h / S.meta.w >= 1.5) return;
    const ac = new AbortController(); S.framing = ac; frameFields();
    try {
      const r = await R.analyzeFraming(S.url, c, (p) => { $('#frame-note').textContent = 'Recherche du visage… ' + Math.round(p * 100) + ' %'; }, ac.signal);
      if (r.track) { c.style.track = r.track; scheduleSave(); }
      else if (!r.detector) c.style._noDetector = true;
    } catch (e) { /* annulé */ }
    S.framing = null; S.dirty = true;
    if (cur() === c) frameFields();
  }

  function renderCapEdit() {
    const box = $('#capedit'); box.textContent = '';
    const c = cur();
    if (!S.groups.length) { box.appendChild(el('p', { class: 'note', text: 'Aucune parole détectée dans ce clip.' })); return; }
    S.groups.forEach((g, i) => {
      const orig = g.words.map((w) => w[0]).join(' ');
      const val = c.style.edits && c.style.edits[g.key] != null ? c.style.edits[g.key] : orig;
      const inp = el('input', { type: 'text', id: 'cap-' + i, value: val });
      inp.addEventListener('input', () => {
        c.style.edits = c.style.edits || {};
        if (inp.value.trim() === orig) delete c.style.edits[g.key]; else c.style.edits[g.key] = inp.value;
        S.dirty = true; scheduleSave();
      });
      inp.addEventListener('focus', () => { if (S.url && vid.paused) { try { vid.currentTime = g.start + 0.05; } catch (e) { /* */ } } });
      box.appendChild(el('label', {}, [el('span', { class: 'mono small muted', text: fmtTime(g.start) }), inp]));
    });
  }

  const bindText = (id, key) => $(id).addEventListener('input', (e) => { cur()[key] = e.target.value; S.dirty = true; scheduleSave(); });
  bindText('#in-title', 'title'); bindText('#in-context', 'context'); bindText('#in-hook', 'hook');
  $$('input[name=tpl]').forEach((r) => r.addEventListener('change', () => {
    const st = cur().style; st.template = r.value;
    st.captions = r.value !== 'citation';
    if (r.value !== 'citation' && st.titleSec > 8) st.titleSec = 3;
    if (r.value === 'citation' && st.titleSec < 8 && st.titleSec !== 0) st.titleSec = 14;
    $('#in-titlesec').value = String(st.titleSec); $('#in-caps').checked = st.captions;
    tplFields(); regroup(); scheduleSave();
  }));
  $('#in-titlesec').addEventListener('change', (e) => { cur().style.titleSec = Number(e.target.value); S.dirty = true; scheduleSave(); });
  $('#in-caps').addEventListener('change', (e) => { cur().style.captions = e.target.checked; S.dirty = true; scheduleSave(); });
  $('#in-capy').addEventListener('input', (e) => { cur().style.capY = e.target.value / 100; S.dirty = true; scheduleSave(); });
  $$('input[name=frame]').forEach((r) => r.addEventListener('change', () => { cur().style.frame = r.value; frameFields(); S.dirty = true; scheduleSave(); maybeFraming(); }));
  $('#in-manual').addEventListener('input', (e) => { cur().style.manualX = e.target.value / 100; S.dirty = true; scheduleSave(); });
  $$('[data-trim]').forEach((b) => b.addEventListener('click', () => {
    const c = cur(); if (!c || S.exporting) return;
    const [k, d] = b.dataset.trim.split(':'), v = Number(d), dur = S.project.duration;
    if (k === 'start') c.start = +clamp(c.start + v, 0, c.end - 3).toFixed(2); else c.end = +clamp(c.end + v, c.start + 3, dur).toFixed(2);
    c.style.track = null; // le cadrage sera recalculé sur la nouvelle durée
    updTrim(); regroup(); scheduleSave();
    if (S.url) { vid.pause(); try { vid.currentTime = k === 'start' ? c.start : Math.max(c.start, c.end - 2); } catch (e) { /* */ } }
    maybeFraming();
  }));
  $('#ed-back').addEventListener('click', () => { if (S.exporting) return; if (S.framing) S.framing.abort(); openClips(); });

  /* ---------------- Lecture ---------------- */
  let actx = null, mdest = null, audioTried = false;
  function ensureAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume().catch(() => {}); return; }
    if (audioTried) return; audioTried = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; const a = new AC();
      const src = a.createMediaElementSource(vid); src.connect(a.destination);
      if (a.createMediaStreamDestination) { mdest = a.createMediaStreamDestination(); src.connect(mdest); }
      actx = a;
    } catch (e) { actx = null; mdest = null; }
  }
  function updPlay() { $('#ic-play').hidden = S.playing; $('#ic-pause').hidden = !S.playing; $('#play').setAttribute('aria-label', S.playing ? 'Pause' : 'Lire'); }
  $('#play').addEventListener('click', () => {
    const c = cur(); if (!c || !S.url || S.exporting) return;
    ensureAudio();
    if (!vid.paused) { vid.pause(); return; }
    if (vid.currentTime < c.start - 0.05 || vid.currentTime >= c.end - 0.1) { try { vid.currentTime = c.start; } catch (e) { /* */ } }
    vid.play().catch(() => toast('La lecture a été bloquée. Touche encore Lire.', 'err'));
  });
  vid.addEventListener('play', () => { S.playing = true; updPlay(); });
  vid.addEventListener('pause', () => { S.playing = false; updPlay(); S.dirty = true; });
  vid.addEventListener('seeked', () => { S.dirty = true; });
  vid.addEventListener('loadeddata', () => { S.dirty = true; const c = cur(); if (c && S.view === 'editor' && vid.currentTime < c.start - 0.5) { try { vid.currentTime = c.start; } catch (e) { /* */ } } });
  let scrubbing = false;
  $('#scrub').addEventListener('input', (e) => { const c = cur(); if (!c || !S.url || S.exporting) return; scrubbing = true; try { vid.currentTime = c.start + e.target.value / 1000 * (c.end - c.start); } catch (err) { /* */ } });
  $('#scrub').addEventListener('change', () => { scrubbing = false; });

  let lastTc = '';
  function frame() {
    requestAnimationFrame(frame);
    if (S.view !== 'editor') return;
    const c = cur(); if (!c) return;
    const len = c.end - c.start;
    const t = S.url ? vid.currentTime : c.start;
    if (S.exporting && !S.exporting.done) { if (S.exporting.started && (t >= c.end - 0.01 || vid.ended)) finishRec(); }
    else if (S.playing && t >= c.end - 0.03) { vid.pause(); try { vid.currentTime = c.start; } catch (e) { /* */ } }
    const rel = clamp(t - c.start, 0, len);
    if (S.playing || S.dirty || S.exporting) {
      R.draw(ctx, S.url ? vid : null, S.url ? vid.videoWidth : 0, S.url ? vid.videoHeight : 0, c, S.groups, t, S.brand);
      S.dirty = false;
    }
    if (S.exporting && !S.exporting.done) { $('#exp-bar').style.width = (rel / len * 100).toFixed(1) + '%'; $('#exp-txt').textContent = 'Enregistrement… ' + fmtTime(rel) + ' / ' + fmtTime(len); }
    const tc = fmtTime(rel) + ' / ' + fmtTime(len);
    if (tc !== lastTc) { $('#tc').textContent = tc; lastTc = tc; if (!scrubbing) $('#scrub').value = Math.round(rel / len * 1000); }
  }
  requestAnimationFrame(frame);

  /* ---------------- Export ---------------- */
  let wake = null;
  function lockUi(on) {
    $('#exp-wrap').hidden = !on; $('#rec').hidden = !on; $('#export').disabled = on || !S.url;
    $$('[data-trim], #play, #scrub, #ed-back, input[name=tpl], input[name=frame]').forEach((n) => { n.disabled = on; });
  }
  async function doExport() {
    const c = cur(); if (!c || !S.url || S.exporting) return;
    if (!cv.captureStream || !window.MediaRecorder) { toast('Ce navigateur ne sait pas enregistrer de vidéo. Mets à jour Chrome ou Safari.', 'err'); return; }
    if (c.style.frame === 'auto' && !c.style.track && S.framing) { toast('Attends la fin de la recherche du visage.'); return; }
    ensureAudio();
    const mime = R.pickMime();
    vid.pause();
    const tracks = cv.captureStream(30).getVideoTracks();
    if (mdest) mdest.stream.getAudioTracks().forEach((t) => tracks.push(t));
    let rec;
    try { const o = { videoBitsPerSecond: 6e6, audioBitsPerSecond: 128000 }; if (mime) o.mimeType = mime; rec = new MediaRecorder(new MediaStream(tracks), o); }
    catch (e) { toast('L\'enregistrement n\'a pas pu démarrer sur ce navigateur.', 'err'); return; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    S.exporting = { rec, done: false, cancelled: false };
    lockUi(true); $('#result').hidden = true; $('#exp-bar').style.width = '0%';
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
    await new Promise((r) => { const d = () => { vid.removeEventListener('seeked', d); clearTimeout(to); r(); }; const to = setTimeout(d, 4000); vid.addEventListener('seeked', d); try { vid.currentTime = c.start; } catch (e) { d(); } });
    S.dirty = true;
    rec.start(500);
    try { await vid.play(); S.exporting.started = true; } catch (e) { S.exporting.cancelled = true; S.exporting.err = 'La lecture a été bloquée par le navigateur. Touche Lire une fois, puis relance l\'export.'; finishRec(); }
    await stopped;
    const ex = S.exporting; S.exporting = null; lockUi(false);
    try { if (wake) wake.release(); } catch (e) { /* */ } wake = null; S.dirty = true;
    if (ex.cancelled) { toast(ex.err || 'Export annulé.', ex.err ? 'err' : ''); return; }
    const type = ((rec.mimeType || mime || 'video/webm').split(';')[0]) || 'video/webm', ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    if (!blob.size) { toast('Le clip est vide : garde la page au premier plan pendant l\'export.', 'err'); return; }
    if (S.result && S.result.url) URL.revokeObjectURL(S.result.url);
    const base = (c.title || c.hook || 'clip').replace(/[«»"“”]/g, '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase() || 'clip';
    const name = base + '-' + (S.sel + 1) + '.' + ext;
    S.result = { blob, name, url: URL.createObjectURL(blob), type };
    $('#res-vid').src = S.result.url;
    $('#res-meta').textContent = name + ' · ' + (blob.size / 1048576).toFixed(1) + ' Mo · 720×1280';
    const dl = $('#dl'); dl.href = S.result.url; dl.download = name;
    let canShare = false;
    try { canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type })] })); } catch (e) { canShare = false; }
    $('#share').hidden = !canShare;
    $('#result').hidden = false;
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function finishRec() { const ex = S.exporting; if (!ex || ex.done) return; ex.done = true; vid.pause(); try { if (ex.rec.state !== 'inactive') ex.rec.stop(); } catch (e) { /* */ } }
  $('#export').addEventListener('click', doExport);
  $('#exp-cancel').addEventListener('click', () => { if (S.exporting) { S.exporting.cancelled = true; finishRec(); } });
  vid.addEventListener('ended', () => { if (S.exporting && S.exporting.started) finishRec(); });
  $('#share').addEventListener('click', async () => {
    if (!S.result) return;
    try { await navigator.share({ files: [new File([S.result.blob], S.result.name, { type: S.result.type })], title: cur().title || 'Clip' }); }
    catch (e) { if (e.name !== 'AbortError') toast('Partage impossible : utilise Télécharger.', 'err'); }
  });

  /* ---------------- Crédits ---------------- */
  async function openCredits() {
    const st = S.settings, packs = Array.isArray(st.packs) ? st.packs : [], pay = st.payment || {};
    const pb = $('#packs'); pb.textContent = '';
    packs.forEach((p) => pb.appendChild(el('div', { class: 'pack' }, [el('b', { text: String(p.credits) }), el('span', { class: 'muted small', text: 'crédits = ' + p.credits + ' min' }), el('span', { text: p.price })])));
    $('#pay-instr').textContent = pay.instructions || '';
    const rows = $('#pay-rows'); rows.textContent = '';
    [['Orange Money', pay.orange_money], ['Wave', pay.wave], ['WhatsApp', pay.whatsapp]].forEach(([k, v]) => {
      if (!v) return;
      const btn = el('button', { class: 'btn small', type: 'button', text: 'Copier' });
      btn.addEventListener('click', () => CM.copyText(v, btn));
      rows.appendChild(el('div', { class: 'copyrow' }, [el('div', {}, [el('span', { class: 'lbl', text: k }), el('br'), el('span', { text: v })]), btn]));
    });
    $('#pay-email').textContent = S.profile ? S.profile.email : '';
    const h = $('#hist'); h.textContent = '';
    try {
      const ev = await CM.db.creditHistory();
      const L = { bienvenue: 'Crédits offerts', analyse: 'Analyse', recharge: 'Recharge', remboursement: 'Remboursement', correction: 'Correction' };
      ev.forEach((x) => h.appendChild(el('li', {}, [
        el('span', { text: (L[x.reason] || x.reason) + (x.note ? ' · ' + x.note : '') + ' · ' + new Date(x.created_at).toLocaleDateString('fr-FR') }),
        el('span', { class: x.delta > 0 ? 'plus' : 'minus', text: (x.delta > 0 ? '+' : '') + x.delta })])));
      if (!ev.length) h.appendChild(el('li', { class: 'muted', text: 'Aucun mouvement.' }));
    } catch (e) { h.appendChild(el('li', { class: 'muted', text: errMsg(e) })); }
    try { const p = await CM.db.profile(); setCredits(p.credits); updateCost(); } catch (e) { /* */ }
    $('#dlg-credits').showModal();
  }
  $('#credits-btn').addEventListener('click', openCredits);
  $('#copy-email').addEventListener('click', (e) => CM.copyText($('#pay-email').textContent, e.currentTarget));
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  /* ---------------- Marque ---------------- */
  const brandKey = () => 'cm_brand_' + (S.session ? S.session.user.id : 'x');
  function loadBrand() {
    try { S.brand = JSON.parse(localStorage.getItem(brandKey())) || {}; } catch (e) { S.brand = {}; }
    S.brand = Object.assign({ highlight: '#FFE600', handle: '', progress: false, logo: '' }, S.brand);
  }
  function saveBrand() { try { localStorage.setItem(brandKey(), JSON.stringify(S.brand)); } catch (e) { toast('Logo trop lourd pour être gardé sur cet appareil.', 'err'); } S.dirty = true; }
  function renderBrand() {
    const p = $('#logo-prev'); p.textContent = '';
    if (S.brand.logo) p.appendChild(el('img', { src: S.brand.logo, alt: 'Ton logo' })); else p.appendChild(el('span', { class: 'muted small', text: 'Aucun logo' }));
    $('#brand-color').value = S.brand.highlight; $('#brand-handle').value = S.brand.handle; $('#brand-progress').checked = !!S.brand.progress;
  }
  $('#brand-open').addEventListener('click', () => { renderBrand(); $('#dlg-brand').showModal(); });
  $('#dlg-brand').addEventListener('close', () => { if (S.view === 'clips') drawThumbs(); });
  $('#logo-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      S.brand.logo = c.toDataURL('image/png'); URL.revokeObjectURL(img.src); saveBrand(); renderBrand();
    };
    img.onerror = () => toast('Cette image ne s\'ouvre pas.', 'err');
    img.src = URL.createObjectURL(f);
  });
  $('#logo-del').addEventListener('click', () => { S.brand.logo = ''; saveBrand(); renderBrand(); });
  $('#brand-color').addEventListener('input', (e) => { S.brand.highlight = e.target.value; saveBrand(); });
  $('#brand-handle').addEventListener('input', (e) => { S.brand.handle = e.target.value; saveBrand(); });
  $('#brand-progress').addEventListener('change', (e) => { S.brand.progress = e.target.checked; saveBrand(); });

  /* ---------------- Démarrage ---------------- */
  if (document.fonts && document.fonts.load) {
    Promise.all(['900 60px Montserrat', '800 40px Montserrat', '700 46px "Roboto Condensed"', '400 26px "Roboto Condensed"', '600 40px "Instrument Sans"']
      .map((f) => document.fonts.load(f).catch(() => {}))).then(() => { S.dirty = true; });
  }
  window.addEventListener('beforeunload', (e) => { if (S.analyzing || S.exporting) { e.preventDefault(); e.returnValue = ''; } });
  if (/type=recovery/.test(location.hash)) show('newpass');
  else boot();
  window.__cm = S; // aide au débogage
})();
