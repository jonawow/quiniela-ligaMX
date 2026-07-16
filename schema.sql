-- ═══════════════════════════════════════════════════════════════════════
--  QUINIELA MX · Esquema de base de datos (Supabase / Postgres)
-- ═══════════════════════════════════════════════════════════════════════
--
--  CÓMO INSTALARLO
--    1. Entra a tu proyecto en supabase.com
--    2. Menú lateral → SQL Editor → New query
--    3. Pega TODO este archivo y dale RUN
--    4. Listo. Se crean las tablas, las reglas y la config inicial.
--
--  Puedes volver a correrlo cuantas veces quieras: todo está escrito para
--  no romperse si ya existe (IF NOT EXISTS / ON CONFLICT DO NOTHING).
--
--  IDEA CENTRAL DEL DISEÑO
--    Los pronósticos son de SOLO INSERCIÓN. Nadie puede editar ni borrar
--    un pronóstico ya enviado, ni siquiera desde la consola del navegador.
--    Y el cierre de la jornada se aplica AQUÍ, en la base, no en la página:
--    aunque alguien manipule el HTML, la base rechaza el pronóstico tardío.
--    Esto es lo que hace que la quiniela sea confiable sin pedir contraseña.
-- ═══════════════════════════════════════════════════════════════════════


-- ── 1. CONFIGURACIÓN ───────────────────────────────────────────────────
-- Los valores que cambian sin tocar código: cuota, comisión, torneo activo.

create table if not exists config (
  clave  text primary key,
  valor  text not null,
  nota   text
);

insert into config (clave, valor, nota) values
  ('cuota_bote',     '50',            'Lo que va al bote por persona, por jornada'),
  ('cuota_manejo',   '5',             'Comisión por manejo de la quiniela (infraestructura y administración)'),
  ('torneo',         'Apertura 2026', 'Torneo activo, como se muestra en la página'),
  ('espn_liga',      'mex.1',         'Código de Liga MX en la API de ESPN')
on conflict (clave) do nothing;


-- ── 2. LATIDO (keep-alive) ─────────────────────────────────────────────
-- Supabase pausa los proyectos gratis tras 1 semana sin actividad.
-- El cron escribe aquí cada vez que corre, aunque no haya partidos, así el
-- contador de inactividad nunca llega a cero. Ni en el parón entre torneos.

create table if not exists latido (
  id  int primary key default 1,
  ts  timestamptz not null default now(),
  constraint latido_una_sola_fila check (id = 1)
);

insert into latido (id) values (1) on conflict (id) do nothing;


-- ── 3. JORNADAS ────────────────────────────────────────────────────────

create table if not exists jornadas (
  id         bigint generated always as identity primary key,
  torneo     text    not null,
  numero     int     not null,
  cierra_at  timestamptz,          -- se calcula solo: el arranque del 1er partido
  estado     text    not null default 'abierta'
             check (estado in ('abierta', 'cerrada', 'finalizada')),
  creada_at  timestamptz not null default now(),
  unique (torneo, numero)
);

comment on column jornadas.cierra_at is
  'Momento exacto del silbatazo inicial del primer partido. A partir de aquí '
  'la base rechaza pronósticos nuevos. Lo calcula el cron desde la API.';

comment on column jornadas.estado is
  'abierta = se puede pronosticar · cerrada = ya arrancó · finalizada = '
  'todos los partidos terminados y ganadores calculados.';


-- ── 4. PARTIDOS ────────────────────────────────────────────────────────

create table if not exists partidos (
  id              bigint generated always as identity primary key,
  jornada_id      bigint not null references jornadas(id) on delete cascade,
  espn_id         text unique,      -- para que el cron sepa cuál actualizar
  local           text not null,
  visitante       text not null,
  local_logo      text,
  visitante_logo  text,
  local_abbr      text,
  visitante_abbr  text,
  fecha           timestamptz not null,
  estadio         text,
  estado          text not null default 'programado'
                  check (estado in ('programado', 'jugando', 'terminado')),
  minuto          text,             -- '67'' ', 'Medio tiempo', etc.
  goles_local     int,
  goles_visitante int,

  -- Resultado en formato quiniela: L = gana local, E = empate, V = gana visita.
  resultado       text check (resultado in ('L', 'E', 'V')),

  -- Override manual: si tú corriges un resultado desde el panel de admin,
  -- esto se pone en true y el cron ya NO lo vuelve a tocar nunca.
  -- Es el seguro contra un error de la API de ESPN.
  manual          boolean not null default false,

  actualizado_at  timestamptz not null default now()
);

create index if not exists partidos_jornada_idx on partidos (jornada_id, fecha);

comment on column partidos.manual is
  'true = lo corregiste a mano; el cron respeta tu palabra y no lo sobreescribe.';


-- ── 5. PARTICIPANTES ───────────────────────────────────────────────────
-- Sin login: la identidad es el nombre. Guardamos una versión normalizada
-- (sin acentos, sin mayúsculas, sin espacios) para que "José Pérez",
-- "jose perez" y "JOSE PEREZ" sean la misma persona y no se dupliquen.

create table if not exists participantes (
  id        bigint generated always as identity primary key,
  nombre    text not null,
  slug      text not null unique,
  creado_at timestamptz not null default now()
);


-- ── 6. PRONÓSTICOS ─────────────────────────────────────────────────────
-- Un renglón por partido pronosticado. Append-only (ver reglas abajo).

create table if not exists pronosticos (
  id              bigint generated always as identity primary key,
  jornada_id      bigint not null references jornadas(id) on delete cascade,
  partido_id      bigint not null references partidos(id) on delete cascade,
  participante_id bigint not null references participantes(id) on delete cascade,
  pick            text not null check (pick in ('L', 'E', 'V')),
  creado_at       timestamptz not null default now(),

  -- Un solo pronóstico por persona por partido. Sin arrepentimientos.
  unique (partido_id, participante_id)
);

create index if not exists pronosticos_jornada_idx
  on pronosticos (jornada_id, participante_id);


-- ── 7. PAGOS ───────────────────────────────────────────────────────────
-- Quién ya pagó su jornada. Lo marcas tú desde el panel de admin.

create table if not exists pagos (
  jornada_id      bigint not null references jornadas(id) on delete cascade,
  participante_id bigint not null references participantes(id) on delete cascade,
  pagado          boolean not null default false,
  marcado_at      timestamptz not null default now(),
  primary key (jornada_id, participante_id)
);


-- ── 8. TABLA DE LA QUINIELA (vista calculada) ──────────────────────────
-- No guardamos puntos: se calculan al vuelo comparando pick vs resultado.
-- Así nunca hay puntajes "viejos" desincronizados de los resultados.
--   1 punto por acierto (1X2).

create or replace view v_tabla
with (security_invoker = true) as
select
  pr.jornada_id,
  pa.id                                   as participante_id,
  pa.nombre,
  count(*)                                as pronosticados,
  count(pt.resultado)                     as ya_jugados,
  count(*) filter (where pr.pick = pt.resultado) as aciertos
from pronosticos pr
join participantes pa on pa.id = pr.participante_id
join partidos     pt on pt.id = pr.partido_id
group by pr.jornada_id, pa.id, pa.nombre;

comment on view v_tabla is
  'Aciertos por persona por jornada, calculados en vivo. El bote y el reparto '
  'se calculan en la página a partir de esto y de la config.';

-- `security_invoker = true` = la vista consulta con los permisos de QUIEN la
-- llama, respetando el RLS de las tablas de abajo, en vez de saltárselo con
-- los permisos de su dueño.
--
-- El default de Postgres es lo contrario, y por eso Supabase marcaba el error
-- "Security Definer View" sobre v_tabla: una vista que ve por encima de las
-- reglas es un agujero clásico por donde se filtran datos. En nuestro caso no
-- se filtraba nada (la vista solo entrega CUÁNTOS aciertos lleva cada quien,
-- nunca QUÉ pronosticó), pero el aviso estaba bien puesto — y ahora que los
-- pronósticos son públicos, el truco ya no hace falta. Sin errores en el
-- panel, que es como debe estar: así el día que salga uno de verdad, se ve.
grant select on v_tabla to anon, authenticated;


-- ── 9. SEGURIDAD (Row Level Security) ──────────────────────────────────
-- La llave anon del navegador es pública por diseño. Estas reglas son lo
-- que hace que ser pública no importe: definen exactamente qué puede hacer
-- un visitante, y "editar el pronóstico de otro" NO está en la lista.

alter table config        enable row level security;
alter table jornadas      enable row level security;
alter table partidos      enable row level security;
alter table participantes enable row level security;
alter table pronosticos   enable row level security;
alter table pagos         enable row level security;
alter table latido        enable row level security;

-- Lectura pública: la quiniela es transparente, todos ven todo.
drop policy if exists lectura_publica on config;
create policy lectura_publica on config for select using (true);

drop policy if exists lectura_publica on jornadas;
create policy lectura_publica on jornadas for select using (true);

drop policy if exists lectura_publica on partidos;
create policy lectura_publica on partidos for select using (true);

drop policy if exists lectura_publica on participantes;
create policy lectura_publica on participantes for select using (true);

drop policy if exists lectura_publica on pagos;
create policy lectura_publica on pagos for select using (true);

-- PRONÓSTICOS: a la vista de todos, siempre. La quiniela es transparente de
-- principio a fin: cualquiera puede ver lo que puso cada quien desde el
-- momento en que lo manda.
--
-- (Antes estaban ocultos hasta el cierre. Al abrirlos desaparece la razón por
-- la que v_tabla necesitaba saltarse el RLS, y con ella el error de seguridad
-- que marcaba Supabase. Ver la nota de security_invoker en la vista.)
drop policy if exists pronosticos_solo_tras_cierre on pronosticos;
drop policy if exists lectura_publica on pronosticos;
create policy lectura_publica on pronosticos for select using (true);

-- Cualquiera puede registrarse escribiendo su nombre.
drop policy if exists alta_libre on participantes;
create policy alta_libre on participantes for insert with check (true);

-- EL CANDADO IMPORTANTE ────────────────────────────────────────────────
-- Solo se acepta un pronóstico si su jornada sigue abierta Y todavía no
-- llega la hora de cierre. Se evalúa en el servidor con la hora del
-- servidor: no se puede burlar cambiando el reloj de la compu, ni tocando
-- el HTML, ni llamando a la API a mano.
drop policy if exists pronostico_solo_si_abierta on pronosticos;
create policy pronostico_solo_si_abierta on pronosticos
  for insert with check (
    exists (
      select 1 from jornadas j
      where j.id = pronosticos.jornada_id
        and j.estado = 'abierta'
        and (j.cierra_at is null or now() < j.cierra_at)
    )
  );

-- Ojo: NO existe policy de UPDATE ni de DELETE para pronosticos.
-- Sin policy, la operación queda prohibida. Eso hace los pronósticos
-- inmutables: una vez enviado, ni el autor puede cambiarlo. Es lo que
-- vuelve justa una quiniela sin contraseñas.

-- Escritura de resultados, pagos, jornadas y latido: nadie desde el
-- navegador. Solo el cron y el panel de admin, que usan la llave
-- service_role (esa sí salta el RLS y vive únicamente en el servidor).


-- ═══════════════════════════════════════════════════════════════════════
--  Listo. Al terminar deberías ver 7 tablas y 1 vista en Table Editor.
--  Los partidos de la jornada los siembra el cron desde la API de ESPN;
--  no hay que capturar nada a mano.
-- ═══════════════════════════════════════════════════════════════════════
