-- ═══════════════════════════════════════════════════════════════════════
--  QUINIELA MX · Panel de administración
-- ═══════════════════════════════════════════════════════════════════════
--
--  CÓMO INSTALARLO
--    SQL Editor → New query → pega TODO esto → RUN.
--    Se puede correr las veces que quieras, no rompe nada.
--
--  QUÉ HACE
--    1. Agrega la columna `tv` a los partidos (dónde se transmite).
--    2. Crea la lista de administradores (por ahora: tú).
--    3. Le da permiso de ESCRIBIR únicamente a esos correos.
--
--  ── LA IDEA, Y POR QUÉ ESTO SÍ ES SEGURO ──────────────────────────────
--
--  El panel vive dentro de la misma página pública, y usa la MISMA llave
--  anon que todos. No carga la service_role en el navegador — eso es lo
--  que antes hacía imposible tener un panel: esa llave se salta todas las
--  reglas, y cualquiera que abriera el código fuente podría borrar todo.
--
--  Aquí el candado no es la llave: es tu CORREO. Entras con un link mágico
--  que Supabase te manda; a partir de ahí tu sesión trae tu correo firmado
--  y las reglas de abajo comparan contra la lista de admins. Si alguien más
--  abre #admin, la página no le muestra nada — y aunque se brincara eso, la
--  base le rechaza cada escritura. El candado está aquí, no en el HTML.
-- ═══════════════════════════════════════════════════════════════════════


-- ── 1. Dónde ver cada partido ──────────────────────────────────────────
-- ESPN no da los canales de Liga MX (sus campos de transmisión vienen
-- vacíos), y en ligamx.net son logos, no texto. Así que esto lo capturas
-- tú desde el panel: 9 datos por jornada. Siempre correcto, porque lo
-- pusiste tú y no lo adivinó un scraper.

alter table partidos add column if not exists tv text;

comment on column partidos.tv is
  'Canales donde se transmite, separados por coma. Ej: "Canal 5, TUDN". '
  'Se llena desde el panel de admin. Si está vacío, la página no muestra nada.';


-- ── 2. Quién manda ─────────────────────────────────────────────────────

create table if not exists admins (
  email     text primary key,
  nota      text,
  creado_at timestamptz not null default now()
);

alter table admins enable row level security;
-- Sin políticas de lectura a propósito: nadie ve esta lista desde el
-- navegador. La única que la consulta es la función es_admin() de abajo.

-- ⚠️  Si YA corriste este archivo antes, tu correo ya está en la base y NO
--     necesitas volver a correrlo. Esto quedó como plantilla, sin tu correo
--     escrito, porque el repo es público y hay bots que barren GitHub
--     cosechando direcciones para llenarte de spam.
--
--     Si algún día lo vuelves a correr (o quieres sumar otro admin), pon el
--     correo aquí abajo entre las comillas. Si lo dejas así, truena a
--     propósito en vez de meter basura a la tabla.

do $$
declare
  mi_correo text := 'PON_AQUI_TU_CORREO';
begin
  if mi_correo like 'PON_AQUI%' or position('@' in mi_correo) = 0 then
    raise exception E'\n\n  ⚠  Falta poner tu correo en la línea "mi_correo".\n'
      '     (Si ya lo habías corrido antes, tu correo ya está guardado\n'
      '      y puedes ignorar este archivo por completo.)\n';
  end if;

  insert into admins (email, nota)
  values (lower(trim(mi_correo)), 'Dueño de la quiniela')
  on conflict (email) do nothing;
end
$$;


-- ── 3. La pregunta clave: ¿quien está pidiendo esto es admin? ──────────
-- `security definer` aquí es a propósito y es seguro: la función necesita
-- leer la tabla `admins`, que está cerrada a todos. No recibe parámetros ni
-- devuelve datos — solo responde sí o no sobre QUIEN LLAMA, así que no hay
-- nada que un atacante pueda pedirle. El `search_path` fijo evita que
-- alguien la engañe apuntándola a otra tabla.

create or replace function public.es_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from admins a
    where a.email = lower(nullif(current_setting('request.jwt.claims', true)::json ->> 'email', ''))
  );
$$;

grant execute on function public.es_admin() to anon, authenticated;


-- ── 4. Los permisos del admin ──────────────────────────────────────────
-- Todo lo que sigue es SOLO para los correos de la tabla admins. Para
-- cualquier otra persona estas puertas ni existen.

-- Corregir un marcador que ESPN sacó mal, y poner la TV.
drop policy if exists admin_toca_partidos on partidos;
create policy admin_toca_partidos on partidos
  for update using (es_admin()) with check (es_admin());

-- Marcar quién pagó.
drop policy if exists admin_toca_pagos on pagos;
create policy admin_toca_pagos on pagos
  for all using (es_admin()) with check (es_admin());

-- Abrir/cerrar una jornada a mano si algo se atora.
drop policy if exists admin_toca_jornadas on jornadas;
create policy admin_toca_jornadas on jornadas
  for update using (es_admin()) with check (es_admin());

-- Cambiar la cuota o la comisión sin tocar código.
drop policy if exists admin_toca_config on config;
create policy admin_toca_config on config
  for update using (es_admin()) with check (es_admin());

-- Borrar a alguien (una prueba, un duplicado). Sus pronósticos se van
-- solos detrás: la base los tiene amarrados con "on delete cascade".
drop policy if exists admin_borra_participantes on participantes;
create policy admin_borra_participantes on participantes
  for delete using (es_admin());

-- OJO: los jugadores normales SIGUEN sin poder editar ni borrar nada.
-- Sus pronósticos son inmutables igual que siempre. Lo único que cambia es
-- que ahora existe una puerta más, y solo abre con tu correo.


-- ═══════════════════════════════════════════════════════════════════════
--  FALTA UN PASO FUERA DE AQUÍ (si no, el link mágico no te va a llegar):
--
--    Authentication → URL Configuration
--      · Site URL          → https://jonawow.github.io/quiniela-ligaMX/
--      · Redirect URLs     → agrega esa misma liga
--
--  Sin eso, Supabase manda el correo pero el link te rebota.
-- ═══════════════════════════════════════════════════════════════════════
