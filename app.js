/* ═══════════════════════════════════════════════════════════════════════
   QUINIELA MX · Lógica de la página
   ═══════════════════════════════════════════════════════════════════════

   CÓMO ESTÁ ARMADO
     · La página NUNCA habla con ESPN. Solo lee la base de datos.
       Quien habla con ESPN es el cron (sync.ts), cada minuto. Así, si un
       día ESPN cambia o se cae, la quiniela sigue de pie con lo último
       que se guardó, en vez de romperse en la cara del jugador.

     · Tu propio pronóstico se guarda en TU navegador al enviarlo. No es un
       capricho: la base no entrega los pronósticos de nadie hasta que
       cierra la jornada (así nadie copia), así que ni siquiera podríamos
       pedirle "el mío". El navegador es el único que lo sabe antes del
       cierre.
   ═══════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  const CFG = window.QMX_CONFIG || {};

  // ── Estado ───────────────────────────────────────────────────────────
  const S = {
    sb: null,
    cfg: { cuota_bote: CFG.CUOTA_BOTE ?? 50, cuota_manejo: CFG.CUOTA_MANEJO ?? 5, torneo: CFG.TORNEO },
    jornada: null,
    partidos: [],
    picks: {},        // { [partidoId]: 'L' | 'E' | 'V' }
    enviado: false,   // ya mandó su pronóstico de esta jornada
    enviando: false,  // hay un envío en vuelo (lo único que apaga el botón)
    solicitud: null,  // depósito/comprobante enviado, aún sin publicar
    tabla: [],
    todos: [],
    pagos: {},        // { [participanteId]: true } — solo lo usa el panel
    historial: [],    // ganadores de jornadas ya finalizadas, reciente primero
    picksCache: {},   // { [jornadaId]: pronosticos[] } — se llena bajo demanda
    posiciones: [],   // tabla general de la Liga MX (la trae el cron)
    timer: null
  };

  // Cuánto antes del arranque de la próxima jornada se retira el popup del
  // ganador anterior. El usuario lo pidió así: que la felicitación viva en el
  // hueco entre jornadas, pero se quite un rato antes de que empiece la que sigue.
  const VENTANA_POPUP_MS = 3 * 60 * 60 * 1000;   // 3 horas

  // ── Atajos ───────────────────────────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

  const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-MX');

  // Normaliza un nombre a una llave estable: "José Pérez" y "jose perez"
  // son la misma persona y no deben duplicarse en la tabla.
  // ̀-ͯ = los acentos que NFD separa de su letra ("é" → "e" + "´").
  const slugify = (s) => String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const iniciales = (nombre) => String(nombre || '').trim().split(/\s+/).slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase()).join('') || '•';

  // ── Guardado local ───────────────────────────────────────────────────
  const store = {
    get(k, def = null) {
      try { const v = localStorage.getItem('qmx-' + k); return v ? JSON.parse(v) : def; }
      catch { return def; }
    },
    set(k, v) {
      try { localStorage.setItem('qmx-' + k, JSON.stringify(v)); } catch { }
    }
  };

  // ── Avisos flotantes ─────────────────────────────────────────────────
  const ICO_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.4 12 2.5 2.5 4.7-5"/></svg>';
  const ICO_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.3v.2"/></svg>';

  function toast(msg, tipo = 'ok') {
    const wrap = $('#toast-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast is-' + tipo;
    el.innerHTML = (tipo === 'ok' ? ICO_OK : ICO_ERR) + '<span>' + esc(msg) + '</span>';
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 400);
    }, 4200);
  }

  function alerta(msg, tipo = 'warn') {
    const el = $('#jugar-alert');
    if (!el) return;
    el.className = 'alert is-' + tipo;
    el.innerHTML = msg;
    el.hidden = false;
  }

  // ── Fechas ───────────────────────────────────────────────────────────
  // SIEMPRE hora del centro de México, sin importar dónde esté el teléfono.
  // No es un detalle: si usáramos la hora local de cada quien, alguien en
  // Tijuana vería "17:00" y alguien en Cancún "20:00" para el mismo partido,
  // y ninguno de los dos cuadraría con lo que anuncia la Liga MX. Todos
  // hablan de la misma hora que ven en ligamx.net y en la tele.
  //
  // Ojo: esto es solo para MOSTRAR. La cuenta regresiva y el cierre no usan
  // esto — trabajan con el instante exacto en UTC, así que son correctos
  // desde cualquier parte del mundo.
  const FMT_FECHA = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  function fechaCorta(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = {};
    FMT_FECHA.formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    const limpia = (s) => String(s || '').replace(/\./g, '');
    const dia = limpia(p.weekday);
    return `${dia.charAt(0).toUpperCase()}${dia.slice(1)} ${p.day} ${limpia(p.month)} · ${p.hour}:${p.minute}`;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  ARRANQUE
  // ═════════════════════════════════════════════════════════════════════

  async function boot() {
    initTema();

    // Va aquí arriba, no al final: el menú, el tema y lo de la app tienen
    // que funcionar aunque la base de datos no responda y nos salgamos
    // antes de tiempo. Sobre todo el aviso de versión nueva: si la app se
    // rompiera por un bug, ese aviso es justo el que trae el arreglo.
    initFlechasMenu();
    initPWA();
    $('#theme-btn').addEventListener('click', toggleTema);

    if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.startsWith('PEGA_AQUI')) {
      alerta(
        '<b>Falta conectar la base de datos.</b> Abre <code>config.js</code> y pega ahí el ' +
        'Project URL y la llave anon de tu proyecto de Supabase.', 'err');
      $('#partidos-list').innerHTML = '<div class="empty">Sin conexión a la base de datos.</div>';
      return;
    }

    S.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);

    const nombreGuardado = store.get('nombre', '');
    if (nombreGuardado) $('#nombre-input').value = nombreGuardado;

    await cargarConfig();
    await cargarJornada();

    if (!S.jornada) {
      $('#hero-pill-text').textContent = 'Sin jornada activa';
      $('#partidos-list').innerHTML =
        '<div class="empty">Todavía no hay jornada abierta. El sistema la crea solo en cuanto ' +
        'la Liga MX publica el calendario.</div>';
      return;
    }

    await Promise.all([cargarPartidos(), cargarTabla(), cargarTodos(), cargarPagos(),
      cargarHistorial(), cargarPosiciones()]);

    render();
    arrancarReloj();
    arrancarSondeo();
    conectarEventos();
    initPagoModal();
    initAdmin();
    initGanadorModal();
    initHistorico();
    revisarGanadorPopup();
  }

  // ── Config desde la base (manda sobre config.js) ──────────────────────
  async function cargarConfig() {
    const { data, error } = await S.sb.from('config').select('clave, valor');
    if (error || !data) return;              // nos quedamos con los de config.js
    data.forEach((r) => {
      if (r.clave === 'cuota_bote') S.cfg.cuota_bote = Number(r.valor);
      if (r.clave === 'cuota_manejo') S.cfg.cuota_manejo = Number(r.valor);
      if (r.clave === 'torneo') S.cfg.torneo = r.valor;
    });
  }

  // ── Jornada activa ───────────────────────────────────────────────────
  // La activa es la MÁS PRÓXIMA que todavía no termina: la de número más
  // bajo que no esté finalizada.
  //
  // El cron mira 16 días adelante, así que casi siempre hay más de una
  // jornada creada por delante (hoy existen la 1 y la 2, las dos abiertas).
  // Hay que agarrar la primera, no la última: si no, mientras se juega la
  // Jornada 1 la página estaría enseñando la 2.
  //
  // Y "no finalizada" en vez de "abierta" a propósito: mientras la jornada
  // se está jugando ya está cerrada, pero es justo la que la gente quiere
  // ver. Se salta a la siguiente sola, cuando terminan sus 9 partidos.
  async function cargarJornada() {
    let { data } = await S.sb.from('jornadas').select('*')
      .neq('estado', 'finalizada').order('numero', { ascending: true }).limit(1);

    // Si ya terminaron todas (fin de torneo), enseñamos la última que hubo.
    if (!data || !data.length) {
      const r = await S.sb.from('jornadas').select('*')
        .order('numero', { ascending: false }).limit(1);
      data = r.data;
    }

    S.jornada = (data && data[0]) || null;

    if (S.jornada) {
      S.picks = store.get('picks-' + S.jornada.id, {});
      S.enviado = store.get('enviado-' + S.jornada.id, false);
      S.solicitud = store.get('solicitud-' + S.jornada.id, null);
    }
  }

  async function cargarPartidos() {
    const { data } = await S.sb.from('partidos').select('*')
      .eq('jornada_id', S.jornada.id).order('fecha', { ascending: true });
    S.partidos = data || [];
  }

  async function cargarTabla() {
    const { data } = await S.sb.from('v_tabla').select('*').eq('jornada_id', S.jornada.id);
    S.tabla = (data || []).sort((a, b) => b.aciertos - a.aciertos || a.nombre.localeCompare(b.nombre));
  }

  async function cargarPagos() {
    const { data } = await S.sb.from('pagos').select('participante_id, pagado')
      .eq('jornada_id', S.jornada.id);
    S.pagos = Object.fromEntries((data || []).filter((r) => r.pagado).map((r) => [r.participante_id, true]));
  }

  async function cargarTodos() {
    const { data } = await S.sb.from('pronosticos')
      .select('partido_id, pick, participante_id, participantes(nombre)')
      .eq('jornada_id', S.jornada.id);
    S.todos = data || [];

    // La solicitud es privada, pero cuando el admin la publica los picks ya
    // aparecen en la tabla pública. Esa es la señal segura para desbloquear
    // este mismo navegador sin exponer solicitudes pendientes a nadie.
    if (S.solicitud && S.todos.some((r) =>
      slugify(r.participantes?.nombre) === S.solicitud.slug)) {
      S.enviado = true;
      S.solicitud = null;
      store.set('enviado-' + S.jornada.id, true);
      store.set('solicitud-' + S.jornada.id, null);
    }
  }

  // ── Tabla de posiciones de la Liga MX ────────────────────────────────
  // La llena el cron desde ESPN; aquí solo se lee, ya ordenada por posición.
  async function cargarPosiciones() {
    const { data } = await S.sb.from('posiciones').select('*')
      .eq('torneo', S.cfg.torneo).order('posicion', { ascending: true });
    S.posiciones = data || [];
  }

  // ── Historial: ganadores de las jornadas ya finalizadas ────────────────
  // Una sola pasada: traemos las jornadas finalizadas y, de un jalón, la tabla
  // de aciertos de todas ellas. El ganador y el reparto se calculan aquí con
  // resumenGanador(), igual que la jornada activa. Reciente primero.
  async function cargarHistorial() {
    const { data: js } = await S.sb.from('jornadas').select('*')
      .eq('estado', 'finalizada').order('numero', { ascending: false });

    const finalizadas = js || [];
    if (!finalizadas.length) { S.historial = []; return; }

    const ids = finalizadas.map((j) => j.id);

    // De un jalón: la tabla de aciertos (para el ganador) y los partidos de
    // todas las jornadas (para el histórico de resultados). Los pronósticos de
    // cada quien NO se traen aquí: pesan más y solo hacen falta al desplegar
    // una jornada o abrir el detalle, así que se cargan bajo demanda.
    const [rTabla, rPartidos] = await Promise.all([
      S.sb.from('v_tabla').select('*').in('jornada_id', ids),
      S.sb.from('partidos').select('*').in('jornada_id', ids).order('fecha', { ascending: true })
    ]);

    const tablaPorJornada = agrupar(rTabla.data || [], 'jornada_id');
    const partidosPorJornada = agrupar(rPartidos.data || [], 'jornada_id');

    S.historial = finalizadas.map((j) => ({
      jornada: j,
      partidos: partidosPorJornada.get(j.id) || [],
      ...resumenGanador(tablaPorJornada.get(j.id) || [])
    }));
  }

  // Agrupa un arreglo de filas por el valor de una columna → Map(valor → filas[]).
  function agrupar(filas, col) {
    const m = new Map();
    filas.forEach((r) => {
      if (!m.has(r[col])) m.set(r[col], []);
      m.get(r[col]).push(r);
    });
    return m;
  }

  // Pronósticos de una jornada (con el nombre de cada quien), a demanda y en
  // caché: para el detalle del ganador y para el desplegable del histórico.
  async function cargarPicksJornada(jornadaId) {
    if (S.picksCache[jornadaId]) return S.picksCache[jornadaId];
    const { data } = await S.sb.from('pronosticos')
      .select('partido_id, pick, participante_id, participantes(nombre)')
      .eq('jornada_id', jornadaId);
    S.picksCache[jornadaId] = data || [];
    return S.picksCache[jornadaId];
  }

  // ── ¿Ya cerró? ───────────────────────────────────────────────────────
  function estaCerrada() {
    if (!S.jornada) return true;
    if (S.jornada.estado !== 'abierta') return true;
    if (S.jornada.cierra_at && new Date() >= new Date(S.jornada.cierra_at)) return true;
    return false;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  PINTADO
  // ═════════════════════════════════════════════════════════════════════

  function render() {
    renderCabecera();
    renderCosto();
    renderBote();
    renderPartidos();
    renderEnVivo();
    renderTabla();
    renderTodos();
    renderPosiciones();
    renderHistorial();
    renderHistorico();
    renderProgreso();
  }

  // ── El bote y quién va ganando ───────────────────────────────────────
  // Todo lo del dinero sale de un solo lugar para que nunca se contradiga:
  // el banner, el hero y la tabla siempre dicen lo mismo.
  function cuentas() { return resumenGanador(S.tabla); }

  // Las cuentas de UNA jornada a partir de su tabla (filas de v_tabla). Lo usan
  // por igual el bote de la jornada activa y el historial de jornadas pasadas,
  // así el ganador y el reparto se calculan con la misma regla en todos lados.
  function resumenGanador(tabla) {
    const filas = (tabla || []).slice().sort((a, b) =>
      b.aciertos - a.aciertos || String(a.nombre).localeCompare(b.nombre));
    const gente = filas.length;
    const bote = gente * S.cfg.cuota_bote;
    const top = filas[0]?.aciertos ?? 0;

    // Solo hay "líder" si alguien ya sumó algo. Con todos en cero no va
    // ganando nadie: sería coronar al primero de la lista por su nombre.
    const lideres = top > 0 ? filas.filter((r) => r.aciertos === top) : [];
    const reparto = lideres.length ? Math.floor(bote / lideres.length) : 0;
    const jugados = filas[0]?.pronosticados ?? 0;   // partidos que pronosticó (9)

    return { gente, bote, top, lideres, reparto, jugados };
  }

  function renderBote() {
    const { gente, bote, top, lideres, reparto } = cuentas();
    const hayVivo = S.partidos.some((p) => p.estado === 'jugando');
    const terminada = S.partidos.length > 0 && S.partidos.every((p) => p.estado === 'terminado');

    $('#bote-cifra').textContent = money(bote);
    $('#bote-pill').textContent = !gente
      ? 'Nadie ha entrado todavía'
      : `${gente} ${gente === 1 ? 'participante' : 'participantes'} · ${money(S.cfg.cuota_bote)} c/u`;

    // Panel de "va ganando"
    const panel = $('#lider-panel');
    if (!lideres.length) { panel.hidden = true; return; }
    panel.hidden = false;

    const nombres = lideres.length === 1
      ? lideres[0].nombre
      : lideres.length === 2
        ? `${lideres[0].nombre} y ${lideres[1].nombre}`
        : `${lideres[0].nombre} y ${lideres.length - 1} más`;

    const frase = terminada
      ? (lideres.length === 1
          ? `<b>${top} pts</b> · se lleva <b>${money(reparto)}</b>`
          : `<b>${top} pts</b> · se reparten el bote: <b>${money(reparto)}</b> cada uno`)
      : (lideres.length === 1
          ? `<b>${top} pts</b> · si terminara hoy se lleva <b>${money(reparto)}</b>`
          : `<b>${top} pts</b> · empatados: <b>${money(reparto)}</b> cada uno si termina así`);

    panel.innerHTML = `
      <span class="lider-corona" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 8l4.2 3.4L12 4.2l4.8 7.2L21 8l-1.5 9.2h-15L3 8Z" /><path d="M4.9 17.2h14.2" />
        </svg>
      </span>
      <div class="lider-copy">
        <div class="lider-label">${terminada ? 'Ganador' : 'Va ganando'}</div>
        <div class="lider-nombre">${esc(nombres)}</div>
        <div class="lider-sub">${frase}</div>
      </div>
      ${hayVivo ? '<span class="lider-live"><span class="ev-dot"></span>En vivo</span>' : ''}`;
  }

  function renderCabecera() {
    const cerrada = estaCerrada();
    const hayVivo = S.partidos.some((p) => p.estado === 'jugando');

    $('#brand-torneo').textContent = S.cfg.torneo;
    $('#footer-torneo').textContent = S.cfg.torneo + ' · Liga BBVA MX';
    $('#hero-jornada').textContent = S.jornada.numero;

    const pill = $('#hero-pill');
    const txt = $('#hero-pill-text');
    pill.className = 'pill';

    if (hayVivo) {
      pill.classList.add('is-live');
      txt.textContent = 'Se está jugando ahorita';
    } else if (cerrada) {
      pill.classList.add('is-closed');
      txt.textContent = 'Pronósticos cerrados';
    } else {
      txt.textContent = 'Abierta · todavía puedes entrar';
    }

    // Bote: cuánta gente jugó × lo que va al bote de cada quien. Sale de
    // cuentas(), igual que el banner grande, para que nunca se contradigan.
    const { gente, bote } = cuentas();
    $('#bote-amount').textContent = money(bote);
    $('#bote-people').textContent = gente === 1 ? '1 jugando' : gente + ' jugando';
    $('#bote-cuota').textContent = S.cfg.cuota_bote;
  }

  function renderCosto() {
    const { cuota_bote: b, cuota_manejo: m } = S.cfg;
    $('#costo-total').textContent = money(b + m);
    $('#costo-bote').textContent = b;
    $('#costo-manejo').textContent = m;

    // La sección "¿Por qué?" repite estas cifras en su texto. Las llenamos
    // aquí para que sigan a la config y nunca digan un número distinto al
    // del recuadro de arriba, incluso si mañana cambia la comisión.
    const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    set('#porque-manejo', m);
    set('#porque-manejo-2', m);
    set('#porque-bote', b);
    set('#porque-total', b + m);
  }

  function renderPartidos() {
    const cont = $('#partidos-list');
    const cerrada = estaCerrada();

    if (!S.partidos.length) {
      cont.innerHTML = '<div class="empty">Los partidos de esta jornada todavía no se cargan.</div>';
      return;
    }

    if (S.enviado && cerrada) {
      alerta('<b>Ya quedó tu pronóstico.</b> La jornada cerró — ahora a ver los partidos. ' +
        'Tus aciertos se van marcando solos en <a href="#envivo">En vivo</a>.', 'ok');
    } else if (S.solicitud) {
      alerta('<b>Tu depósito está en revisión.</b> En cuanto el admin confirme el comprobante, ' +
        'tu pronóstico se publicará automáticamente.', 'warn');
    } else if (cerrada) {
      alerta('<b>Esta jornada ya cerró.</b> Se cerró al arrancar el primer partido. ' +
        'Aquí abajo puedes ver cómo van, y la que sigue abre en cuanto termine esta.', 'warn');
    } else if (S.enviado) {
      alerta('<b>Listo, ya estás dentro.</b> Tu pronóstico quedó guardado y ya no se puede cambiar — ' +
        'eso es justo lo que lo hace parejo para todos.', 'ok');
    }

    cont.innerHTML = S.partidos.map((p) => tarjetaPartido(p, cerrada)).join('');

    $('#submit-bar').hidden = cerrada || S.enviado || !!S.solicitud;
  }

  function tarjetaPartido(p, cerrada) {
    const pick = S.picks[p.id];
    const bloqueado = cerrada || S.enviado || !!S.solicitud;

    const logo = (url, nombre) => url
      ? `<img class="team-logo" src="${esc(url)}" alt="" loading="lazy">`
      : `<span class="team-logo"></span>`;

    // El botón lleva el nombre completo Y la abreviatura; el CSS decide cuál
    // se ve según el ancho. En celular no cabe "Atlético de San Luis", pero
    // tampoco queremos tres botones que digan "Gana / X / Gana" sin decir de
    // quién: ahí entra el "ATL". La abreviatura la manda ESPN; si algún día
    // llegara vacía, cortamos el nombre en 3 letras y seguimos.
    const abrev = (abbr, nombre) => abbr || String(nombre || '').slice(0, 3).toUpperCase();

    const btn = (val, titulo, equipo, abbr, etiqueta) => `
      <button class="pick-btn${pick === val ? ' is-on' : ''}" type="button"
              data-partido="${p.id}" data-pick="${val}" ${bloqueado ? 'disabled' : ''}
              aria-pressed="${pick === val}" aria-label="${esc(etiqueta)}">
        <span>${esc(titulo)}</span>
        <small class="pick-full">${esc(equipo)}</small>
        <small class="pick-abbr">${esc(abbr)}</small>
      </button>`;

    return `
      <article class="partido${pick ? ' is-picked' : ''}${bloqueado ? ' is-locked' : ''}" data-id="${p.id}">
        <div class="partido-meta">
          <span class="meta-date">${esc(fechaCorta(p.fecha))}</span>
          ${p.estadio ? `<span class="dot-sep">·</span><span>${esc(p.estadio)}</span>` : ''}
          ${p.tv ? `<span class="dot-sep">·</span>
            <span class="tv-chip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="6" width="18" height="12" rx="2" /><path d="M8 21h8M12 18v3" />
              </svg>${esc(p.tv)}
            </span>` : ''}
        </div>

        <div class="partido-teams">
          <div class="team">
            ${logo(p.local_logo)}
            <span class="team-name">${esc(p.local)}</span>
          </div>
          <span class="vs">VS</span>
          <div class="team team-away">
            ${logo(p.visitante_logo)}
            <span class="team-name">${esc(p.visitante)}</span>
          </div>
        </div>

        <div class="picker" role="group" aria-label="Tu pronóstico">
          ${btn('L', 'Gana', p.local, abrev(p.local_abbr, p.local), 'Gana ' + p.local)}
          ${btn('E', 'X', 'Empate', 'Empate', 'Empate')}
          ${btn('V', 'Gana', p.visitante, abrev(p.visitante_abbr, p.visitante), 'Gana ' + p.visitante)}
        </div>
      </article>`;
  }

  function renderEnVivo() {
    const cont = $('#envivo-list');
    const jugados = S.partidos.filter((p) => p.estado !== 'programado');

    if (!jugados.length) {
      cont.innerHTML = '<div class="empty">Todavía no arranca la jornada. Aquí van a aparecer ' +
        'los marcadores en cuanto ruede el balón.</div>';
      return;
    }

    cont.innerHTML = jugados.map((p) => {
      const vivo = p.estado === 'jugando';
      const mi = S.picks[p.id];

      // Solo marcamos acierto/fallo cuando el partido ya terminó: a media
      // cancha el marcador cambia y sería engañoso decirle "fallaste".
      let marca = '';
      if (mi && p.estado === 'terminado' && p.resultado) {
        const bien = mi === p.resultado;
        marca = `<span class="ev-mine ${bien ? 'is-hit' : 'is-miss'}">${bien ? '✓ Le atinaste' : '✗ Fallaste'}</span>`;
      }

      const estado = vivo
        ? `<span class="ev-dot"></span>${esc(p.minuto || 'En vivo')}`
        : (p.estado === 'terminado' ? 'Final' : esc(p.minuto || ''));

      return `
        <article class="ev-card${vivo ? ' is-live' : ''}">
          <div class="team">
            ${p.local_logo ? `<img class="team-logo" src="${esc(p.local_logo)}" alt="" loading="lazy">` : ''}
            <span class="team-name">${esc(p.local)}</span>
          </div>
          <div class="ev-score">
            <div class="ev-nums">
              <span>${p.goles_local ?? 0}</span><em>–</em><span>${p.goles_visitante ?? 0}</span>
            </div>
            <span class="ev-status">${estado}</span>
            ${marca}
          </div>
          <div class="team team-away">
            ${p.visitante_logo ? `<img class="team-logo" src="${esc(p.visitante_logo)}" alt="" loading="lazy">` : ''}
            <span class="team-name">${esc(p.visitante)}</span>
          </div>
        </article>`;
    }).join('');
  }

  function renderTabla() {
    const cont = $('#tabla-wrap');

    if (!S.tabla.length) {
      cont.innerHTML = '<div class="empty">Nadie ha pronosticado todavía. Sé el primero.</div>';
      return;
    }

    const yo = slugify($('#nombre-input').value || store.get('nombre', ''));
    const { top, reparto } = cuentas();
    const terminada = S.partidos.length > 0 && S.partidos.every((p) => p.estado === 'terminado');

    const filas = S.tabla.map((r, i) => {
      const esLider = r.aciertos === top && top > 0;
      const esYo = slugify(r.nombre) === yo && yo;
      return `
        <div class="tabla-row${esLider ? ' is-leader' : ''}${esYo ? ' is-me' : ''}">
          <span class="t-pos">${i + 1}</span>
          <span class="t-name">
            <span>${esc(r.nombre)}</span>
            ${esYo ? '<span class="t-badge">tú</span>' : ''}
          </span>
          <span class="t-pts">${r.aciertos}<small>/${r.pronosticados}</small></span>
          <span class="t-prize">${esLider ? money(reparto) : ''}</span>
        </div>`;
    }).join('');

    cont.innerHTML = `
      <div class="tabla-row is-head">
        <span>#</span><span>Jugador</span><span>Aciertos</span>
        <span>${terminada ? 'Gana' : 'Va ganando'}</span>
      </div>
      ${filas}`;
  }

  // ── Tabla de posiciones de la Liga MX ────────────────────────────────
  // Zonas de clasificación del formato actual: 1–6 pasan directo a Liguilla,
  // 7–10 juegan el Play-In. Si algún día la Liga cambia el formato, se ajusta
  // aquí y en la leyenda del HTML.
  function zonaLiga(pos) {
    if (pos >= 1 && pos <= 6) return 'liguilla';
    if (pos >= 7 && pos <= 10) return 'playin';
    return '';
  }

  function renderPosiciones() {
    const cont = $('#posiciones-wrap');
    if (!cont) return;

    if (!S.posiciones.length) {
      cont.innerHTML = '<div class="empty">La tabla de la Liga MX aparece aquí en cuanto el ' +
        'sistema la traiga. Se actualiza sola cuando hay partidos.</div>';
      return;
    }

    const filas = S.posiciones.map((r) => {
      const dg = r.diferencia ?? 0;
      const dgTxt = dg > 0 ? '+' + dg : String(dg);
      const abbr = r.equipo_abbr || String(r.equipo || '').slice(0, 3).toUpperCase();
      const logo = r.logo
        ? `<img class="team-logo" src="${esc(r.logo)}" alt="" loading="lazy">`
        : '<span class="team-logo"></span>';

      return `
        <div class="pos-row zona-${zonaLiga(r.posicion)}">
          <span class="pos-num">${r.posicion}</span>
          <span class="pos-equipo">
            ${logo}
            <span class="pos-nombre">${esc(r.equipo)}</span>
            <span class="pos-abbr">${esc(abbr)}</span>
          </span>
          <span class="pos-pj">${r.jugados ?? 0}</span>
          <span class="pos-dg">${esc(dgTxt)}</span>
          <span class="pos-pts">${r.puntos ?? 0}</span>
        </div>`;
    }).join('');

    cont.innerHTML = `
      <div class="pos-row is-head">
        <span>#</span><span>Equipo</span><span>PJ</span><span>DG</span><span>Pts</span>
      </div>
      ${filas}`;
  }

  // Un pick dibujado: el escudo del equipo por el que le fue, en vez de una
  // letra suelta. "L" y "V" no le dicen nada a nadie; un escudo se reconoce
  // de un vistazo y sin pensarlo.
  //   · Gana local o visita → el escudo de ese equipo.
  //   · Empate             → los dos escudos con una × en medio.
  // Cuando el partido termina, el chip se pinta de verde o de rojo.
  function chipPick(pick, partido) {
    if (!partido) return `<span class="chip">${pick === 'E' ? '×' : esc(pick)}</span>`;

    const res = partido.resultado;
    const cls = !res ? '' : (res === pick ? ' is-hit' : ' is-miss');
    const marca = !res ? '' : (res === pick ? ' · ✓' : ' · ✗');

    const img = (url, alt) => url
      ? `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`
      : `<b>${esc(alt.slice(0, 3).toUpperCase())}</b>`;

    if (pick === 'E') {
      return `<span class="chip chip-empate${cls}"
                    title="Empate: ${esc(partido.local)} vs ${esc(partido.visitante)}${marca}">
        ${img(partido.local_logo, partido.local)}
        <i>×</i>
        ${img(partido.visitante_logo, partido.visitante)}
      </span>`;
    }

    const gana = pick === 'L' ? partido.local : partido.visitante;
    const logo = pick === 'L' ? partido.local_logo : partido.visitante_logo;
    return `<span class="chip${cls}" title="Gana ${esc(gana)}${marca}">
      ${img(logo, gana)}
    </span>`;
  }

  // La rejilla de "qué le puso cada quien", con sus escudos pintados de verde
  // o rojo según el resultado. La usan por igual la jornada activa (Pronósticos
  // de todos) y cada jornada del histórico. Devuelve solo las tarjetas; el
  // estado vacío lo pone quien llama, porque el mensaje cambia según el lugar.
  function htmlGridPicks(rows, partidos) {
    const porPersona = new Map();
    (rows || []).forEach((r) => {
      const nombre = r.participantes?.nombre || '—';
      if (!porPersona.has(nombre)) porPersona.set(nombre, []);
      porPersona.get(nombre).push(r);
    });
    if (!porPersona.size) return '';

    // Los picks vienen de la base sin orden garantizado. Los acomodamos en el
    // mismo orden en que se juegan los partidos: así la fila de escudos de
    // cada quien se lee en paralelo con la de los demás.
    const orden = Object.fromEntries(partidos.map((p, i) => [p.id, i]));
    const porId = Object.fromEntries(partidos.map((p) => [p.id, p]));

    const gente = [...porPersona.entries()].map(([nombre, picks]) => {
      picks.sort((a, b) => (orden[a.partido_id] ?? 99) - (orden[b.partido_id] ?? 99));
      const aciertos = picks.filter((p) => porId[p.partido_id]?.resultado === p.pick).length;
      return { nombre, picks, aciertos };
    });
    // Más aciertos arriba: en una jornada terminada, el de hasta arriba es el
    // ganador y se lee de un vistazo por qué.
    gente.sort((a, b) => b.aciertos - a.aciertos || a.nombre.localeCompare(b.nombre));

    return gente.map(({ nombre, picks, aciertos }) => `
        <article class="todo-card">
          <div class="todo-head">
            <span class="avatar">${esc(iniciales(nombre))}</span>
            <div style="min-width:0">
              <div class="todo-name">${esc(nombre)}</div>
              <div class="todo-sub">${aciertos} de ${picks.length} aciertos</div>
            </div>
          </div>
          <div class="todo-picks">${chips(picks, porId)}</div>
        </article>`).join('');

    function chips(picks, porId) {
      return picks.map((p) => chipPick(p.pick, porId[p.partido_id])).join('');
    }
  }

  function renderTodos() {
    const cont = $('#todos-grid');
    const html = htmlGridPicks(S.todos, S.partidos);
    cont.innerHTML = html ||
      '<div class="empty" style="grid-column:1/-1">Nadie pronosticó esta jornada.</div>';
  }

  // No metemos una librería pesada solo para una hoja. El diálogo nativo de
  // impresión permite "Guardar como PDF" en computadora y móvil, y esta
  // vista aislada evita que se cuelen menús o botones en la captura.
  function guardarPdfPronosticos() {
    if (!S.todos.length) {
      toast('Aún no hay pronósticos publicados para guardar.', 'err');
      return;
    }

    const ventana = window.open('', 'qmx-pronosticos-pdf');
    if (!ventana) {
      toast('Tu navegador bloqueó la ventana del PDF. Permite las ventanas emergentes e inténtalo otra vez.', 'err');
      return;
    }

    const tarjetas = htmlGridPicks(S.todos, S.partidos);
    const titulo = `${CFG.NOMBRE || 'Quiniela MX'} · Jornada ${S.jornada.numero}`;
    ventana.document.open();
    ventana.document.write(`<!doctype html>
      <html lang="es"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
      <style>
        @page { size: A4; margin: 13mm; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #15251f; font-family: Arial, sans-serif; }
        h1 { margin: 0; font-size: 23px; letter-spacing: -.6px; }
        .sub { margin: 5px 0 20px; color: #527166; font-size: 12px; }
        .todos-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
        .todo-card { break-inside: avoid; padding: 13px; border: 1px solid #cddbd4; border-radius: 12px; }
        .todo-head { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
        .avatar { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; background: #9de6c5; color: #123f2e; font-size: 11px; font-weight: 700; }
        .todo-name { font-size: 13px; font-weight: 700; }
        .todo-sub { margin-top: 1px; font-size: 10px; color: #527166; }
        .todo-picks { display: flex; flex-wrap: wrap; gap: 5px; }
        .chip { width: 31px; height: 31px; display: grid; place-items: center; border: 1px solid #d6e1db; border-radius: 8px; background: #f5faf7; overflow: hidden; }
        .chip img { width: 22px; height: 22px; object-fit: contain; }
        .chip-empate { display: flex; align-items: center; justify-content: center; gap: 1px; }
        .chip-empate img { width: 11px; height: 11px; } .chip-empate i { font-size: 9px; font-style: normal; color: #527166; }
        .chip.is-hit { background: #e5f8ee; border-color: #56bd8d; } .chip.is-miss { opacity: .55; }
        @media print { .todos-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      </style></head><body>
        <h1>${esc(titulo)}</h1>
        <p class="sub">Pronósticos publicados · ${esc(S.cfg.torneo || '')}</p>
        <div class="todos-grid">${tarjetas}</div>
      </body></html>`);
    ventana.document.close();
    ventana.focus();
    ventana.onload = () => setTimeout(() => ventana.print(), 350);
  }

  // ── Salón de la fama: ganadores de jornadas pasadas ──────────────────
  function nombresLideres(lideres) {
    if (!lideres.length) return '';
    if (lideres.length === 1) return lideres[0].nombre;
    if (lideres.length === 2) return `${lideres[0].nombre} y ${lideres[1].nombre}`;
    return `${lideres[0].nombre} y ${lideres.length - 1} más`;
  }

  function renderHistorial() {
    const cont = $('#ganadores-list');
    if (!cont) return;

    if (!S.historial.length) {
      cont.innerHTML = '<div class="empty">Todavía no termina ninguna jornada. ' +
        'Aquí van a quedar guardados los ganadores.</div>';
      return;
    }

    cont.innerHTML = S.historial.map((it) => {
      const j = it.jornada;

      // Jornada sin nadie que haya jugado: no hay a quién coronar, pero sí la
      // dejamos listada para que el historial no tenga huecos.
      if (!it.lideres.length) {
        return `
          <article class="gan-card is-vacia" data-jornada="${j.id}">
            <span class="gan-num">J${j.numero}</span>
            <div class="gan-info">
              <div class="gan-nombre">Sin participantes</div>
              <div class="gan-sub">Nadie jugó esta jornada</div>
            </div>
          </article>`;
      }

      const varios = it.lideres.length > 1;
      return `
        <article class="gan-card" data-jornada="${j.id}" role="button" tabindex="0"
                 aria-label="Ver ganador de la jornada ${j.numero}">
          <span class="gan-num">J${j.numero}</span>
          <span class="gan-medalla" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3h8l-2 6H10L8 3Z"/><circle cx="12" cy="15" r="5.5"/><path d="M12 12.6l.9 1.7 1.9.3-1.4 1.3.3 1.9-1.7-.9-1.7.9.3-1.9-1.4-1.3 1.9-.3.9-1.7Z"/>
            </svg>
          </span>
          <div class="gan-info">
            <div class="gan-nombre">${esc(nombresLideres(it.lideres))}${varios ? ` <small>(${it.lideres.length} empatados)</small>` : ''}</div>
            <div class="gan-sub">${it.top} de ${it.jugados} aciertos · se ${varios ? 'repartieron' : 'llevó'} ${money(it.reparto)}</div>
          </div>
          <svg class="gan-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
        </article>`;
    }).join('');
  }

  // ── El archivo: resultados de jornadas pasadas ───────────────────────
  // Una fila compacta por partido: escudo + nombre de cada lado y el marcador
  // al centro. El lado que ganó se resalta; el empate se marca en medio.
  function htmlResultadoPartido(p) {
    const gl = p.goles_local ?? 0;
    const gv = p.goles_visitante ?? 0;
    const res = p.resultado;
    const logo = (url) => url
      ? `<img class="team-logo" src="${esc(url)}" alt="" loading="lazy">`
      : '<span class="team-logo"></span>';

    return `
      <div class="res-row">
        <div class="res-team${res === 'L' ? ' is-win' : ''}">
          ${logo(p.local_logo)}
          <span class="res-name">${esc(p.local)}</span>
        </div>
        <div class="res-score${res === 'E' ? ' is-draw' : ''}">
          <b>${gl}</b><em>–</em><b>${gv}</b>
        </div>
        <div class="res-team res-away${res === 'V' ? ' is-win' : ''}">
          <span class="res-name">${esc(p.visitante)}</span>
          ${logo(p.visitante_logo)}
        </div>
      </div>`;
  }

  function renderHistorico() {
    const cont = $('#historico-list');
    if (!cont) return;

    if (!S.historial.length) {
      cont.innerHTML = '<div class="empty">Todavía no termina ninguna jornada. ' +
        'Aquí va a quedar el archivo de resultados.</div>';
      return;
    }

    cont.innerHTML = S.historial.map((it) => {
      const j = it.jornada;
      const sub = it.lideres.length
        ? `${esc(nombresLideres(it.lideres))} · ${it.top}/${it.jugados} aciertos`
        : 'Nadie jugó esta jornada';
      const resultados = it.partidos.map(htmlResultadoPartido).join('')
        || '<div class="empty">No se guardaron los partidos de esta jornada.</div>';

      return `
        <details class="hist-jornada" data-jornada="${j.id}">
          <summary class="hist-sum">
            <span class="hist-jnum">J${j.numero}</span>
            <div class="hist-sum-info">
              <div class="hist-sum-title">Jornada ${j.numero} · Resultados</div>
              <div class="hist-sum-sub"><span class="hist-trofeo">🏆</span> ${sub}</div>
            </div>
            <svg class="hist-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </summary>
          <div class="hist-body">
            <div class="hist-resultados">${resultados}</div>
            <div class="hist-picks" data-picks="${j.id}">
              <button class="hist-ver-picks" type="button" data-verpicks="${j.id}">
                Ver qué pronosticó cada quien
              </button>
            </div>
          </div>
        </details>`;
    }).join('');
  }

  function renderProgreso() {
    const total = S.partidos.length;
    const hechos = S.partidos.filter((p) => S.picks[p.id]).length;

    $('#total-count').textContent = total;
    $('#picked-count').textContent = hechos;
    $('#progress-fill').style.width = total ? (hechos / total * 100) + '%' : '0%';

    const btn = $('#submit-btn');
    const completo = total > 0 && hechos === total;
    const conNombre = ($('#nombre-input').value || '').trim().length >= 2;
    const listo = completo && conNombre;

    // OJO: el botón NO se deshabilita por estar incompleto. Un <button disabled>
    // no recibe clics, así que cuando decía "Escribe tu nombre" y le picabas, no
    // pasaba absolutamente nada: parecía descompuesto. Ahora se ve apagado pero
    // sí responde — y al tocarlo te lleva a lo que te falta (ver enviar()).
    // Lo único que lo deshabilita de verdad es estar enviando.
    btn.classList.toggle('is-apagado', !listo);
    btn.setAttribute('aria-disabled', String(!listo));
    btn.disabled = S.enviando === true || !!S.solicitud;

    if (S.enviando) { btn.textContent = 'Enviando…'; return; }
    if (S.solicitud) { btn.textContent = 'Pago en revisión'; return; }

    const faltan = total - hechos;
    btn.textContent = !conNombre ? 'Escribe tu nombre'
      : !completo ? (faltan === 1 ? 'Falta 1 partido' : `Faltan ${faltan} partidos`)
        : 'Enviar pronóstico';
  }

  // ═════════════════════════════════════════════════════════════════════
  //  INTERACCIÓN
  // ═════════════════════════════════════════════════════════════════════

  function conectarEventos() {
    // Un solo escucha para todos los botones: sobrevive a los repintados.
    $('#partidos-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.pick-btn');
      if (!btn || btn.disabled) return;

      const id = btn.dataset.partido;
      const pick = btn.dataset.pick;

      // Tocar el mismo otra vez lo quita: se vale arrepentirse antes de enviar.
      if (S.picks[id] === pick) delete S.picks[id];
      else S.picks[id] = pick;

      store.set('picks-' + S.jornada.id, S.picks);

      const card = btn.closest('.partido');
      card.querySelectorAll('.pick-btn').forEach((b) => {
        const on = S.picks[id] === b.dataset.pick;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on);
      });
      card.classList.toggle('is-picked', !!S.picks[id]);

      renderProgreso();
    });

    $('#nombre-input').addEventListener('input', (e) => {
      store.set('nombre', e.target.value.trim());
      renderProgreso();
    });

    // Ojo: el botón del tema NO se conecta aquí — ya se conectó en boot().
    // Ponerlo en los dos lados lo dejaría muerto: el clic dispararía dos
    // veces, cambiaría el tema y lo regresaría en el mismo instante.
    $('#submit-btn').addEventListener('click', enviar);
    $('#todos-pdf').addEventListener('click', guardarPdfPronosticos);
  }

  // ── Flechitas del menú en celular ────────────────────────────────────
  // Solo se asoman si el menú de verdad no cabe. En una iPhone normal los 4
  // accesos caben completos y las flechas nunca aparecen: una flecha que
  // apunta a la nada es peor que no tenerla.
  function initFlechasMenu() {
    const carril = $('#nav-scroll');
    const nav = $('#nav');
    if (!carril || !nav) return;

    const revisar = () => {
      // 2px de colchón: los navegadores devuelven decimales y sin esto la
      // flecha derecha se queda prendida para siempre al llegar al final.
      const resto = nav.scrollWidth - nav.clientWidth - nav.scrollLeft;
      carril.classList.toggle('hay-izq', nav.scrollLeft > 2);
      carril.classList.toggle('hay-der', resto > 2);
    };

    nav.addEventListener('scroll', revisar, { passive: true });
    addEventListener('resize', revisar);

    // Al tocarlas, arrastran; no son solo un adorno.
    const mover = (dir) => nav.scrollBy({ left: dir * Math.round(nav.clientWidth * .7), behavior: 'smooth' });
    $('#nav-arrow-l').addEventListener('click', () => mover(-1));
    $('#nav-arrow-r').addEventListener('click', () => mover(1));

    revisar();
    setTimeout(revisar, 400);   // tras cargar la tipografía, los anchos cambian
  }

  async function enviar() {
    const btn = $('#submit-btn');
    const nombre = ($('#nombre-input').value || '').trim();

    // Si algo falta, el botón NO se queda mudo: te lleva ahí y te lo señala.
    // La barra vive pegada abajo mientras votas, así que lo que falta puede
    // estar fuera de la pantalla — decir "escribe tu nombre" sin llevarte al
    // campo es dejar a la persona buscándolo a ciegas.
    if (nombre.length < 2) {
      const input = $('#nombre-input');
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => input.focus({ preventScroll: true }), 350);
      toast('Escribe tu nombre aquí arriba para poder enviar.', 'err');
      return;
    }

    const falta = S.partidos.find((p) => !S.picks[p.id]);
    if (falta) {
      const card = document.querySelector(`.partido[data-id="${falta.id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Un parpadeo para que el ojo caiga solo en la tarjeta correcta.
        card.classList.add('is-buscado');
        setTimeout(() => card.classList.remove('is-buscado'), 2000);
      }
      toast(`Te falta pronosticar: ${falta.local} vs ${falta.visitante}.`, 'err');
      return;
    }

    // Puede haber cerrado mientras la persona llenaba la quiniela.
    if (estaCerrada()) {
      toast('La jornada acaba de cerrar. Ya no alcanzó.', 'err');
      return render();
    }

    if (S.solicitud) {
      toast('Tu comprobante ya está en revisión.', 'err');
      return;
    }

    // Los picks se quedan privados en una solicitud hasta que el admin vea
    // el comprobante. No hay ninguna inserción directa a `pronosticos` aquí.
    abrirPagoModal(nombre);
  }

  // ═════════════════════════════════════════════════════════════════════
  //  DEPÓSITO, COMPROBANTE Y SOLICITUD PENDIENTE
  // ═════════════════════════════════════════════════════════════════════

  function textoConfigurado(valor) {
    return typeof valor === 'string' && valor.trim() && !/PON_AQUI/i.test(valor);
  }

  function montoPago() {
    const monto = Number(CFG.PAGO?.monto);
    return Number.isFinite(monto) && monto > 0
      ? monto
      : Number(S.cfg.cuota_bote) + Number(S.cfg.cuota_manejo);
  }

  function pagoConfigurado() {
    const pago = CFG.PAGO || {};
    const destino = pago.cuenta || pago.clabe || pago.tarjeta;
    return textoConfigurado(pago.titular) && textoConfigurado(pago.banco) && textoConfigurado(destino);
  }

  function cuentaPagoHtml() {
    const pago = CFG.PAGO || {};
    const filas = [
      ['Titular', pago.titular],
      ['Banco', pago.banco],
      ['Cuenta', pago.cuenta],
      ['CLABE', pago.clabe],
      ['Tarjeta', pago.tarjeta],
      ['Referencia', pago.referencia]
    ].filter(([, valor]) => textoConfigurado(valor));
    return filas.map(([etiqueta, valor]) =>
      `<div><span>${esc(etiqueta)}</span><b>${esc(valor)}</b></div>`).join('');
  }

  function initPagoModal() {
    const overlay = $('#payment-overlay');
    if (!overlay) return;

    $('#payment-close').addEventListener('click', cerrarPagoModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrarPagoModal(); });
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) cerrarPagoModal();
    });
  }

  function abrirPagoModal(nombre) {
    if (!pagoConfigurado()) {
      toast('Falta configurar los datos de la cuenta de depósito.', 'err');
      return;
    }

    const overlay = $('#payment-overlay');
    const body = $('#payment-body');
    if (!overlay || !body) return;

    body.innerHTML = `
      <span class="eyebrow">Último paso</span>
      <h2 class="display" id="payment-title">Envía tu depósito</h2>
      <p class="payment-lede">Debes depositar antes de que publiquemos tu quiniela. Sube una captura del comprobante y el admin revisará el pago.</p>
      <div class="payment-total"><small>Total a depositar</small><strong>${money(montoPago())}</strong></div>
      <div class="payment-account">${cuentaPagoHtml()}</div>
      <label class="payment-file" id="payment-file-label">
        <input id="payment-file" type="file" accept="image/jpeg,image/png,image/webp" capture="environment">
        <strong id="payment-file-title">Subir captura del comprobante</strong>
        <small id="payment-file-help">JPG, PNG o WEBP · máximo 5 MB. Puedes tomar la foto desde aquí.</small>
      </label>
      <p class="payment-note">Tu pronóstico queda apartado, pero no será visible ni contará en la tabla hasta que el admin confirme el depósito.</p>
      <button class="btn btn-primary btn-lg payment-submit" id="payment-submit" type="button">Enviar comprobante y quiniela</button>`;

    overlay.hidden = false;
    document.body.style.overflow = 'hidden';

    const input = $('#payment-file');
    const label = $('#payment-file-label');
    const title = $('#payment-file-title');
    input.addEventListener('change', () => {
      const archivo = input.files?.[0];
      label.classList.toggle('is-ready', !!archivo);
      title.textContent = archivo ? archivo.name : 'Subir captura del comprobante';
    });

    $('#payment-submit').addEventListener('click', () => enviarSolicitudPago(nombre));
  }

  function cerrarPagoModal() {
    const overlay = $('#payment-overlay');
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
  }

  function datosArchivoComprobante(archivo) {
    const tipos = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp'
    };
    if (tipos[archivo.type]) return { tipo: archivo.type, extension: tipos[archivo.type] };
    const extension = String(archivo.name || '').split('.').pop().toLowerCase();
    const tipo = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[extension];
    return tipo ? { tipo, extension: extension === 'jpeg' ? 'jpeg' : extension } : null;
  }

  async function enviarSolicitudPago(nombre) {
    const input = $('#payment-file');
    const btn = $('#payment-submit');
    const archivo = input?.files?.[0];
    const datosArchivo = archivo && datosArchivoComprobante(archivo);

    if (!archivo || !datosArchivo) {
      toast('Sube una captura JPG, PNG o WEBP del depósito.', 'err');
      return;
    }
    if (archivo.size > 5 * 1024 * 1024) {
      toast('La captura pesa más de 5 MB. Súbela un poco más ligera.', 'err');
      return;
    }

    const solicitudId = window.crypto?.randomUUID?.()
      || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.floor(Math.random() * 16);
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    const ruta = `pendientes/${S.jornada.id}/${solicitudId}.${datosArchivo.extension}`;
    const picks = S.partidos.map((p) => ({ partido_id: Number(p.id), pick: S.picks[p.id] }));

    S.enviando = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
    renderProgreso();

    try {
      const { error: errorArchivo } = await S.sb.storage.from('comprobantes-pago')
        .upload(ruta, archivo, { cacheControl: '3600', upsert: false, contentType: datosArchivo.tipo });
      if (errorArchivo) throw errorArchivo;

      const { error: errorSolicitud } = await S.sb.from('solicitudes_quiniela').insert({
        id: solicitudId,
        jornada_id: S.jornada.id,
        nombre,
        slug: slugify(nombre),
        picks,
        comprobante_path: ruta
      });
      if (errorSolicitud) {
        if (errorSolicitud.code === '23505') {
          throw new Error('Ya existe una solicitud para este nombre en esta jornada.');
        }
        throw errorSolicitud;
      }

      S.solicitud = { id: solicitudId, slug: slugify(nombre), creado_at: new Date().toISOString() };
      store.set('solicitud-' + S.jornada.id, S.solicitud);
      store.set('nombre', nombre);
      cerrarPagoModal();
      toast('Comprobante enviado. Tu quiniela se publicará al confirmar el depósito.', 'ok');
      render();
      $('#jugar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error(err);
      toast(err.message || 'No se pudo enviar el comprobante. Revisa tu internet e inténtalo otra vez.', 'err');
    } finally {
      S.enviando = false;
      if (!S.solicitud) renderProgreso();
    }
  }

  // Busca a la persona por su slug; si no existe, la da de alta.
  async function obtenerParticipante(nombre) {
    const slug = slugify(nombre);

    const { data: existente } = await S.sb.from('participantes')
      .select('id').eq('slug', slug).maybeSingle();
    if (existente) return existente.id;

    const { data, error } = await S.sb.from('participantes')
      .insert({ nombre, slug }).select('id').single();

    if (error) {
      // Si dos personas con el mismo nombre entran al mismo tiempo, una de
      // las dos choca con el índice único. No es un fallo: es que la otra
      // ya la creó. La volvemos a buscar y seguimos.
      if (error.code === '23505') {
        const { data: r } = await S.sb.from('participantes')
          .select('id').eq('slug', slug).single();
        return r.id;
      }
      throw error;
    }
    return data.id;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  MODAL DEL GANADOR DE LA JORNADA
  // ═════════════════════════════════════════════════════════════════════
  //
  //  Sale solo cuando una jornada termina, con bombo y platillo, felicitando
  //  a quien ganó. Vive en el hueco entre jornadas y se retira solo unas horas
  //  antes de que arranque la siguiente (VENTANA_POPUP_MS). También se abre a
  //  mano tocando cualquier tarjeta del "Salón de la fama".

  const ICO_TROFEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4.5a2.5 2.5 0 0 0 3 4.4M17 6h2.5a2.5 2.5 0 0 1-3 4.4"/><path d="M9.5 13.5 9 17h6l-.5-3.5M8 20h8M10 17v3M14 17v3"/></svg>';

  function initGanadorModal() {
    const overlay = $('#winner-overlay');
    if (!overlay) return;

    $('#winner-close').addEventListener('click', () => cerrarGanadorModal(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrarGanadorModal(true); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) cerrarGanadorModal(true); });

    // Abrir a mano desde el Salón de la fama.
    const lista = $('#ganadores-list');
    if (lista) {
      const abrirDeTarjeta = (card) => {
        const id = card && card.dataset.jornada;
        if (!id) return;
        const it = S.historial.find((x) => String(x.jornada.id) === String(id));
        if (it && it.lideres.length) abrirGanadorModal(it, false);
      };
      lista.addEventListener('click', (e) => abrirDeTarjeta(e.target.closest('.gan-card')));
      lista.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          const card = e.target.closest('.gan-card');
          if (card) { e.preventDefault(); abrirDeTarjeta(card); }
        }
      });
    }
  }

  // El botón "Ver qué pronosticó cada quien" de cada jornada del histórico:
  // trae los pronósticos (a demanda, en caché) y pinta la rejilla de escudos
  // con sus aciertos y fallos. Así cualquiera ve por qué ganó uno y por qué
  // perdieron los demás. Delegado, sobrevive a los repintados.
  function initHistorico() {
    const lista = $('#historico-list');
    if (!lista) return;

    lista.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-verpicks]');
      if (!btn) return;

      const id = btn.dataset.verpicks;
      const cont = btn.closest('.hist-picks');
      cont.innerHTML = '<div class="empty">Cargando pronósticos…</div>';

      try {
        const it = S.historial.find((x) => String(x.jornada.id) === String(id));
        const rows = await cargarPicksJornada(id);
        const grid = htmlGridPicks(rows, it ? it.partidos : []);
        cont.innerHTML = grid
          ? `<div class="todos-grid">${grid}</div>`
          : '<div class="empty">Nadie pronosticó esta jornada.</div>';
      } catch (err) {
        cont.innerHTML = `<div class="empty">No se pudieron cargar los pronósticos.
          <button class="hist-ver-picks" type="button" data-verpicks="${esc(id)}">Reintentar</button></div>`;
      }
    });
  }

  // Los pronósticos del o los ganadores, en escudos verdes/rojos: el "por qué
  // ganó" hecho imagen. Se inyecta en el modal cuando llegan los datos.
  function htmlPicksGanadores(lideres, rows, partidos) {
    const porId = Object.fromEntries(partidos.map((p) => [p.id, p]));
    const orden = Object.fromEntries(partidos.map((p, i) => [p.id, i]));

    const porPersona = new Map();
    (rows || []).forEach((r) => {
      if (!porPersona.has(r.participante_id)) porPersona.set(r.participante_id, []);
      porPersona.get(r.participante_id).push(r);
    });

    const bloques = lideres.map((l) => {
      const picks = (porPersona.get(l.participante_id) || []).slice()
        .sort((a, b) => (orden[a.partido_id] ?? 99) - (orden[b.partido_id] ?? 99));
      if (!picks.length) return '';
      const chips = picks.map((p) => chipPick(p.pick, porId[p.partido_id])).join('');
      return `
        <div class="win-picks-persona">
          ${lideres.length > 1 ? `<span class="win-picks-nombre">${esc(l.nombre)}</span>` : ''}
          <div class="todo-picks">${chips}</div>
        </div>`;
    }).join('');

    if (!bloques) return '';
    return `<div class="win-picks-label">${lideres.length > 1 ? 'Así les fue' : 'Así le fue'} · sus aciertos y fallos</div>${bloques}`;
  }

  // Decide si toca sacar el popup solo. Se llama al cargar y en cada sondeo.
  //   · Si la jornada que se está viendo ACABA de terminar (todos los partidos
  //     terminados), la felicitamos al instante.
  //   · Si no, y hay una jornada finalizada reciente, mostramos su ganador
  //     hasta unas horas antes de que arranque la próxima.
  function revisarGanadorPopup() {
    const overlay = $('#winner-overlay');
    if (!overlay || !overlay.hidden) return;   // ya está abierto: no reabrir

    const terminada = S.partidos.length > 0 && S.partidos.every((p) => p.estado === 'terminado');

    let item = null;
    if (terminada) {
      item = { jornada: S.jornada, ...resumenGanador(S.tabla) };
    } else if (S.historial[0]) {
      item = S.historial[0];
    }
    if (!item || !item.lideres.length) return;

    // ¿El usuario ya la cerró? No lo volvemos a molestar por esa jornada.
    if (store.get('winmodal-visto-' + item.jornada.id, false)) return;

    // Ventana de tiempo: si ya hay una PRÓXIMA jornada distinta, escondemos el
    // popup unas horas antes de que arranque. Si la que ganó es la misma que se
    // ve (terminó apenas, aún no hay siguiente), no hay corte: se muestra ya.
    const prox = (S.jornada && S.jornada.id !== item.jornada.id
      && S.jornada.estado !== 'finalizada') ? S.jornada : null;
    if (prox && prox.cierra_at) {
      const limite = new Date(prox.cierra_at).getTime() - VENTANA_POPUP_MS;
      if (Date.now() >= limite) return;
    }

    abrirGanadorModal(item, true);
  }

  function abrirGanadorModal(item, auto) {
    const overlay = $('#winner-overlay');
    const body = $('#winner-body');
    if (!overlay || !body) return;

    const j = item.jornada;
    const varios = item.lideres.length > 1;
    const nombre = nombresLideres(item.lideres);

    const listaVarios = varios
      ? `<ul class="win-empatados">${item.lideres.map((l) =>
          `<li><span class="avatar">${esc(iniciales(l.nombre))}</span>${esc(l.nombre)}</li>`).join('')}</ul>`
      : '';

    body.innerHTML = `
      <div class="win-drums" aria-hidden="true">🥁🎉🥁</div>
      <span class="win-trofeo" aria-hidden="true">${ICO_TROFEO}</span>
      <span class="win-eyebrow">Jornada ${esc(j.numero)} · terminada</span>
      <h2 class="win-title" id="winner-title">${varios ? '¡Empate en la cima!' : '¡Tenemos ganador!'}</h2>
      <p class="win-felicidades">${varios
        ? 'Se reparten el bote a partes iguales. ¡Muchas felicidades!'
        : '¡Muchas felicidades! Se lució esta jornada. 🎊'}</p>

      <div class="win-nombre">${esc(nombre)}</div>
      ${listaVarios}

      <div class="win-stats">
        <div class="win-stat">
          <b>${item.top}<small>/${item.jugados}</small></b>
          <span>Aciertos</span>
        </div>
        <div class="win-stat is-premio">
          <b>${money(item.reparto)}</b>
          <span>${varios ? 'C/u del bote' : 'Se lleva'}</span>
        </div>
        <div class="win-stat">
          <b>${item.gente}</b>
          <span>${item.gente === 1 ? 'Jugador' : 'Jugadores'}</span>
        </div>
      </div>

      <p class="win-bote">Bote total de la jornada: <b>${money(item.bote)}</b></p>

      <div class="win-picks" id="winner-picks">
        <div class="win-picks-load">Cargando sus pronósticos…</div>
      </div>

      <button class="btn btn-primary btn-lg win-ok" id="winner-ok" type="button">¡Que siga la fiesta!</button>`;

    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    $('#winner-ok').addEventListener('click', () => cerrarGanadorModal(auto), { once: true });

    // Los escudos por los que votó el ganador — el "por qué ganó". Si la jornada
    // es la que se ve en vivo, ya tenemos sus picks en S.todos; si es una del
    // histórico, los traemos a demanda. Se inyectan cuando lleguen.
    const partidosMod = (item.partidos && item.partidos.length) ? item.partidos : S.partidos;
    const picksReady = (item.partidos && item.partidos.length)
      ? cargarPicksJornada(item.jornada.id)
      : Promise.resolve(S.todos);

    picksReady.then((rows) => {
      const cont = document.getElementById('winner-picks');
      if (!cont) return;   // lo cerraron antes de que llegara
      const html = htmlPicksGanadores(item.lideres, rows, partidosMod);
      if (html) cont.innerHTML = html;
      else cont.remove();
    }).catch(() => {
      const cont = document.getElementById('winner-picks');
      if (cont) cont.remove();
    });

    // Recordamos cuál jornada se está mostrando, para marcarla como vista al cerrar.
    overlay.dataset.jornada = j.id;
    overlay.dataset.auto = auto ? '1' : '0';

    lanzarConfetti();
  }

  function cerrarGanadorModal(marcarVisto) {
    const overlay = $('#winner-overlay');
    if (!overlay || overlay.hidden) return;

    // Al cerrar un popup automático, lo damos por visto: no vuelve a salir solo
    // por esa jornada (pero sí se puede reabrir desde el Salón de la fama).
    if (marcarVisto && overlay.dataset.auto === '1' && overlay.dataset.jornada) {
      store.set('winmodal-visto-' + overlay.dataset.jornada, true);
    }

    overlay.hidden = true;
    document.body.style.overflow = '';
    const conf = $('#winner-confetti');
    if (conf) conf.innerHTML = '';
  }

  // Confeti puro CSS: soltamos un montón de papelitos con posición, color,
  // giro y demora al azar. Se limpian solos al cerrar el modal.
  function lanzarConfetti() {
    const cont = $('#winner-confetti');
    if (!cont) return;
    cont.innerHTML = '';

    const colores = ['var(--accent)', 'var(--accent-2)', '#ffd60a', '#ff6b6b', '#c77dff', '#ffffff'];
    const total = 64;
    let html = '';
    for (let i = 0; i < total; i++) {
      const izq = Math.random() * 100;
      const demora = (Math.random() * 2.6).toFixed(2);
      const dur = (2.6 + Math.random() * 2.4).toFixed(2);
      const color = colores[i % colores.length];
      const giro = Math.round(Math.random() * 360);
      const w = 6 + Math.round(Math.random() * 6);
      const redondo = Math.random() > 0.7 ? '50%' : '2px';
      html += `<i style="left:${izq}%;background:${color};width:${w}px;height:${w + 4}px;
        border-radius:${redondo};transform:rotate(${giro}deg);
        animation-delay:${demora}s;animation-duration:${dur}s"></i>`;
    }
    cont.innerHTML = html;
  }

  // ═════════════════════════════════════════════════════════════════════
  //  RELOJ Y SONDEO
  // ═════════════════════════════════════════════════════════════════════

  function arrancarReloj() {
    const tick = () => {
      const nota = $('#cd-note');
      const tag = $('#cierre-tag');

      if (!S.jornada.cierra_at) {
        $('#countdown').style.display = 'none';
        nota.textContent = 'El horario de cierre se define cuando la Liga MX publique el calendario.';
        tag.textContent = 'Por definir';
        return;
      }

      const falta = new Date(S.jornada.cierra_at) - new Date();

      if (falta <= 0) {
        ['#cd-d', '#cd-h', '#cd-m', '#cd-s'].forEach((s) => { $(s).textContent = '0'; });
        tag.textContent = 'Cerrada';
        tag.classList.add('is-live');
        nota.textContent = 'Los pronósticos de esta jornada ya se cerraron.';
        return;
      }

      const seg = Math.floor(falta / 1000);
      $('#cd-d').textContent = Math.floor(seg / 86400);
      $('#cd-h').textContent = String(Math.floor(seg % 86400 / 3600)).padStart(2, '0');
      $('#cd-m').textContent = String(Math.floor(seg % 3600 / 60)).padStart(2, '0');
      $('#cd-s').textContent = String(seg % 60).padStart(2, '0');

      tag.textContent = 'Abierta';
      tag.classList.remove('is-live');
    };

    tick();
    S.timer = setInterval(tick, 1000);
  }

  // Cada 30 s traemos marcadores y tabla. Si la pestaña está escondida no
  // gastamos: la gente deja la quiniela abierta en segundo plano por horas.
  function arrancarSondeo() {
    setInterval(async () => {
      if (document.hidden) return;
      try {
        await Promise.all([cargarPartidos(), cargarTabla(), cargarTodos(), cargarPosiciones()]);
        renderCabecera();
        renderBote();
        renderEnVivo();
        renderTabla();
        renderTodos();
        renderPosiciones();
        // Si la jornada acaba de terminar justo mientras miraban en vivo,
        // este es el momento de sacar la felicitación.
        revisarGanadorPopup();
      } catch (e) { /* si falla un sondeo, no pasa nada: al rato vuelve */ }
    }, 30000);

    // Al volver a la pestaña, refresca de inmediato en vez de esperar.
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) return;
      try {
        await Promise.all([cargarPartidos(), cargarTabla()]);
        renderCabecera(); renderBote(); renderEnVivo(); renderTabla();
      } catch (e) { }
    });
  }

  // ═════════════════════════════════════════════════════════════════════
  //  TEMA
  // ═════════════════════════════════════════════════════════════════════

  // El tema de casa es el CLARO. A propósito no le hacemos caso al modo
  // oscuro del sistema: quien quiera oscuro lo elige con el botón y se le
  // respeta para siempre. Así la quiniela se ve igual para todos la primera
  // vez que la abren y todos hablan de la misma página.
  function initTema() {
    let t = null;
    try { t = localStorage.getItem('qmx-theme'); } catch { }
    if (t !== 'dark' && t !== 'light') t = 'light';
    document.documentElement.setAttribute('data-theme', t);
    pintarThemeColor(t);
  }

  function toggleTema() {
    const root = document.documentElement;
    const nuevo = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';

    // Ver el comentario de .theme-switching en styles.css: el candado evita
    // que los colores de media página morfeen cada uno por su lado.
    //
    // Los tres pasos van pegados a propósito. Leer offsetHeight obliga al
    // navegador a recalcular los estilos AHÍ MISMO, con las transiciones ya
    // apagadas: para cuando quitamos la clase, los colores nuevos ya están
    // puestos y no queda nada que transicionar. Todo síncrono, sin esperar
    // frames ni temporizadores — si algo de eso no llegara a correr, la
    // clase se quedaría pegada y mataría las animaciones de toda la página.
    root.classList.add('theme-switching');
    root.setAttribute('data-theme', nuevo);
    void document.body.offsetHeight;
    root.classList.remove('theme-switching');

    try { localStorage.setItem('qmx-theme', nuevo); } catch { }
    pintarThemeColor(nuevo);
  }

  function pintarThemeColor(t) {
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'dark' ? '#08080a' : '#f2f2f5');
  }

  // ═════════════════════════════════════════════════════════════════════
  //  PANEL DE ADMIN
  // ═════════════════════════════════════════════════════════════════════
  //
  //  Se abre con  #admin  al final de la URL. Que se abra no da permisos:
  //  el candado está en la base (ver schema-admin.sql). Aunque alguien más
  //  llegue a esta pantalla, cada escritura la rechaza el servidor. Esto de
  //  aquí solo evita que el panel le estorbe a la vista de los jugadores.
  //
  //  Usa la MISMA llave anon que todos: la service_role nunca toca el
  //  navegador. Lo que te identifica es tu correo, firmado por Supabase.

  // Sugerencias, no camisa de fuerza: casi ningún partido va por un solo
  // canal ("Canal 5, TUDN, ViX" es lo normal), así que el campo es de texto
  // libre y esta lista solo autocompleta.
  const CANALES = ['FOX Sports', 'Canal 5', 'Azteca 7', 'TUDN', 'ViX', 'ESPN',
    'Disney+', 'Prime Video', 'Caliente TV', 'Claro Sports',
    'Canal 5, TUDN, ViX', 'Azteca 7, FOX Sports', 'ESPN, Disney+, ViX'];

  const ICO_BOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>';

  async function initAdmin() {
    const overlay = $('#admin-overlay');
    if (!overlay) return;

    const abrir = () => {
      overlay.hidden = false;
      document.documentElement.classList.add('admin-open');
      document.body.classList.add('admin-open');
      pintarAdmin();
    };
    const cerrar = () => {
      overlay.hidden = true;
      document.documentElement.classList.remove('admin-open');
      document.body.classList.remove('admin-open');
      if (location.hash.startsWith('#admin')) {
        history.replaceState(null, '', location.pathname + location.search);
      }
    };

    $('#admin-close').addEventListener('click', cerrar);
    $('#admin-salir').addEventListener('click', salirAdmin);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrar(); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) cerrar(); });
    addEventListener('hashchange', () => { if (location.hash === '#admin') abrir(); });

    // Supabase avisa en cuanto una sesión con contraseña queda lista. Volvemos
    // a pintar para que el permiso se compruebe del lado de la base.
    S.sb.auth.onAuthStateChange(() => { if (!overlay.hidden) pintarAdmin(); });

    if (location.hash === '#admin') abrir();
  }

  async function pintarAdmin() {
    const body = $('#admin-body');
    body.innerHTML = '<div class="empty">Cargando…</div>';

    const { data: { session } } = await S.sb.auth.getSession();
    const sesion = $('#admin-session');
    if (sesion) sesion.textContent = session?.user?.email || 'Sin sesión iniciada';

    if (!session) return pintarLogin(body);

    // ¿Este correo manda? Lo decide la base, no nosotros.
    const { data: esAdmin, error } = await S.sb.rpc('es_admin');

    if (error) {
      body.innerHTML = `<div class="alert is-err">No se pudo comprobar el permiso.
        ¿Ya corriste <code>schema-admin.sql</code>? (${esc(error.message)})</div>`;
      return;
    }

    if (!esAdmin) {
      body.innerHTML = `
        <div class="alert is-err"><b>Esta cuenta no es de administrador.</b>
          Entraste como ${esc(session.user.email)}, pero ese correo no está en la lista.</div>
        <div class="admin-quien">
          <span>Sesión: ${esc(session.user.email)}</span>
          <button class="admin-salir" id="admin-salir" type="button">Salir</button>
        </div>`;
      $('#admin-salir').addEventListener('click', salirAdmin);
      return;
    }

    await pintarDashboardAdmin(body, session);
  }

  function pintarLogin(body) {
    const admin = CFG.ADMIN_LOGIN || {};
    if (!textoConfigurado(admin.usuario) || !textoConfigurado(admin.email)) {
      body.innerHTML = `<div class="alert is-err"><b>Falta configurar el acceso.</b>
        Abre <code>config.js</code> y escribe el correo real del admin en
        <code>ADMIN_LOGIN.email</code>. La contraseña se establece en Supabase Auth.</div>`;
      return;
    }

    body.innerHTML = `
      <div class="admin-login">
        <p>Acceso privado del administrador.</p>
        <input id="admin-user" type="text" placeholder="Usuario"
               autocomplete="username" autocapitalize="none" spellcheck="false">
        <input id="admin-password" type="password" placeholder="Contraseña"
               autocomplete="current-password">
        <button class="btn btn-primary btn-lg" id="admin-enviar" type="button"
                style="width:100%">Entrar al dashboard</button>
      </div>`;

    const input = $('#admin-user');
    const password = $('#admin-password');
    const btn = $('#admin-enviar');
    input.value = store.get('admin-user', admin.usuario);

    const entrar = async () => {
      const usuario = (input.value || '').trim().toLowerCase();
      const esperado = String(admin.usuario).trim().toLowerCase();
      if (usuario !== esperado) return toast('Usuario o contraseña incorrectos.', 'err');
      if (!password.value) return toast('Escribe la contraseña.', 'err');

      btn.disabled = true; btn.textContent = 'Entrando…';
      const { error } = await S.sb.auth.signInWithPassword({
        email: String(admin.email).trim().toLowerCase(),
        password: password.value
      });

      if (error) {
        btn.disabled = false; btn.textContent = 'Entrar al dashboard';
        return toast('Usuario o contraseña incorrectos.', 'err');
      }

      store.set('admin-user', usuario);
      await pintarAdmin();
    };

    btn.addEventListener('click', entrar);
    [input, password].forEach((el) => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') entrar();
    }));
  }

  async function cargarSolicitudesAdmin() {
    const { data, error } = await S.sb.from('solicitudes_quiniela')
      .select('id, nombre, picks, comprobante_path, creado_at')
      .eq('jornada_id', S.jornada.id)
      .eq('estado', 'pendiente')
      .order('creado_at', { ascending: true });
    if (error) throw error;

    const solicitudes = data || [];
    const rutas = solicitudes.map((s) => s.comprobante_path).filter(Boolean);
    if (!rutas.length) return solicitudes;

    const { data: urls, error: errorUrls } = await S.sb.storage
      .from('comprobantes-pago').createSignedUrls(rutas, 60 * 30);
    if (errorUrls) throw errorUrls;

    const porRuta = Object.fromEntries((urls || []).map((u) => [u.path, u.signedUrl]));
    return solicitudes.map((s) => ({ ...s, comprobante_url: porRuta[s.comprobante_path] || '' }));
  }

  function fechaAdmin(iso) {
    const fecha = new Date(iso);
    if (isNaN(fecha)) return 'Fecha no disponible';
    return fecha.toLocaleString('es-MX', {
      timeZone: 'America/Mexico_City', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit'
    });
  }

  // La vista del admin no usa letras sueltas: cada pick muestra el equipo y
  // su escudo para que revisar nueve partidos sea rapido y sin ambiguedades.
  function picksAdmin(picks) {
    const porId = Object.fromEntries(S.partidos.map((p) => [String(p.id), p]));
    const orden = Object.fromEntries(S.partidos.map((p, i) => [String(p.id), i]));
    const listos = (Array.isArray(picks) ? picks : [])
      .filter((item) => item && porId[String(item.partido_id)] && ['L', 'E', 'V'].includes(item.pick))
      .sort((a, b) => (orden[String(a.partido_id)] ?? 99) - (orden[String(b.partido_id)] ?? 99));

    if (!listos.length) return '<span class="admin-no-picks">Sin picks legibles.</span>';

    const logo = (url, nombre) => url
      ? `<img src="${esc(url)}" alt="${esc(nombre)}" loading="lazy">`
      : `<b>${esc(String(nombre).slice(0, 3).toUpperCase())}</b>`;

    return listos.map((item) => {
      const partido = porId[String(item.partido_id)];
      const etiqueta = `${partido.local} vs ${partido.visitante}`;
      if (item.pick === 'E') {
        return `<span class="admin-pick is-draw" title="${esc(etiqueta)}: Empate">
          ${logo(partido.local_logo, partido.local)}<i>Empate</i>${logo(partido.visitante_logo, partido.visitante)}
        </span>`;
      }
      const equipo = item.pick === 'L' ? partido.local : partido.visitante;
      const imagen = item.pick === 'L' ? partido.local_logo : partido.visitante_logo;
      return `<span class="admin-pick" title="${esc(etiqueta)}: Gana ${esc(equipo)}">
        ${logo(imagen, equipo)}<i>${esc(equipo)}</i>
      </span>`;
    }).join('');
  }

  function quinielasPublicadasAdmin() {
    const porPersona = new Map();
    (S.todos || []).forEach((row) => {
      const id = row.participante_id;
      const nombre = row.participantes?.nombre || 'Sin nombre';
      const llave = id == null ? `nombre:${nombre}` : `id:${id}`;
      if (!porPersona.has(llave)) porPersona.set(llave, { id, nombre, picks: [] });
      porPersona.get(llave).picks.push(row);
    });
    return [...porPersona.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  async function pintarDashboardAdmin(body, session) {
    let solicitudes;
    try {
      solicitudes = await cargarSolicitudesAdmin();
    } catch (err) {
      body.innerHTML = `<div class="alert is-err"><b>No se pudieron cargar los comprobantes.</b>
        Ejecuta <code>migracion-pagos-pendientes.sql</code> en Supabase. (${esc(err.message)})</div>`;
      return;
    }

    const sesion = $('#admin-session');
    if (sesion) sesion.textContent = session.user.email || 'Sesión privada';

    const publicadas = quinielasPublicadasAdmin();
    const cuota = montoPago();
    const bote = publicadas.length * Number(S.cfg.cuota_bote || 0);
    const cobrado = publicadas.filter((p) => S.pagos[p.id]).length * cuota;
    const sugerenciasTv = CANALES.map((c) => `<option value="${esc(c)}"></option>`).join('');

    const tarjetaSolicitud = (s) => {
      const comprobante = s.comprobante_url
        ? `<a class="admin-proof" href="${esc(s.comprobante_url)}" target="_blank" rel="noopener noreferrer" title="Abrir comprobante completo">
            <img src="${esc(s.comprobante_url)}" alt="Comprobante de ${esc(s.nombre)}"></a>`
        : '<div class="admin-proof admin-proof-empty">No se pudo abrir la captura.</div>';
      return `<article class="admin-review-card">
        ${comprobante}
        <div class="admin-review-main">
          <div class="admin-card-top">
            <div class="admin-player"><span class="avatar">${esc(iniciales(s.nombre))}</span><div><h4>${esc(s.nombre)}</h4><p>Comprobante recibido ${esc(fechaAdmin(s.creado_at))}</p></div></div>
            <span class="admin-status is-pending">Por revisar</span>
          </div>
          <div class="admin-picks" aria-label="Picks de ${esc(s.nombre)}">${picksAdmin(s.picks)}</div>
          <div class="admin-actions">
            <button class="btn admin-secondary" type="button" data-rechazar="${esc(s.id)}" data-nombre="${esc(s.nombre)}">Rechazar solicitud</button>
            <button class="btn btn-primary" type="button" data-publicar="${esc(s.id)}">Aprobar depósito y publicar</button>
          </div>
        </div>
      </article>`;
    };

    const tarjetaQuiniela = (persona) => {
      const pagado = Boolean(S.pagos[persona.id]);
      const eliminar = persona.id == null ? '' : `<button class="admin-danger" type="button" data-eliminar="${esc(persona.id)}" data-nombre="${esc(persona.nombre)}">Eliminar quiniela</button>`;
      return `<article class="admin-quiniela-card">
        <div class="admin-card-top">
          <div class="admin-player"><span class="avatar">${esc(iniciales(persona.nombre))}</span><div><h4>${esc(persona.nombre)}</h4><p>${persona.picks.length} de ${S.partidos.length} pronósticos publicados</p></div></div>
          <span class="admin-status ${pagado ? 'is-approved' : 'is-unpaid'}">${pagado ? 'Depósito aprobado' : 'Sin marcar pago'}</span>
        </div>
        <div class="admin-picks" aria-label="Picks de ${esc(persona.nombre)}">${picksAdmin(persona.picks)}</div>
        <div class="admin-actions admin-actions-bottom">
          ${persona.id == null ? '' : `<button class="admin-link-action" type="button" data-pago="${esc(persona.id)}">${pagado ? 'Marcar como no pagado' : 'Marcar como pagado'}</button>`}
          ${eliminar}
        </div>
      </article>`;
    };

    const tarjetaPartido = (p) => {
      const boton = (valor, texto) => `<button class="adm-res${p.resultado === valor ? ' is-on' : ''}" type="button" data-res="${valor}" data-id="${p.id}">${esc(texto)}</button>`;
      return `<article class="adm-partido${p.manual ? ' es-manual' : ''}">
        <div class="adm-cab"><span>${esc(p.local)} vs ${esc(p.visitante)}</span><small>${esc(fechaCorta(p.fecha))}</small>${p.manual ? '<span class="adm-tag">manual</span>' : ''}</div>
        <div class="adm-fila"><span class="adm-mini">Resultado</span>${boton('L', 'Gana ' + (p.local_abbr || p.local))}${boton('E', 'Empate')}${boton('V', 'Gana ' + (p.visitante_abbr || p.visitante))}${p.manual ? `<button class="adm-res" type="button" data-auto="${p.id}">Automático</button>` : ''}</div>
        <div class="adm-fila"><span class="adm-mini">Dónde ver</span><input class="adm-tv" data-tv="${p.id}" list="canales-lista" type="text" value="${esc(p.tv || '')}" placeholder="Ej. Canal 5, TUDN, ViX" spellcheck="false"></div>
      </article>`;
    };

    body.innerHTML = `
      <datalist id="canales-lista">${sugerenciasTv}</datalist>
      <section class="admin-summary" id="admin-resumen">
        <div class="admin-summary-copy"><span class="eyebrow">Jornada ${esc(S.jornada?.numero ?? '')}</span><h3 class="display">Todo bajo control.</h3><p>Revisa primero los depósitos. Solo después de aprobarlos se publica la quiniela de cada persona.</p></div>
        <div class="admin-kpis">
          <article class="admin-kpi"><span>Por revisar</span><strong>${solicitudes.length}</strong><small>depósitos pendientes</small></article>
          <article class="admin-kpi"><span>Publicadas</span><strong>${publicadas.length}</strong><small>quinielas activas</small></article>
          <article class="admin-kpi"><span>Recaudado</span><strong>${money(cobrado)}</strong><small>de ${money(cuota)} c/u</small></article>
          <article class="admin-kpi"><span>Bote actual</span><strong>${money(bote)}</strong><small>solo cuota de bote</small></article>
        </div>
      </section>

      <section class="admin-section" id="admin-depositos">
        <div class="admin-section-head"><div><span class="eyebrow">Acción requerida</span><h3>Depósitos por revisar</h3><p>Abre la captura, compara el depósito y aprueba para publicar sus picks.</p></div><span class="admin-count">${solicitudes.length}</span></div>
        <div class="admin-review-list">${solicitudes.map(tarjetaSolicitud).join('') || '<div class="admin-empty"><b>No hay depósitos pendientes.</b><span>Cuando alguien suba su comprobante aparecerá aquí.</span></div>'}</div>
      </section>

      <section class="admin-section" id="admin-quinielas">
        <div class="admin-section-head"><div><span class="eyebrow">Quinielas visibles</span><h3>Pronósticos publicados</h3><p>Aquí ves exactamente los equipos elegidos por cada jugador. Eliminar solo quita su quiniela de esta jornada.</p></div><span class="admin-count">${publicadas.length}</span></div>
        <div class="admin-quinielas-grid">${publicadas.map(tarjetaQuiniela).join('') || '<div class="admin-empty"><b>Aún no hay quinielas publicadas.</b><span>Aprueba un depósito para que aparezca la primera.</span></div>'}</div>
      </section>

      <section class="admin-section" id="admin-resultados">
        <div class="admin-section-head"><div><span class="eyebrow">Control de jornada</span><h3>Resultados y transmisiones</h3><p>ESPN actualiza los marcadores. Usa una corrección manual solo cuando haga falta.</p></div></div>
        <div class="admin-results-grid">${S.partidos.map(tarjetaPartido).join('') || '<div class="admin-empty">Sin partidos cargados.</div>'}</div>
      </section>`;

    conectarAdmin(body);
  }

  async function pintarHerramientasLegacy(body, session) {
    let solicitudes;
    try {
      solicitudes = await cargarSolicitudesAdmin();
    } catch (err) {
      body.innerHTML = `<div class="alert is-err"><b>No se pudieron cargar los comprobantes.</b>
        ¿Ya ejecutaste <code>migracion-pagos-pendientes.sql</code>? (${esc(err.message)})</div>`;
      return;
    }

    const partidos = S.partidos;

    const sugerenciasTv = CANALES.map((c) => `<option value="${esc(c)}"></option>`).join('');

    const filaPartido = (p) => {
      const btnRes = (val, txt) => `
        <button class="adm-res${p.resultado === val ? ' is-on' : ''}" type="button"
                data-res="${val}" data-id="${p.id}">${esc(txt)}</button>`;

      return `
        <div class="adm-partido${p.manual ? ' es-manual' : ''}" data-id="${p.id}">
          <div class="adm-cab">
            <span>${esc(p.local)} vs ${esc(p.visitante)}</span>
            <small>${esc(fechaCorta(p.fecha))}</small>
            ${p.estado !== 'programado'
              ? `<small>· ${p.goles_local ?? 0}-${p.goles_visitante ?? 0} ${esc(p.minuto || '')}</small>` : ''}
            ${p.manual ? '<span class="adm-tag">a mano</span>' : ''}
          </div>

          <div class="adm-fila">
            <span class="adm-mini">Resultado</span>
            ${btnRes('L', 'Gana ' + (p.local_abbr || p.local))}
            ${btnRes('E', 'Empate')}
            ${btnRes('V', 'Gana ' + (p.visitante_abbr || p.visitante))}
            ${p.manual ? `<button class="adm-res" type="button" data-auto="${p.id}">Volver a automático</button>` : ''}
          </div>

          <div class="adm-fila">
            <span class="adm-mini">Dónde ver</span>
            <input class="adm-tv" data-tv="${p.id}" list="canales-lista" type="text"
                   value="${esc(p.tv || '')}" placeholder="Ej. Canal 5, TUDN, ViX"
                   spellcheck="false">
          </div>
        </div>`;
    };

    const filaPersona = (r) => `
      <div class="adm-persona" data-persona="${r.participante_id}">
        <span class="avatar">${esc(iniciales(r.nombre))}</span>
        <span class="adm-persona-nombre">${esc(r.nombre)}</span>
        <button class="adm-pago${S.pagos[r.participante_id] ? ' is-on' : ''}" type="button"
                data-pago="${r.participante_id}">${S.pagos[r.participante_id] ? '✓ Pagó' : 'Sin pagar'}</button>
        <button class="adm-borrar" type="button" data-borrar="${r.participante_id}"
                data-nombre="${esc(r.nombre)}" title="Borrar a esta persona">${ICO_BOTE}</button>
      </div>`;

    const filaSolicitud = (s) => {
      const comprobante = s.comprobante_url
        ? `<a class="adm-proof" href="${esc(s.comprobante_url)}" target="_blank" rel="noopener noreferrer" title="Abrir comprobante completo">
            <img src="${esc(s.comprobante_url)}" alt="Comprobante de ${esc(s.nombre)}"></a>`
        : '<div class="adm-proof adm-proof-empty">No se pudo abrir la captura.</div>';
      const fecha = new Date(s.creado_at);
      const cuando = isNaN(fecha) ? '' : fecha.toLocaleString('es-MX', {
        timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      const cantidad = Array.isArray(s.picks) ? s.picks.length : 0;
      return `
        <article class="adm-solicitud">
          ${comprobante}
          <div class="adm-solicitud-copy">
            <h4>${esc(s.nombre)}</h4>
            <p>${cantidad} picks listos · comprobante recibido ${esc(cuando)}</p>
            <button class="btn btn-primary adm-publicar" type="button" data-publicar="${esc(s.id)}">
              Confirmar depósito y publicar
            </button>
          </div>
        </article>`;
    };

    body.innerHTML = `
      <datalist id="canales-lista">${sugerenciasTv}</datalist>

      <div class="admin-seccion">
        <h3>Depósitos por revisar · ${solicitudes.length}</h3>
        <p>Abre la captura, confirma que llegó el depósito y publica. Hasta entonces sus picks no aparecen para nadie.</p>
        ${solicitudes.map(filaSolicitud).join('') || '<div class="empty">No hay depósitos pendientes.</div>'}
      </div>

      <div class="admin-seccion">
        <h3>Resultados</h3>
        <p>Los marcadores se cargan solos desde ESPN. Toca un botón <b>solo si se equivocó</b>:
          a partir de ahí ese partido queda en tus manos y el sistema ya no lo vuelve a tocar.
          Aquí también pones dónde se transmite cada uno.</p>
        ${partidos.map(filaPartido).join('') || '<div class="empty">Sin partidos.</div>'}
      </div>

      <div class="admin-seccion">
        <h3>Quién pagó · ${S.tabla.length} ${S.tabla.length === 1 ? 'persona' : 'personas'}</h3>
        <p>Marca a quien ya te haya pagado sus ${money(S.cfg.cuota_bote + S.cfg.cuota_manejo)}.
          El bote de la jornada va en <b>${money(S.tabla.length * S.cfg.cuota_bote)}</b>.</p>
        ${S.tabla.map(filaPersona).join('') || '<div class="empty">Nadie ha jugado todavía.</div>'}
      </div>

      <div class="admin-quien">
        <span>Entraste como <b>${esc(session.user.email)}</b></span>
        <button class="admin-salir" id="admin-salir" type="button">Salir</button>
      </div>`;

    conectarAdmin(body);
  }

  function conectarAdmin(body) {
    body.addEventListener('click', async (e) => {
      const res = e.target.closest('[data-res]');
      const auto = e.target.closest('[data-auto]');
      const pago = e.target.closest('[data-pago]');
      const borrar = e.target.closest('[data-borrar]');
      const publicar = e.target.closest('[data-publicar]');
      const rechazar = e.target.closest('[data-rechazar]');
      const eliminar = e.target.closest('[data-eliminar]');

      if (publicar) {
        if (!confirm('¿Ya revisaste el comprobante?\n\nAl confirmar se publican sus 9 pronósticos y ya no se pueden cambiar.')) return;
        await publicarSolicitud(publicar.dataset.publicar);
        return;
      }

      if (rechazar) {
        const nombre = rechazar.dataset.nombre || 'esta persona';
        if (!confirm(`¿Rechazar la solicitud de ${nombre}?\n\nSe quitarán la captura y los picks pendientes. Podrá enviarla de nuevo con un comprobante correcto.`)) return;
        await rechazarSolicitudAdmin(rechazar.dataset.rechazar);
        return;
      }

      if (eliminar) {
        const nombre = eliminar.dataset.nombre || 'esta persona';
        if (!confirm(`¿Eliminar la quiniela de ${nombre} para esta jornada?\n\nSolo se borran sus pronósticos y pago de la jornada actual. Sus datos y jornadas anteriores se conservan.`)) return;
        await eliminarQuinielaAdmin(Number(eliminar.dataset.eliminar));
        return;
      }

      // Forzar un resultado. `manual: true` es lo que hace que el cron
      // respete tu palabra y no te lo sobreescriba en la siguiente corrida.
      if (res) {
        const id = res.dataset.id;
        const valor = S.partidos.find((p) => String(p.id) === id)?.resultado === res.dataset.res
          ? null : res.dataset.res;   // volver a tocarlo lo quita
        await guardarAdmin(
          S.sb.from('partidos').update({ resultado: valor, manual: true }).eq('id', id),
          valor ? 'Resultado puesto a mano.' : 'Resultado borrado.');
        return;
      }

      // Devolverle el partido al automático.
      if (auto) {
        await guardarAdmin(
          S.sb.from('partidos').update({ manual: false }).eq('id', auto.dataset.auto),
          'Listo: ese partido vuelve a jalar solo de ESPN.');
        return;
      }

      if (pago) {
        const id = Number(pago.dataset.pago);
        const nuevo = !S.pagos[id];
        await guardarAdmin(
          S.sb.from('pagos').upsert({
            jornada_id: S.jornada.id, participante_id: id, pagado: nuevo,
            marcado_at: new Date().toISOString()
          }, { onConflict: 'jornada_id,participante_id' }),
          nuevo ? 'Marcado como pagado.' : 'Marcado como no pagado.');
        return;
      }

      // Borrar es serio: sus pronósticos se van detrás. Preguntamos antes.
      if (borrar) {
        const nombre = borrar.dataset.nombre;
        if (!confirm(`¿Borrar a ${nombre}?\n\nSe van también sus 9 pronósticos y no hay forma de recuperarlos.`)) return;
        await guardarAdmin(
          S.sb.from('participantes').delete().eq('id', borrar.dataset.borrar),
          `${nombre} y sus pronósticos, fuera.`);
        return;
      }
    });

    body.addEventListener('change', async (e) => {
      const tv = e.target.closest('[data-tv]');
      if (!tv) return;
      await guardarAdmin(
        S.sb.from('partidos').update({ tv: tv.value || null }).eq('id', tv.dataset.tv),
        tv.value ? `Se transmite por ${tv.value}.` : 'Canal quitado.');
    });
  }

  async function publicarSolicitud(id) {
    const { error } = await S.sb.rpc('aprobar_solicitud_quiniela', { p_solicitud: id });
    if (error) {
      toast(error.message || 'No se pudo publicar esta quiniela.', 'err');
      return;
    }

    toast('Depósito confirmado: la quiniela ya está publicada.', 'ok');
    await Promise.all([cargarPartidos(), cargarTabla(), cargarTodos(), cargarPagos()]);
    render();
    await pintarAdmin();
  }

  async function rechazarSolicitudAdmin(id) {
    const { error } = await S.sb.rpc('rechazar_solicitud_quiniela', { p_solicitud: id });
    if (error) {
      toast(error.message || 'No se pudo rechazar la solicitud. Ejecuta migracion-dashboard-admin.sql.', 'err');
      return;
    }

    toast('Solicitud rechazada. Ya puede enviar una nueva captura.', 'ok');
    await pintarAdmin();
  }

  async function eliminarQuinielaAdmin(participanteId) {
    const { error } = await S.sb.rpc('borrar_pronostico_jornada', {
      p_participante_id: participanteId,
      p_jornada_id: S.jornada.id
    });
    if (error) {
      toast(error.message || 'No se pudo borrar la quiniela. Ejecuta migracion-dashboard-admin.sql.', 'err');
      return;
    }

    toast('Quiniela eliminada solo de esta jornada.', 'ok');
    await Promise.all([cargarPartidos(), cargarTabla(), cargarTodos(), cargarPagos()]);
    render();
    await pintarAdmin();
  }

  // Guarda, avisa, y vuelve a leer todo para que el panel y la página de
  // abajo queden diciendo lo mismo al instante.
  async function guardarAdmin(consulta, exito) {
    const { error } = await consulta;

    if (error) {
      // 42501 = el RLS dijo que no. Casi siempre: falta correr
      // schema-admin.sql, o el correo no está en la lista de admins.
      toast(error.code === '42501'
        ? 'La base rechazó el cambio: tu correo no tiene permiso.'
        : 'No se pudo guardar: ' + error.message, 'err');
      return;
    }

    toast(exito, 'ok');
    await Promise.all([cargarPartidos(), cargarTabla(), cargarTodos(), cargarPagos()]);
    render();
    pintarAdmin();
  }

  async function salirAdmin() {
    await S.sb.auth.signOut();
    toast('Sesión cerrada.', 'ok');
    pintarAdmin();
  }

  // ═════════════════════════════════════════════════════════════════════
  //  APP INSTALABLE Y AVISO DE VERSIÓN NUEVA
  // ═════════════════════════════════════════════════════════════════════

  function initPWA() {
    // ── Instalar ──────────────────────────────────────────────────────
    // El botón NO se enseña siempre: solo cuando el navegador nos avisa que
    // de verdad se puede instalar. Un botón "Instalar" que no instala nada
    // (iPhone, o ya instalada) es peor que no tenerlo.
    let promesaInstalar = null;
    const btnInst = $('#btn-instalar');

    addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      promesaInstalar = e;
      if (btnInst) btnInst.hidden = false;
    });

    if (btnInst) {
      btnInst.addEventListener('click', async () => {
        if (!promesaInstalar) return;
        promesaInstalar.prompt();
        const { outcome } = await promesaInstalar.userChoice;
        promesaInstalar = null;
        btnInst.hidden = true;
        if (outcome === 'accepted') toast('¡Listo! Ya la tienes como app 📲', 'ok');
      });
    }

    addEventListener('appinstalled', () => {
      if (btnInst) btnInst.hidden = true;
      toast('Instalada. Ábrela desde tu pantalla de inicio.', 'ok');
    });

    // ── Service worker ────────────────────────────────────────────────
    if (!('serviceWorker' in navigator)) return;

    // Solo sirve en https (o en localhost mientras desarrollamos). Abrir el
    // archivo directo con doble clic (file://) no cuenta.
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

    navigator.serviceWorker.register('sw.js').then((reg) => {
      // ¿Ya hay uno nuevo esperando de una visita anterior?
      if (reg.waiting && navigator.serviceWorker.controller) avisarVersion(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const nuevo = reg.installing;
        if (!nuevo) return;
        nuevo.addEventListener('statechange', () => {
          // "installed" + ya había un controlador = es una ACTUALIZACIÓN,
          // no la primera visita. En la primera no hay nada que avisar.
          if (nuevo.state === 'installed' && navigator.serviceWorker.controller) {
            avisarVersion(nuevo);
          }
        });
      });

      // Buscamos cambios al volver a la pestaña. La gente deja la quiniela
      // abierta horas mientras se juega; sin esto no se enterarían nunca.
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
      setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);
    }).catch(() => { /* si no se puede registrar, la app funciona igual */ });

    // Cuando el service worker nuevo toma el mando, recargamos una sola vez.
    let recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (recargando) return;
      recargando = true;
      location.reload();
    });
  }

  function avisarVersion(esperando) {
    const bar = $('#update-bar');
    if (!bar || !bar.hidden) return;
    bar.hidden = false;

    $('#update-btn').addEventListener('click', () => {
      $('#update-btn').textContent = 'Actualizando…';
      // El service worker nuevo estaba esperando a propósito para no
      // interrumpir a nadie a medio pronosticar. Aquí le damos permiso.
      esperando.postMessage('ACTUALIZAR_YA');
    }, { once: true });

    $('#update-luego').addEventListener('click', () => { bar.hidden = true; }, { once: true });
  }

  // ── Arranca ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', boot);
})();
