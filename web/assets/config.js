// ============================================================
// Réglages du site ClipMoment — à remplir une seule fois.
// Tant que SUPABASE_URL est vide, le site tourne en MODE DÉMO :
// tout fonctionne avec une fausse transcription et rien n'est enregistré en ligne.
// ============================================================
window.CM_CONFIG = {
  // Supabase → Project Settings → API (ou "Data API")
  SUPABASE_URL: 'https://kxkogpqtixqatufmxigv.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt4a29ncHF0aXhxYXR1Zm14aWd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyMjMzMjcsImV4cCI6MjEwOTc5OTMyN30.b4Os2jRryrysg9qHGX6Mj-qZOsAt1hCwUaYDOPJpYL0', // clé "anon" (publique, sans danger)

  // Adresse de ton Worker Cloudflare, ex. https://clipmoment-api.tonnom.workers.dev
  API_URL: '',

  // Nom affiché partout sur le site
  BRAND: 'ClipMoment',

  // Modèle de transcription Groq (whisper-large-v3-turbo = rapide, whisper-large-v3 = un peu plus précis)
  STT_MODEL: 'whisper-large-v3-turbo',
};
