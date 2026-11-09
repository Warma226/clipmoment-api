-- ============================================================
-- ClipMoment — schéma Supabase
-- À coller en entier dans Supabase → SQL Editor → New query → Run.
-- Le script peut être relancé sans danger (il ne supprime aucune donnée).
-- ============================================================

-- ---------- Tables ----------

create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text,
  credits     integer not null default 0 check (credits >= 0),
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.credit_events (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  delta       integer not null,
  reason      text not null,          -- bienvenue | analyse | recharge | remboursement | correction
  note        text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists credit_events_user_idx on public.credit_events(user_id, created_at desc);

create table if not exists public.projects (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  title          text,
  file_name      text,
  file_size      bigint,
  duration       real,
  language       text,
  transcript     jsonb,
  clips          jsonb,
  status         text not null default 'analyse',   -- analyse | pret | annule | erreur
  paid_seconds   integer not null default 0,
  used_seconds   real not null default 0,
  moments_calls  integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists projects_user_idx on public.projects(user_id, created_at desc);

create table if not exists public.settings (
  key    text primary key,
  value  jsonb not null
);

insert into public.settings(key, value) values
  ('welcome_credits', '30'::jsonb),
  ('max_minutes', '30'::jsonb),
  ('packs', '[{"credits":60,"price":"1 000 F"},{"credits":300,"price":"4 000 F"},{"credits":900,"price":"10 000 F"}]'::jsonb),
  ('payment', '{"instructions":"Envoie le montant du pack par Orange Money ou Wave, puis envoie la capture et ton adresse e-mail sur WhatsApp. Tes crédits sont ajoutés sous 24 h.","orange_money":"+226 00 00 00 00","wave":"+226 00 00 00 00","whatsapp":"+226 00 00 00 00"}'::jsonb)
on conflict (key) do nothing;

-- ---------- Sécurité (RLS) ----------

alter table public.profiles      enable row level security;
alter table public.credit_events enable row level security;
alter table public.projects      enable row level security;
alter table public.settings      enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

drop policy if exists "profil: lecture" on public.profiles;
create policy "profil: lecture" on public.profiles
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists "credits: lecture" on public.credit_events;
create policy "credits: lecture" on public.credit_events
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists "projets: lecture" on public.projects;
create policy "projets: lecture" on public.projects
  for select using (user_id = auth.uid());
drop policy if exists "projets: modification" on public.projects;
create policy "projets: modification" on public.projects
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "projets: suppression" on public.projects;
create policy "projets: suppression" on public.projects
  for delete using (user_id = auth.uid());

drop policy if exists "reglages: lecture" on public.settings;
create policy "reglages: lecture" on public.settings for select using (true);

-- Les clients ne peuvent JAMAIS modifier leurs crédits ni créer un projet eux-mêmes :
-- tout passe par les fonctions ci-dessous (appelées par l'API ou par l'admin).
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.credit_events from anon, authenticated;
revoke insert, update on public.projects from anon, authenticated;
grant update (title, language, transcript, clips, status, updated_at) on public.projects to authenticated;
revoke insert, update, delete on public.settings from anon, authenticated;

-- ---------- Création automatique du profil à l'inscription ----------

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare w integer;
begin
  select coalesce((value)::text::integer, 0) into w from public.settings where key = 'welcome_credits';
  insert into public.profiles(id, email, credits) values (new.id, new.email, coalesce(w, 0))
    on conflict (id) do nothing;
  if coalesce(w, 0) > 0 then
    insert into public.credit_events(user_id, delta, reason) values (new.id, w, 'bienvenue');
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------- Fonctions appelées par l'API (clé service uniquement) ----------

-- Démarre une analyse : 1 crédit par minute de vidéo (arrondi au supérieur).
create or replace function public.start_analysis(p_user uuid, p_seconds integer, p_title text, p_file_name text, p_file_size bigint)
returns json language plpgsql security definer set search_path = public as $$
declare cost integer; maxm integer; bal integer; pid uuid;
begin
  if p_seconds is null or p_seconds <= 0 then raise exception 'DUREE_INVALIDE'; end if;
  select coalesce((value)::text::integer, 30) into maxm from public.settings where key = 'max_minutes';
  if p_seconds > coalesce(maxm, 30) * 60 + 5 then raise exception 'VIDEO_TROP_LONGUE'; end if;
  cost := ceil(p_seconds / 60.0);
  update public.profiles set credits = credits - cost where id = p_user and credits >= cost returning credits into bal;
  if bal is null then raise exception 'CREDITS_INSUFFISANTS'; end if;
  insert into public.projects(user_id, title, file_name, file_size, duration, paid_seconds)
    values (p_user, left(p_title, 200), left(p_file_name, 300), p_file_size, p_seconds, p_seconds)
    returning id into pid;
  insert into public.credit_events(user_id, delta, reason, note) values (p_user, -cost, 'analyse', left(p_file_name, 200));
  return json_build_object('project_id', pid, 'cost', cost, 'credits', bal);
end $$;

-- Vérifie qu'un morceau d'audio peut encore être transcrit pour ce projet (marge de 90 s).
create or replace function public.can_transcribe(p_user uuid, p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.projects
    where id = p_project and user_id = p_user and status = 'analyse' and used_seconds < paid_seconds + 90);
$$;

create or replace function public.add_used_seconds(p_project uuid, p_seconds real)
returns void language sql security definer set search_path = public as $$
  update public.projects set used_seconds = used_seconds + greatest(p_seconds, 0), updated_at = now() where id = p_project;
$$;

-- Autorise jusqu'à 40 appels à l'IA de sélection des moments par projet.
create or replace function public.use_moments_call(p_user uuid, p_project uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  update public.projects set moments_calls = moments_calls + 1, updated_at = now()
    where id = p_project and user_id = p_user and moments_calls < 40 and status in ('analyse', 'pret')
    returning true into ok;
  return coalesce(ok, false);
end $$;

-- Rembourse une analyse qui a échoué avant toute transcription.
create or replace function public.cancel_analysis(p_user uuid, p_project uuid)
returns json language plpgsql security definer set search_path = public as $$
declare pr public.projects; refund integer; bal integer;
begin
  select * into pr from public.projects where id = p_project and user_id = p_user and status = 'analyse' for update;
  if not found then return json_build_object('refunded', 0); end if;
  if pr.used_seconds > 0 then
    update public.projects set status = 'erreur', updated_at = now() where id = p_project;
    return json_build_object('refunded', 0);
  end if;
  refund := ceil(pr.paid_seconds / 60.0);
  update public.projects set status = 'annule', updated_at = now() where id = p_project;
  update public.profiles set credits = credits + refund where id = p_user returning credits into bal;
  insert into public.credit_events(user_id, delta, reason, note) values (p_user, refund, 'remboursement', 'Analyse annulée');
  return json_build_object('refunded', refund, 'credits', bal);
end $$;

revoke execute on function public.start_analysis(uuid, integer, text, text, bigint) from public, anon, authenticated;
revoke execute on function public.can_transcribe(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.add_used_seconds(uuid, real) from public, anon, authenticated;
revoke execute on function public.use_moments_call(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cancel_analysis(uuid, uuid) from public, anon, authenticated;
grant execute on function public.start_analysis(uuid, integer, text, text, bigint) to service_role;
grant execute on function public.can_transcribe(uuid, uuid) to service_role;
grant execute on function public.add_used_seconds(uuid, real) to service_role;
grant execute on function public.use_moments_call(uuid, uuid) to service_role;
grant execute on function public.cancel_analysis(uuid, uuid) to service_role;

-- ---------- Fonctions de la page admin ----------

create or replace function public.admin_add_credits(p_email text, p_amount integer, p_note text)
returns json language plpgsql security definer set search_path = public as $$
declare uid uuid; bal integer;
begin
  if not public.is_admin() then raise exception 'ACCES_REFUSE'; end if;
  if p_amount = 0 then raise exception 'MONTANT_NUL'; end if;
  select id into uid from public.profiles where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'CLIENT_INTROUVABLE'; end if;
  update public.profiles set credits = greatest(credits + p_amount, 0) where id = uid returning credits into bal;
  insert into public.credit_events(user_id, delta, reason, note, created_by)
    values (uid, p_amount, case when p_amount > 0 then 'recharge' else 'correction' end, left(p_note, 300), auth.uid());
  return json_build_object('email', p_email, 'credits', bal);
end $$;

create or replace function public.admin_list_users(p_search text default '')
returns table(id uuid, email text, credits integer, is_admin boolean, created_at timestamptz, projects bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'ACCES_REFUSE'; end if;
  return query
    select p.id, p.email, p.credits, p.is_admin, p.created_at,
           (select count(*) from public.projects j where j.user_id = p.id)
    from public.profiles p
    where coalesce(p_search, '') = '' or p.email ilike '%' || p_search || '%'
    order by p.created_at desc limit 100;
end $$;

create or replace function public.admin_recent_events(p_limit integer default 50)
returns table(created_at timestamptz, email text, delta integer, reason text, note text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'ACCES_REFUSE'; end if;
  return query
    select e.created_at, p.email, e.delta, e.reason, e.note
    from public.credit_events e join public.profiles p on p.id = e.user_id
    order by e.created_at desc limit least(p_limit, 200);
end $$;

create or replace function public.admin_stats()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'ACCES_REFUSE'; end if;
  return json_build_object(
    'clients', (select count(*) from public.profiles),
    'analyses', (select count(*) from public.projects where status in ('analyse', 'pret')),
    'minutes', (select coalesce(round(sum(used_seconds) / 60.0), 0) from public.projects),
    'credits_vendus', (select coalesce(sum(delta), 0) from public.credit_events where reason = 'recharge'));
end $$;

create or replace function public.admin_set_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'ACCES_REFUSE'; end if;
  if p_key not in ('welcome_credits', 'max_minutes', 'packs', 'payment') then raise exception 'REGLAGE_INCONNU'; end if;
  insert into public.settings(key, value) values (p_key, p_value)
    on conflict (key) do update set value = excluded.value;
end $$;

revoke execute on function public.admin_add_credits(text, integer, text) from public, anon;
revoke execute on function public.admin_list_users(text) from public, anon;
revoke execute on function public.admin_recent_events(integer) from public, anon;
revoke execute on function public.admin_stats() from public, anon;
revoke execute on function public.admin_set_setting(text, jsonb) from public, anon;
grant execute on function public.admin_add_credits(text, integer, text) to authenticated;
grant execute on function public.admin_list_users(text) to authenticated;
grant execute on function public.admin_recent_events(integer) to authenticated;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.admin_set_setting(text, jsonb) to authenticated;

-- ============================================================
-- APRÈS ta propre inscription sur le site, rends-toi admin :
--   update public.profiles set is_admin = true where email = 'ton@email.com';
-- ============================================================
