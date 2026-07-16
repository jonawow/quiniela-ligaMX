// ═══════════════════════════════════════════════════════════════════════
//  QUINIELA MX · Sincronizador (Supabase Edge Function)
// ═══════════════════════════════════════════════════════════════════════
//
//  QUÉ HACE, cada vez que corre:
//    1. Le pregunta a ESPN por los partidos de Liga MX de los próximos días.
//    2. Da de alta las jornadas nuevas que aparezcan (de 9 partidos cada una).
//    3. Actualiza marcadores, minuto y estado de los partidos ya guardados.
//    4. Cierra la jornada al silbatazo del primer partido.
//    5. La marca como finalizada cuando terminan los 9.
//    6. Deja un latido para que Supabase no pause el proyecto gratis.
//
//  CÓMO SABE QUÉ JORNADA ES
//    ESPN no dice el número de jornada — se lo pregunté a su API y no lo trae.
//    Pero la Liga MX tiene 18 equipos y todos juegan cada jornada, así que
//    son exactamente 9 partidos por jornada, siempre. Entonces: agarramos los
//    partidos nuevos en orden de fecha y los cortamos de 9 en 9. Cada corte
//    completo es una jornada, numerada después de la última que ya existía.
//    Determinista y sin adivinar. Si algún día la Liga cambia de equipos,
//    solo hay que mover POR_JORNADA aquí abajo.
//
//  SEGURIDAD
//    Corre con la llave service_role, que se salta el RLS — por eso vive aquí
//    en el servidor y nunca en la página. Es la única pieza con permiso de
//    escribir resultados.
// ═══════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EQUIPOS = 18;
const POR_JORNADA = EQUIPOS / 2;   // 9 partidos

// Cuántos días hacia adelante le pedimos a ESPN. 16 alcanza para ver la
// jornada de hoy y la siguiente, sin traer medio torneo cada minuto.
const DIAS_ADELANTE = 16;
const DIAS_ATRAS = 2;              // por si un partido se pospuso

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// ── Utilidades ─────────────────────────────────────────────────────────

const yyyymmdd = (d: Date) =>
  d.getFullYear() +
  String(d.getMonth() + 1).padStart(2, '0') +
  String(d.getDate()).padStart(2, '0');

async function config(clave: string, def: string): Promise<string> {
  const { data } = await sb.from('config').select('valor').eq('clave', clave).maybeSingle();
  return data?.valor ?? def;
}

// ── Traducción ESPN → nuestro modelo ───────────────────────────────────

type Partido = {
  espn_id: string;
  local: string; visitante: string;
  local_logo: string | null; visitante_logo: string | null;
  local_abbr: string | null; visitante_abbr: string | null;
  fecha: string;
  estadio: string | null;
  estado: 'programado' | 'jugando' | 'terminado';
  minuto: string | null;
  goles_local: number | null; goles_visitante: number | null;
  resultado: 'L' | 'E' | 'V' | null;
};

function traducir(ev: any): Partido | null {
  const comp = ev?.competitions?.[0];
  if (!comp) return null;

  const casa = comp.competitors?.find((c: any) => c.homeAway === 'home');
  const fuera = comp.competitors?.find((c: any) => c.homeAway === 'away');
  if (!casa || !fuera) return null;

  // ESPN resume el estado en 3 letras: pre (no empieza), in (jugando),
  // post (acabó). Es más estable que su lista larga de STATUS_*.
  const estadoEspn = comp.status?.type?.state;
  const estado = estadoEspn === 'in' ? 'jugando'
    : estadoEspn === 'post' ? 'terminado'
      : 'programado';

  const gl = estado === 'programado' ? null : Number(casa.score ?? 0);
  const gv = estado === 'programado' ? null : Number(fuera.score ?? 0);

  // El resultado de quiniela solo existe cuando el partido YA acabó.
  // A media cancha un 1-0 no es un resultado, es un momento.
  let resultado: 'L' | 'E' | 'V' | null = null;
  if (estado === 'terminado' && gl !== null && gv !== null) {
    resultado = gl > gv ? 'L' : gl < gv ? 'V' : 'E';
  }

  return {
    espn_id: String(ev.id),
    local: casa.team?.displayName ?? casa.team?.name ?? '?',
    visitante: fuera.team?.displayName ?? fuera.team?.name ?? '?',
    local_logo: casa.team?.logo ?? null,
    visitante_logo: fuera.team?.logo ?? null,
    local_abbr: casa.team?.abbreviation ?? null,
    visitante_abbr: fuera.team?.abbreviation ?? null,
    fecha: ev.date,
    estadio: comp.venue?.fullName ?? null,
    estado,
    minuto: comp.status?.type?.shortDetail ?? comp.status?.displayClock ?? null,
    goles_local: gl,
    goles_visitante: gv,
    resultado
  };
}

// ── Paso 1: traer de ESPN ──────────────────────────────────────────────

async function traerDeEspn(liga: string): Promise<Partido[]> {
  const hoy = new Date();
  const desde = new Date(hoy); desde.setDate(desde.getDate() - DIAS_ATRAS);
  const hasta = new Date(hoy); hasta.setDate(hasta.getDate() + DIAS_ADELANTE);

  const url = `${ESPN}/${liga}/scoreboard?dates=${yyyymmdd(desde)}-${yyyymmdd(hasta)}`;
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`ESPN respondió ${r.status}`);

  const json = await r.json();
  return (json.events ?? [])
    .map(traducir)
    .filter((p: Partido | null): p is Partido => p !== null)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// ── Paso 2: actualizar los partidos que ya conocemos ───────────────────

async function actualizarConocidos(partidos: Partido[]) {
  const ids = partidos.map((p) => p.espn_id);
  if (!ids.length) return new Set<string>();

  const { data: guardados } = await sb.from('partidos')
    .select('espn_id, manual').in('espn_id', ids);

  const conocidos = new Set((guardados ?? []).map((r) => r.espn_id));
  // Los que tú corregiste a mano: el cron no los toca. Tu palabra manda.
  const intocables = new Set((guardados ?? []).filter((r) => r.manual).map((r) => r.espn_id));

  let tocados = 0;
  for (const p of partidos) {
    if (!conocidos.has(p.espn_id) || intocables.has(p.espn_id)) continue;

    await sb.from('partidos').update({
      estado: p.estado,
      minuto: p.minuto,
      goles_local: p.goles_local,
      goles_visitante: p.goles_visitante,
      resultado: p.resultado,
      fecha: p.fecha,            // por si reprograman el partido
      estadio: p.estadio,
      actualizado_at: new Date().toISOString()
    }).eq('espn_id', p.espn_id);
    tocados++;
  }

  return conocidos;
}

// ── Paso 3: dar de alta jornadas nuevas ────────────────────────────────

async function crearJornadasNuevas(partidos: Partido[], conocidos: Set<string>, torneo: string) {
  const nuevos = partidos.filter((p) => !conocidos.has(p.espn_id));
  if (nuevos.length < POR_JORNADA) return 0;   // todavía no completa una jornada

  const { data: ultima } = await sb.from('jornadas')
    .select('numero').eq('torneo', torneo)
    .order('numero', { ascending: false }).limit(1).maybeSingle();

  let numero = (ultima?.numero ?? 0) + 1;
  let creadas = 0;

  // De 9 en 9. Si sobran partidos sueltos al final (porque la ventana de
  // fechas cortó la jornada a la mitad), los dejamos para la próxima
  // corrida: más vale esperar que crear una jornada coja.
  for (let i = 0; i + POR_JORNADA <= nuevos.length; i += POR_JORNADA) {
    const lote = nuevos.slice(i, i + POR_JORNADA);

    // El cierre es el silbatazo del primero. Como vienen ordenados por
    // fecha, es el primero del lote.
    const cierra_at = lote[0].fecha;

    const { data: j, error } = await sb.from('jornadas')
      .insert({ torneo, numero, cierra_at, estado: 'abierta' })
      .select('id').single();

    if (error) { console.error('No se pudo crear la jornada', numero, error); break; }

    await sb.from('partidos').insert(lote.map((p) => ({ ...p, jornada_id: j.id })));

    console.log(`Jornada ${numero} creada con ${lote.length} partidos, cierra ${cierra_at}`);
    numero++; creadas++;
  }

  return creadas;
}

// ── Paso 4: abrir/cerrar/finalizar jornadas ────────────────────────────

async function moverEstados(torneo: string) {
  const { data: jornadas } = await sb.from('jornadas')
    .select('id, numero, estado, cierra_at').eq('torneo', torneo)
    .neq('estado', 'finalizada');

  for (const j of jornadas ?? []) {
    // Cierra al llegar la hora del primer partido.
    if (j.estado === 'abierta' && j.cierra_at && new Date() >= new Date(j.cierra_at)) {
      await sb.from('jornadas').update({ estado: 'cerrada' }).eq('id', j.id);
      console.log(`Jornada ${j.numero} cerrada`);
    }

    // Finaliza cuando ya no queda ningún partido sin terminar.
    const { count: pendientes } = await sb.from('partidos')
      .select('id', { count: 'exact', head: true })
      .eq('jornada_id', j.id).neq('estado', 'terminado');

    if (pendientes === 0) {
      await sb.from('jornadas').update({ estado: 'finalizada' }).eq('id', j.id);
      console.log(`Jornada ${j.numero} finalizada`);
    }
  }
}

// ── Entrada ────────────────────────────────────────────────────────────

Deno.serve(async () => {
  const inicio = Date.now();
  try {
    const torneo = await config('torneo', 'Apertura 2026');
    const liga = await config('espn_liga', 'mex.1');

    const partidos = await traerDeEspn(liga);
    const conocidos = await actualizarConocidos(partidos);
    const creadas = await crearJornadasNuevas(partidos, conocidos, torneo);
    await moverEstados(torneo);

    // El latido. Escribir aquí reinicia el contador de inactividad de
    // Supabase, así el proyecto gratis nunca se pausa — ni en el parón
    // entre Apertura y Clausura, cuando no hay un solo partido que jalar.
    await sb.from('latido').update({ ts: new Date().toISOString() }).eq('id', 1);

    const res = {
      ok: true,
      torneo,
      vistos: partidos.length,
      jornadas_creadas: creadas,
      ms: Date.now() - inicio
    };
    console.log(JSON.stringify(res));
    return new Response(JSON.stringify(res), {
      headers: { 'content-type': 'application/json' }
    });

  } catch (e) {
    // Si ESPN se cae o cambia, NO reventamos: dejamos el latido para que el
    // proyecto siga vivo y devolvemos el error para verlo en los logs. La
    // quiniela se queda con los últimos datos buenos en vez de romperse.
    console.error('Falló el sync:', e);
    await sb.from('latido').update({ ts: new Date().toISOString() }).eq('id', 1);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }
});
