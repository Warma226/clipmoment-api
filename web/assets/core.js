/* ClipMoment — connexion à Supabase et à l'API, partagé par toutes les pages. */
(function () {
  'use strict';
  const C = window.CM_CONFIG || {};
  const DEMO = !C.SUPABASE_URL || !C.SUPABASE_ANON_KEY || !C.API_URL;

  const MESSAGES = {
    CREDITS_INSUFFISANTS: 'Tu n\'as pas assez de crédits pour cette vidéo. Recharge ton compte pour continuer.',
    VIDEO_TROP_LONGUE: 'Cette vidéo dépasse la durée maximale autorisée. Coupe-la en plusieurs parties.',
    DUREE_INVALIDE: 'La durée de la vidéo est illisible. Essaie un fichier MP4.',
    NON_CONNECTE: 'Ta session a expiré. Reconnecte-toi.',
    QUOTA_PROJET_DEPASSE: 'Ce projet a déjà utilisé tout son temps d\'analyse.',
    LIMITE_GROQ: 'Le service de transcription est très demandé en ce moment. Réessaie dans quelques minutes.',
    AUDIO_TROP_LOURD: 'Un morceau d\'audio est trop lourd pour le service de transcription.',
    ERREUR_TRANSCRIPTION: 'La transcription a échoué. Réessaie dans un instant.',
    ERREUR_IA: 'L\'IA n\'a pas pu choisir les moments. Les clips ont été choisis d\'après le son.',
    API_NON_CONFIGUREE: 'L\'API n\'est pas encore configurée (variables manquantes dans Cloudflare).',
    ERREUR_BASE: 'Erreur de la base de données. Réessaie dans un instant.',
    RESEAU: 'Connexion impossible. Vérifie ta connexion internet puis réessaie.',
  };

  function errMsg(e) {
    if (!e) return 'Erreur inconnue.';
    const code = e.code || e.message;
    if (MESSAGES[code]) return MESSAGES[code];
    if (/fetch|network|Failed to fetch|Load failed/i.test(String(e.message))) return MESSAGES.RESEAU;
    return String(e.message || e).replace(/^Error:\s*/, '');
  }

  /* ---------- Backend réel ---------- */
  function realBackend() {
    const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    const check = ({ data, error }) => { if (error) { const e = new Error(error.message); e.code = error.message; throw e; } return data; };
    async function token() {
      const { data } = await sb.auth.getSession();
      return data && data.session ? data.session.access_token : null;
    }
    return {
      auth: {
        async session() { const { data } = await sb.auth.getSession(); return data.session; },
        onChange(cb) { sb.auth.onAuthStateChange((ev, s) => cb(s, ev)); },
        async signIn(email, password) { return check(await sb.auth.signInWithPassword({ email, password })); },
        async signUp(email, password) {
          return check(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + '/app.html' } }));
        },
        async signOut() { await sb.auth.signOut(); },
        async reset(email) { return check(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/app.html' })); },
        async updatePassword(password) { return check(await sb.auth.updateUser({ password })); },
      },
      db: {
        async profile() {
          const s = await this._uid();
          return check(await sb.from('profiles').select('id,email,credits,is_admin').eq('id', s).single());
        },
        async _uid() { const { data } = await sb.auth.getSession(); return data.session && data.session.user.id; },
        async projects() {
          return check(await sb.from('projects').select('id,title,file_name,file_size,duration,status,created_at,clips')
            .in('status', ['pret', 'analyse']).order('created_at', { ascending: false }).limit(40));
        },
        async project(id) { return check(await sb.from('projects').select('*').eq('id', id).single()); },
        async updateProject(id, patch) {
          patch = Object.assign({}, patch, { updated_at: new Date().toISOString() });
          return check(await sb.from('projects').update(patch).eq('id', id));
        },
        async deleteProject(id) { return check(await sb.from('projects').delete().eq('id', id)); },
        async creditHistory() {
          return check(await sb.from('credit_events').select('delta,reason,note,created_at').order('created_at', { ascending: false }).limit(30));
        },
        async settings() {
          const rows = check(await sb.from('settings').select('key,value'));
          const o = {}; (rows || []).forEach((r) => { o[r.key] = r.value; }); return o;
        },
        async rpc(name, args) { return check(await sb.rpc(name, args || {})); },
      },
      async api(path, opts) {
        opts = opts || {};
        const t = await token();
        if (!t) { const e = new Error('NON_CONNECTE'); e.code = 'NON_CONNECTE'; throw e; }
        const headers = { Authorization: 'Bearer ' + t };
        let body;
        if (opts.form) body = opts.form;
        else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json || {}); }
        let res;
        try { res = await fetch(C.API_URL.replace(/\/$/, '') + path, { method: 'POST', headers, body, signal: opts.signal }); }
        catch (err) { if (err.name === 'AbortError') throw err; const e = new Error('RESEAU'); e.code = 'RESEAU'; throw e; }
        let data = null; try { data = await res.json(); } catch (e) { data = null; }
        if (!res.ok) {
          const e = new Error((data && data.error) || 'HTTP_' + res.status);
          e.code = e.message; e.status = res.status; e.detail = data && data.detail;
          e.retryAfter = Number(res.headers.get('Retry-After')) || 0;
          throw e;
        }
        return data;
      },
    };
  }

  const backend = DEMO ? window.CMMock.backend() : realBackend();

  async function loadSettings() {
    try { return await backend.db.settings(); } catch (e) { return {}; }
  }

  function fmtTime(t, dec) {
    t = Math.max(0, t || 0);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const ss = dec ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + ss;
  }

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (children || []).forEach((c) => { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  function toast(msg, kind) {
    let box = document.getElementById('toasts');
    if (!box) { box = el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.appendChild(box); }
    const t = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: msg });
    box.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 6000 : 3500);
  }

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); toast('Copié.'); }
    catch (e) {
      const r = document.createRange(); if (btn && btn.previousElementSibling) { r.selectNodeContents(btn.previousElementSibling); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      toast('Copie impossible : sélectionne le texte à la main.');
    }
  }

  window.CM = { config: C, DEMO, auth: backend.auth, db: backend.db, api: backend.api, errMsg, loadSettings, fmtTime, el, toast, copyText,
    brand: C.BRAND || 'ClipMoment' };
})();
