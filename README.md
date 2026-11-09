# ClipMoment

Plateforme qui transforme des vidéos longues (interviews, podcasts, lives, cours) en **clips verticaux 9:16** prêts pour TikTok, Reels et Shorts, à la manière d'OpusClip.

- **Transcription mot par mot** (Whisper via Groq).
- **L'IA choisit les moments viraux**, écrit un titre-citation et donne une note sur 100.
- **3 gabarits** : *Citation* (bandes blanches façon chaîne TV), *Sous-titres animés* (mot par mot), *Sobre*.
- **Cadrage vertical qui suit le visage**, ou fond flou, ou réglage manuel.
- **Ta marque** : logo, couleur, signature.
- **Comptes clients, crédits** (1 crédit = 1 minute analysée) et **page admin** pour créditer après un paiement Orange Money ou Wave.

**Coût de départ : 0 F.** Tout tourne sur des offres gratuites, sans carte bancaire. Le montage et l'export vidéo se font dans le téléphone du client, donc il n'y a aucun serveur vidéo à payer.

```
Téléphone du client (site web)        Cloudflare Worker (API)           Services
  ├─ lit l'audio, le découpe     ───►   vérifie la session    ───►   Groq : Whisper + IA
  ├─ monte et exporte le clip           débite les crédits    ───►   Supabase : comptes, crédits, projets
  └─ comptes, projets  ───────────────────────────────────────────►   Supabase
```

---

## Essayer tout de suite (mode démo)

Tant que `web/assets/config.js` est vide, le site tourne en **mode démo** : la transcription est simulée et tout reste dans le navigateur. Le premier compte créé en démo est administrateur.

---

## Mise en ligne depuis un téléphone (≈ 30 min)

Tu vas créer 3 comptes gratuits : **Supabase**, **Groq** et **Cloudflare**. Les noms exacts des menus peuvent changer un peu avec le temps.

### Étape 1 — Supabase (comptes et crédits)

1. Va sur [supabase.com](https://supabase.com), clique **Start your project** et connecte-toi avec GitHub.
2. **New project** : nom `clipmoment`, choisis un mot de passe de base de données (garde-le), région la plus proche (ex. *West EU (Paris)*).
3. Menu **SQL Editor** → **New query**. Ouvre [`supabase/schema.sql`](supabase/schema.sql) sur GitHub, bouton **Raw**, copie tout, colle dans Supabase, puis **Run**. Tu dois voir *Success*.
4. Menu **Authentication** → **Sign In / Providers** → **Email** : désactive **Confirm email** pour commencer. L'envoi d'e-mails gratuit de Supabase est limité à quelques messages par heure.
5. Menu **Project Settings** → **API Keys** (ou **API**), note :
   - l'**URL du projet** (`https://xxxx.supabase.co`, aussi dans **Data API**) ;
   - la clé **anon** ou **publishable** (publique) ;
   - la clé **service_role** ou **secret** (⚠️ secrète, ne la mets **jamais** dans le site).

### Étape 2 — Groq (transcription + IA)

1. Va sur [console.groq.com](https://console.groq.com) et crée un compte.
2. **API Keys** → **Create API Key** → copie la clé (`gsk_…`).

### Étape 3 — Cloudflare Worker (l'API)

1. Va sur [dash.cloudflare.com](https://dash.cloudflare.com) et crée un compte.
2. **Workers & Pages** (ou **Compute**) → **Create** → **Create Worker** → nom `clipmoment-api` → **Deploy**.
3. **Edit code** : efface tout, colle le contenu de [`worker/worker.js`](worker/worker.js) (bouton **Raw** sur GitHub), puis **Deploy**.
4. Onglet **Settings** → **Variables and Secrets** → ajoute :

| Nom | Valeur | Type |
|---|---|---|
| `SUPABASE_URL` | URL du projet Supabase | Text |
| `SUPABASE_ANON_KEY` | clé anon / publishable | Text |
| `SUPABASE_SERVICE_KEY` | clé service_role / secret | **Secret** |
| `GROQ_API_KEY` | clé Groq | **Secret** |
| `ALLOWED_ORIGINS` | adresse du site (étape 5), ex. `https://clipmoment.pages.dev` | Text |

5. Note l'adresse du Worker, ex. `https://clipmoment-api.tonnom.workers.dev`. En ouvrant `…/health`, tu dois voir `"configured":true`.

### Étape 4 — Relier le site

Sur GitHub, ouvre `web/assets/config.js`, touche le crayon ✏️, remplis :

```js
SUPABASE_URL: 'https://xxxx.supabase.co',
SUPABASE_ANON_KEY: 'ta clé anon / publishable',
API_URL: 'https://clipmoment-api.tonnom.workers.dev',
```

puis **Commit changes**.

### Étape 5 — Cloudflare Pages (le site)

1. **Workers & Pages** → **Create** → onglet **Pages** → **Connect to Git** → autorise GitHub → choisis `Warma226/ClipMoment`.
2. Réglages de build : *Framework preset* **None**, *Build command* **vide**, *Build output directory* **`web`** → **Save and Deploy**.
3. Ton site est en ligne, ex. `https://clipmoment.pages.dev`. Chaque modification sur GitHub le met à jour tout seul.
4. Reporte cette adresse dans la variable `ALLOWED_ORIGINS` du Worker, et dans Supabase → **Authentication** → **URL Configuration** → **Site URL**.

### Étape 6 — Devenir administrateur

1. Crée ton compte sur ton site (`/app.html`).
2. Supabase → **SQL Editor** :
   ```sql
   update public.profiles set is_admin = true where email = 'ton@email.com';
   ```
3. Ouvre `/admin.html` : tu peux créditer les clients, changer les packs, les prix et tes numéros Orange Money / Wave.

---

## Vendre

- Le client crée un compte : il reçoit des crédits offerts (30 par défaut, réglable).
- Pour recharger, il voit tes packs, tes numéros et ses instructions (bouton **Crédits**).
- Il paie, t'envoie la capture sur WhatsApp, tu ajoutes ses crédits dans `/admin.html` (boutons rapides par pack).
- **1 crédit = 1 minute de vidéo analysée.** Retouches et exports illimités. Les crédits sont remboursés automatiquement si l'analyse échoue avant la transcription.

## Limites de la version 1

| Limite | Pourquoi | Prévu |
|---|---|---|
| Import de fichier seulement, pas de lien YouTube | YouTube bloque les téléchargements depuis les serveurs | v2 |
| 30 min max par analyse (réglable jusqu'à 120) | Le décodage audio se fait dans le téléphone, qui a peu de mémoire | v2 : lecture en flux |
| Export en temps réel | L'enregistrement se fait pendant la lecture | v2 : export accéléré (WebCodecs) |
| Quota Groq gratuit (quelques heures d'audio par jour) | Offre gratuite | Passer au plan payant Groq quand les ventes suivent |
| Paiement validé à la main | Pas d'agrégateur au départ | v2 : CinetPay / LigdiCash / PayDunya (commission par paiement, sans abonnement) |
| Suivi du visage selon le navigateur | Chrome Android a un détecteur intégré ; sinon le modèle MediaPipe est chargé ; sinon cadrage manuel | — |
| Supabase gratuit se met en pause après 7 jours sans visite | Règle de l'offre gratuite | Un client actif suffit à l'éviter |

## Structure

```
supabase/schema.sql   base de données, sécurité, crédits, fonctions admin
worker/worker.js      API (Cloudflare Worker, un seul fichier)
web/                  site statique (Cloudflare Pages)
  index.html          page de vente
  app.html            studio : import, analyse, clips, éditeur, export
  admin.html          administration
  assets/config.js    tes réglages (à remplir)
  assets/engine.js    audio, transcription par morceaux, choix des moments
  assets/render.js    rendu 9:16, gabarits, sous-titres, suivi du visage
tests/worker.test.mjs tests de l'API (node tests/worker.test.mjs)
```

## Dépannage

- **« L'API n'est pas encore configurée »** : une variable manque dans le Worker (étape 3.4).
- **Erreur réseau / CORS** : `ALLOWED_ORIGINS` doit être exactement l'adresse du site, sans `/` à la fin.
- **« Le service de transcription est très demandé »** : quota Groq atteint, le site réessaie tout seul ; sinon attends quelques minutes.
- **Le clip exporté est en WebM** : certains navigateurs n'enregistrent pas en MP4. Chrome récent sur Android et Safari sur iPhone produisent du MP4.
