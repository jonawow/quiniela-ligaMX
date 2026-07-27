-- ═══════════════════════════════════════════════════════════════════════
-- QUINIELA MX · Depósitos antes de publicar la quiniela
-- ═══════════════════════════════════════════════════════════════════════
--
-- Corre este archivo DESPUÉS de schema-admin.sql en el SQL Editor de
-- Supabase. No borra pronósticos ni pagos existentes.
--
-- Flujo que instala:
--   jugador sube comprobante + picks → solicitud privada pendiente
--   admin revisa y publica           → se insertan los 9 pronósticos
--

do $$
begin
  if to_regprocedure('public.es_admin()') is null then
    raise exception 'Primero ejecuta schema-admin.sql: falta la función public.es_admin().';
  end if;
end
$$;


-- ── 1. Solicitudes privadas ────────────────────────────────────────────

create table if not exists public.solicitudes_quiniela (
  id                uuid primary key default gen_random_uuid(),
  jornada_id        bigint not null references public.jornadas(id) on delete cascade,
  nombre            text not null check (char_length(btrim(nombre)) between 2 and 40),
  slug              text not null check (char_length(slug) between 2 and 60),
  picks             jsonb not null,
  comprobante_path  text not null,
  estado            text not null default 'pendiente'
                    check (estado in ('pendiente', 'publicada')),
  creado_at         timestamptz not null default now(),
  revisado_at       timestamptz,
  revisado_por      uuid references auth.users(id)
);

-- Una persona solo puede tener una solicitud por jornada. Así no se mandan
-- varias capturas ni se publican dos quinielas con el mismo nombre.
create unique index if not exists solicitudes_quiniela_jornada_slug_key
  on public.solicitudes_quiniela (jornada_id, slug);

create index if not exists solicitudes_quiniela_pendientes_idx
  on public.solicitudes_quiniela (jornada_id, creado_at)
  where estado = 'pendiente';

alter table public.solicitudes_quiniela enable row level security;

drop policy if exists solicitudes_alta_publica on public.solicitudes_quiniela;
create policy solicitudes_alta_publica on public.solicitudes_quiniela
  for insert to anon, authenticated
  with check (
    estado = 'pendiente'
    and jsonb_typeof(picks) = 'array'
    and jsonb_array_length(picks) > 0
    and comprobante_path like ('pendientes/' || jornada_id::text || '/%')
  );

-- Nadie que juega puede leer las solicitudes ni los picks antes de tiempo.
drop policy if exists solicitudes_lectura_admin on public.solicitudes_quiniela;
create policy solicitudes_lectura_admin on public.solicitudes_quiniela
  for select to authenticated using (public.es_admin());


-- ── 2. Bucket privado para las capturas de depósito ─────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'comprobantes-pago',
  'comprobantes-pago',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists comprobantes_subida_publica on storage.objects;
create policy comprobantes_subida_publica on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'comprobantes-pago'
    and (storage.foldername(name))[1] = 'pendientes'
    and lower(storage.extension(name)) = any (array['jpg', 'jpeg', 'png', 'webp'])
  );

-- El bucket es privado: solo un admin autenticado puede abrir una captura.
drop policy if exists comprobantes_lectura_admin on storage.objects;
create policy comprobantes_lectura_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'comprobantes-pago' and public.es_admin());


-- ── 3. Publicar después de aprobar ─────────────────────────────────────
-- Esta función es la única puerta que convierte una solicitud en
-- pronósticos reales. Valida jornada, los 9 partidos y cada pick antes de
-- escribir; la aprobación no se puede falsear editando el HTML.

create or replace function public.aprobar_solicitud_quiniela(p_solicitud uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  solicitud       public.solicitudes_quiniela%rowtype;
  v_participante_id bigint;
  total_partidos  integer;
  total_picks     integer;
  picks_validos   integer;
begin
  if not public.es_admin() then
    raise exception 'No autorizado.' using errcode = '42501';
  end if;

  select * into solicitud
  from public.solicitudes_quiniela
  where id = p_solicitud
  for update;

  if not found then
    raise exception 'No existe esa solicitud.';
  end if;

  if solicitud.estado <> 'pendiente' then
    raise exception 'Esta solicitud ya fue publicada.';
  end if;

  if not exists (
    select 1
    from public.jornadas j
    where j.id = solicitud.jornada_id
      and j.estado = 'abierta'
      and (j.cierra_at is null or now() < j.cierra_at)
  ) then
    raise exception 'La jornada ya cerró; ya no se puede publicar esta quiniela.';
  end if;

  if jsonb_typeof(solicitud.picks) <> 'array' then
    raise exception 'Los picks de la solicitud no son válidos.';
  end if;

  select count(*) into total_partidos
  from public.partidos
  where jornada_id = solicitud.jornada_id;

  select count(*) into total_picks
  from jsonb_to_recordset(solicitud.picks) as r(partido_id bigint, pick text);

  select count(distinct r.partido_id) into picks_validos
  from jsonb_to_recordset(solicitud.picks) as r(partido_id bigint, pick text)
  join public.partidos p
    on p.id = r.partido_id
   and p.jornada_id = solicitud.jornada_id
  where r.pick in ('L', 'E', 'V');

  if total_partidos = 0
     or total_picks <> total_partidos
     or picks_validos <> total_partidos then
    raise exception 'La solicitud no contiene exactamente un pick válido por partido.';
  end if;

  select id into v_participante_id
  from public.participantes
  where slug = solicitud.slug;

  if v_participante_id is null then
    begin
      insert into public.participantes (nombre, slug)
      values (solicitud.nombre, solicitud.slug)
      returning id into v_participante_id;
    exception when unique_violation then
      select id into v_participante_id
      from public.participantes
      where slug = solicitud.slug;
    end;
  end if;

  if exists (
    select 1
    from public.pronosticos
    where jornada_id = solicitud.jornada_id
      and participante_id = v_participante_id
  ) then
    raise exception 'Esta persona ya tiene una quiniela publicada para la jornada.';
  end if;

  insert into public.pronosticos (jornada_id, partido_id, participante_id, pick)
  select solicitud.jornada_id, r.partido_id, v_participante_id, r.pick
  from jsonb_to_recordset(solicitud.picks) as r(partido_id bigint, pick text);

  insert into public.pagos (jornada_id, participante_id, pagado, marcado_at)
  values (solicitud.jornada_id, v_participante_id, true, now())
  on conflict (jornada_id, participante_id) do update set
    pagado = true,
    marcado_at = excluded.marcado_at;

  update public.solicitudes_quiniela
  set estado = 'publicada',
      revisado_at = now(),
      revisado_por = auth.uid()
  where id = solicitud.id;
end;
$$;

revoke all on function public.aprobar_solicitud_quiniela(uuid) from public, anon;
grant execute on function public.aprobar_solicitud_quiniela(uuid) to authenticated;


-- ── 4. Cerrar la puerta anterior ───────────────────────────────────────
-- Antes cualquier visitante insertaba pronósticos directamente. Desde este
-- momento solo la función de aprobación de arriba puede hacerlo.
drop policy if exists pronostico_solo_si_abierta on public.pronosticos;
