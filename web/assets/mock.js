/* ClipMoment — MODE DÉMO : faux comptes, fausse transcription, données gardées dans ce navigateur.
   Utilisé automatiquement tant que config.js n'est pas rempli. */
(function () {
  'use strict';
  const KEY = 'cm_demo_v1';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.users) return s; } catch (e) {}
    return { users: {}, session: null, projects: [], events: [], settings: {
      welcome_credits: 30, max_minutes: 30,
      packs: [{ credits: 60, price: '1 000 F' }, { credits: 300, price: '4 000 F' }, { credits: 900, price: '10 000 F' }],
      payment: { instructions: 'Envoie le montant du pack par Orange Money ou Wave, puis envoie la capture et ton adresse e-mail sur WhatsApp. Tes crédits sont ajoutés sous 24 h.',
        orange_money: '+226 00 00 00 00', wave: '+226 00 00 00 00', whatsapp: '+226 00 00 00 00' } } };
  }
  let S = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* quota : on garde en mémoire */ } }
  const listeners = [];
  function fail(code, status) { const e = new Error(code); e.code = code; e.status = status || 400; throw e; }
  function me() { if (!S.session) fail('NON_CONNECTE', 401); return S.users[S.session]; }

  const PHRASES = [
    'Franchement je vais être très clair avec vous ce soir.', 'Personne ne parle de ça mais c\'est le vrai problème.',
    'Quand tu commences tu fais tous la même erreur.', 'Moi j\'ai vu des gens tout perdre à cause de ça.',
    'La discipline bat le talent à chaque fois.', 'Écoute bien ce que je vais te dire maintenant.',
    'Le secret c\'est la régularité pas l\'intensité.', 'Ils nous ont menti pendant des années sur ce sujet.',
    'Tu veux des résultats alors arrête de chercher des excuses.', 'Voilà exactement ce que j\'aurais aimé savoir à vingt ans.',
    'Et là tout le monde s\'est mis à rire dans la salle.', 'C\'est une honte et je le dis haut et fort.',
    'Trois minutes par jour suffisent pour changer ta vie.', 'Le plus dur ce n\'est pas de commencer c\'est de continuer.',
    'On m\'a dit que c\'était impossible et pourtant je l\'ai fait.', 'Regarde bien la suite parce que personne ne s\'y attend.',
  ];

  function fakeTranscript(duration, offsetSeed) {
    const words = [], segments = [];
    let t = 0.4, i = offsetSeed || 0;
    while (t < duration - 1.5) {
      const p = PHRASES[i % PHRASES.length].split(' ');
      const s0 = t;
      for (const w of p) {
        const d = 0.22 + (w.length * 0.035);
        if (t + d > duration) break;
        words.push([w, Math.round(t * 100) / 100, Math.round((t + d) * 100) / 100]);
        t += d + 0.05;
      }
      segments.push([Math.round(s0 * 100) / 100, Math.round(t * 100) / 100, p.join(' ')]);
      t += 0.45 + ((i * 7) % 5) * 0.12; i++;
    }
    return { words, segments };
  }

  const backend = {
    auth: {
      async session() { return S.session ? { user: { id: S.session, email: S.users[S.session].email } } : null; },
      onChange(cb) { listeners.push(cb); },
      async signIn(email, password) {
        await wait(250);
        const u = Object.values(S.users).find((x) => x.email === email.toLowerCase());
        if (!u || u.password !== password) fail('Invalid login credentials');
        S.session = u.id; save(); listeners.forEach((f) => f({ user: { id: u.id, email: u.email } })); return {};
      },
      async signUp(email, password) {
        await wait(250);
        email = email.toLowerCase();
        if (Object.values(S.users).some((x) => x.email === email)) fail('User already registered');
        if (password.length < 6) fail('Password should be at least 6 characters');
        const id = uuid(), first = !Object.keys(S.users).length, w = Number(S.settings.welcome_credits) || 0;
        S.users[id] = { id, email, password, credits: w, is_admin: first, created_at: new Date().toISOString() };
        if (w) S.events.push({ user_id: id, delta: w, reason: 'bienvenue', note: null, created_at: new Date().toISOString() });
        S.session = id; save(); listeners.forEach((f) => f({ user: { id, email } }));
        return { session: { user: { id, email } } };
      },
      async signOut() { S.session = null; save(); listeners.forEach((f) => f(null)); },
      async reset() { await wait(200); return {}; },
      async updatePassword(p) { me().password = p; save(); return {}; },
    },
    db: {
      async profile() { const u = me(); return { id: u.id, email: u.email, credits: u.credits, is_admin: u.is_admin }; },
      async projects() {
        const u = me();
        return S.projects.filter((p) => p.user_id === u.id && (p.status === 'pret' || p.status === 'analyse'))
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((p) => ({ id: p.id, title: p.title, file_name: p.file_name, file_size: p.file_size, duration: p.duration, status: p.status, created_at: p.created_at, clips: p.clips }));
      },
      async project(id) { const u = me(); const p = S.projects.find((x) => x.id === id && x.user_id === u.id); if (!p) fail('Projet introuvable'); return JSON.parse(JSON.stringify(p)); },
      async updateProject(id, patch) {
        const u = me(); const p = S.projects.find((x) => x.id === id && x.user_id === u.id); if (!p) fail('Projet introuvable');
        ['title', 'language', 'transcript', 'clips', 'status'].forEach((k) => { if (k in patch) p[k] = patch[k]; });
        p.updated_at = new Date().toISOString(); save(); return null;
      },
      async deleteProject(id) { const u = me(); S.projects = S.projects.filter((x) => !(x.id === id && x.user_id === u.id)); save(); return null; },
      async creditHistory() {
        const u = me(); return S.events.filter((e) => e.user_id === u.id).slice().reverse().slice(0, 30);
      },
      async settings() { return JSON.parse(JSON.stringify(S.settings)); },
      async rpc(name, a) {
        const u = me();
        if (!u.is_admin) fail('ACCES_REFUSE');
        a = a || {};
        if (name === 'admin_add_credits') {
          const t = Object.values(S.users).find((x) => x.email === String(a.p_email).trim().toLowerCase());
          if (!t) fail('CLIENT_INTROUVABLE');
          t.credits = Math.max(0, t.credits + Number(a.p_amount));
          S.events.push({ user_id: t.id, delta: Number(a.p_amount), reason: a.p_amount > 0 ? 'recharge' : 'correction', note: a.p_note, created_at: new Date().toISOString() });
          save(); return { email: t.email, credits: t.credits };
        }
        if (name === 'admin_list_users') {
          return Object.values(S.users).filter((x) => !a.p_search || x.email.includes(a.p_search.toLowerCase()))
            .map((x) => ({ id: x.id, email: x.email, credits: x.credits, is_admin: x.is_admin, created_at: x.created_at,
              projects: S.projects.filter((p) => p.user_id === x.id).length }));
        }
        if (name === 'admin_recent_events') {
          return S.events.slice().reverse().slice(0, a.p_limit || 50).map((e) => ({ created_at: e.created_at, email: (S.users[e.user_id] || {}).email, delta: e.delta, reason: e.reason, note: e.note }));
        }
        if (name === 'admin_stats') {
          return { clients: Object.keys(S.users).length, analyses: S.projects.length,
            minutes: Math.round(S.projects.reduce((s, p) => s + (p.used_seconds || 0), 0) / 60),
            credits_vendus: S.events.filter((e) => e.reason === 'recharge').reduce((s, e) => s + e.delta, 0) };
        }
        if (name === 'admin_set_setting') { S.settings[a.p_key] = a.p_value; save(); return null; }
        fail('Fonction inconnue');
      },
    },
    async api(path, opts) {
      opts = opts || {};
      const u = me();
      await wait(300);
      if (path === '/analyze/start') {
        const sec = Math.ceil(opts.json.seconds), cost = Math.ceil(sec / 60);
        if (sec > (Number(S.settings.max_minutes) || 30) * 60 + 5) fail('VIDEO_TROP_LONGUE', 402);
        if (u.credits < cost) fail('CREDITS_INSUFFISANTS', 402);
        u.credits -= cost;
        const p = { id: uuid(), user_id: u.id, title: opts.json.title, file_name: opts.json.file_name, file_size: opts.json.file_size,
          duration: sec, status: 'analyse', paid_seconds: sec, used_seconds: 0, transcript: null, clips: null, created_at: new Date().toISOString() };
        S.projects.push(p);
        S.events.push({ user_id: u.id, delta: -cost, reason: 'analyse', note: opts.json.file_name, created_at: p.created_at });
        save(); return { project_id: p.id, cost, credits: u.credits };
      }
      if (path === '/analyze/cancel') {
        const p = S.projects.find((x) => x.id === opts.json.project_id);
        if (!p || p.used_seconds > 0) return { refunded: 0 };
        const r = Math.ceil(p.paid_seconds / 60); u.credits += r; p.status = 'annule';
        S.events.push({ user_id: u.id, delta: r, reason: 'remboursement', note: 'Analyse annulée', created_at: new Date().toISOString() });
        save(); return { refunded: r, credits: u.credits };
      }
      if (path.startsWith('/transcribe')) {
        const pid = new URLSearchParams(path.split('?')[1]).get('project');
        const p = S.projects.find((x) => x.id === pid);
        const file = opts.form.get('file');
        const duration = Math.max(0, (file.size - 44) / 32000);
        await wait(600);
        if (p) { p.used_seconds += duration; save(); }
        const tr = fakeTranscript(duration, Math.floor(duration) % 7);
        return { language: 'french', duration, words: tr.words, segments: tr.segments };
      }
      if (path === '/moments') {
        const j = opts.json, segs = j.segments, out = [];
        let i = 0;
        while (i < segs.length && out.length < j.count) {
          const s = segs[i][0]; let k = i;
          while (k < segs.length - 1 && segs[k][1] - s < (j.min + j.max) / 2) k++;
          const e = segs[k][1];
          if (e - s >= j.min * 0.8) {
            const words = segs[i][2].split(' ');
            const key = words.reduce((a, b) => (b.length > a.length ? b : a), '');
            out.push({ start: s, end: e, title: '« ' + segs[i][2].replace(key, key.toUpperCase()) + ' »',
              context: 'Extrait de la vidéo (mode démo)', hook: words.slice(0, 4).join(' ').toUpperCase(),
              score: 92 - out.length * 9 - (i % 4), reason: 'Phrase d\'accroche forte et idée complète (exemple du mode démo).' });
          }
          i = k + 2;
        }
        return { clips: out, model: 'démo' };
      }
      fail('INTROUVABLE', 404);
    },
  };

  window.CMMock = { backend: () => backend };
})();
