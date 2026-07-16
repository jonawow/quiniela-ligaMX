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
    enviado: false,
    tabla: [],
    todos: [],
    timer: null
  };

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

    // Va aquí arriba, no al final: el menú y el tema tienen que funcionar
    // aunque la base de datos no responda y nos salgamos antes de tiempo.
    initFlechasMenu();
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

    await Promise.all([cargarPartidos(), cargarTabla(), cargarTodos()]);

    render();
    arrancarReloj();
    arrancarSondeo();
    conectarEventos();
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

  // Antes del cierre esto regresa vacío a propósito: la base no entrega los
  // pronósticos de nadie mientras la jornada siga abierta.
  async function cargarTodos() {
    const { data } = await S.sb.from('pronosticos')
      .select('partido_id, pick, participantes(nombre)')
      .eq('jornada_id', S.jornada.id);
    S.todos = data || [];
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
    renderPartidos();
    renderEnVivo();
    renderTabla();
    renderTodos();
    renderProgreso();
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

    // Bote: cuánta gente jugó × lo que va al bote de cada quien.
    const gente = S.tabla.length;
    $('#bote-amount').textContent = money(gente * S.cfg.cuota_bote);
    $('#bote-people').textContent = gente === 1 ? '1 jugando' : gente + ' jugando';
    $('#bote-cuota').textContent = S.cfg.cuota_bote;
  }

  function renderCosto() {
    const { cuota_bote: b, cuota_manejo: m } = S.cfg;
    $('#costo-total').textContent = money(b + m);
    $('#costo-bote').textContent = b;
    $('#costo-manejo').textContent = m;
  }

  function renderPartidos() {
    const cont = $('#partidos-list');
    const cerrada = estaCerrada();

    if (!S.partidos.length) {
      cont.innerHTML = '<div class="empty">Los partidos de esta jornada todavía no se cargan.</div>';
      return;
    }

    if (cerrada && S.enviado) {
      alerta('<b>Ya quedó tu pronóstico.</b> La jornada cerró — ahora a ver los partidos. ' +
        'Tus aciertos se van marcando solos en <a href="#envivo">En vivo</a>.', 'ok');
    } else if (cerrada) {
      alerta('<b>Esta jornada ya cerró.</b> Se cerró al arrancar el primer partido. ' +
        'Aquí abajo puedes ver cómo van, y la que sigue abre en cuanto termine esta.', 'warn');
    } else if (S.enviado) {
      alerta('<b>Listo, ya estás dentro.</b> Tu pronóstico quedó guardado y ya no se puede cambiar — ' +
        'eso es justo lo que lo hace parejo para todos.', 'ok');
    }

    cont.innerHTML = S.partidos.map((p) => tarjetaPartido(p, cerrada)).join('');

    $('#submit-bar').hidden = cerrada || S.enviado;
  }

  function tarjetaPartido(p, cerrada) {
    const pick = S.picks[p.id];
    const bloqueado = cerrada || S.enviado;

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
    const top = S.tabla[0]?.aciertos ?? 0;
    const lideres = S.tabla.filter((r) => r.aciertos === top && top > 0);
    const bote = S.tabla.length * S.cfg.cuota_bote;
    const reparto = lideres.length ? Math.floor(bote / lideres.length) : 0;
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

  function renderTodos() {
    const cont = $('#todos-grid');

    // Agrupamos los picks por persona.
    const porPersona = new Map();
    S.todos.forEach((r) => {
      const nombre = r.participantes?.nombre || '—';
      if (!porPersona.has(nombre)) porPersona.set(nombre, []);
      porPersona.get(nombre).push(r);
    });

    if (!porPersona.size) {
      cont.innerHTML = '<div class="empty" style="grid-column:1/-1">Nadie pronosticó esta jornada.</div>';
      return;
    }

    const resPorPartido = Object.fromEntries(S.partidos.map((p) => [p.id, p.resultado]));

    cont.innerHTML = [...porPersona.entries()].map(([nombre, picks]) => {
      const aciertos = picks.filter((p) => resPorPartido[p.partido_id] === p.pick).length;

      const chips = picks.map((p) => {
        const res = resPorPartido[p.partido_id];
        const cls = !res ? '' : (res === p.pick ? ' is-hit' : ' is-miss');
        return `<span class="chip${cls}">${p.pick === 'E' ? 'X' : p.pick}</span>`;
      }).join('');

      return `
        <article class="todo-card">
          <div class="todo-head">
            <span class="avatar">${esc(iniciales(nombre))}</span>
            <div style="min-width:0">
              <div class="todo-name">${esc(nombre)}</div>
              <div class="todo-sub">${aciertos} de ${picks.length} aciertos</div>
            </div>
          </div>
          <div class="todo-picks">${chips}</div>
        </article>`;
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

    btn.disabled = !completo || !conNombre;

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

    if (nombre.length < 2) return toast('Escribe tu nombre para poder enviar.', 'err');

    // Puede haber cerrado mientras la persona llenaba la quiniela.
    if (estaCerrada()) {
      toast('La jornada acaba de cerrar. Ya no alcanzó.', 'err');
      return render();
    }

    btn.disabled = true;
    btn.textContent = 'Enviando…';

    try {
      const participanteId = await obtenerParticipante(nombre);

      const filas = S.partidos.map((p) => ({
        jornada_id: S.jornada.id,
        partido_id: p.id,
        participante_id: participanteId,
        pick: S.picks[p.id]
      }));

      const { error } = await S.sb.from('pronosticos').insert(filas);

      if (error) {
        // 23505 = choca con el índice único: ya había pronosticado.
        if (error.code === '23505') {
          S.enviado = true;
          store.set('enviado-' + S.jornada.id, true);
          toast('Ya habías enviado tu pronóstico de esta jornada.', 'err');
          return render();
        }
        // 42501 = el RLS lo rechazó: la jornada ya está cerrada del lado servidor.
        if (error.code === '42501') {
          toast('La jornada ya cerró. El servidor no aceptó el pronóstico.', 'err');
          await cargarJornada();
          return render();
        }
        throw error;
      }

      S.enviado = true;
      store.set('enviado-' + S.jornada.id, true);
      store.set('nombre', nombre);

      toast('¡Listo! Tu pronóstico quedó guardado. Suerte 🍀', 'ok');

      await Promise.all([cargarTabla(), cargarTodos()]);
      render();
      $('#tabla').scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
      console.error(err);
      toast('No se pudo enviar. Revisa tu internet y vuelve a intentar.', 'err');
      btn.disabled = false;
      renderProgreso();
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
        await Promise.all([cargarPartidos(), cargarTabla(), cargarTodos()]);
        renderCabecera();
        renderEnVivo();
        renderTabla();
        renderTodos();
      } catch (e) { /* si falla un sondeo, no pasa nada: al rato vuelve */ }
    }, 30000);

    // Al volver a la pestaña, refresca de inmediato en vez de esperar.
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) return;
      try {
        await Promise.all([cargarPartidos(), cargarTabla()]);
        renderCabecera(); renderEnVivo(); renderTabla();
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

  // ── Arranca ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', boot);
})();
