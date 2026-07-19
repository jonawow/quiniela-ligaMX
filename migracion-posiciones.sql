-- ═══════════════════════════════════════════════════════════════════════
--  MIGRACIÓN · Tabla de posiciones de la Liga MX
-- ═══════════════════════════════════════════════════════════════════════
--
--  QUÉ HACE
--    Crea la tabla `posiciones`, donde el cron va a guardar la tabla general
--    oficial de la Liga MX (la que trae de ESPN). La página solo la lee.
--
--  DESPUÉS DE CORRER ESTO
--    Hay que volver a desplegar la Edge Function `sync` (el cron), porque la
--    nueva versión es la que llena esta tabla. Sin ese redeploy, la tabla se
--    queda vacía y la sección sale con su mensaje de "cargando".
--
--  CÓMO CORRERLO
--    supabase.com → tu proyecto → SQL Editor → New query → pega esto → RUN.
--    Se puede correr las veces que quieras (IF NOT EXISTS / DROP POLICY IF EXISTS).
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists posiciones (
  torneo         text not null,          -- el mismo de config.torneo (ej. 'Apertura 2026')
  espn_team_id   text not null,          -- id estable del equipo en ESPN
  equipo         text not null,
  equipo_abbr    text,
  logo           text,
  posicion       int,
  jugados        int,
  ganados        int,
  empatados      int,
  perdidos       int,
  goles_favor    int,
  goles_contra   int,
  diferencia     int,
  puntos         int,
  actualizado_at timestamptz not null default now(),
  primary key (torneo, espn_team_id)
);

-- Lectura pública, escritura solo el cron (service_role, que se salta el RLS).
alter table posiciones enable row level security;

drop policy if exists lectura_publica on posiciones;
create policy lectura_publica on posiciones for select using (true);
