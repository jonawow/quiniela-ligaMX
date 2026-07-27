// ═══════════════════════════════════════════════════════════════════════
//  QUINIELA MX · Configuración
//  Lo único que hay que tocar a mano en todo el proyecto.
// ═══════════════════════════════════════════════════════════════════════

window.QMX_CONFIG = {

  // ── Supabase ─────────────────────────────────────────────────────────
  // Los sacas de: supabase.com → tu proyecto → Project Settings → API
  //
  //   SUPABASE_URL  → el campo "Project URL"
  //   SUPABASE_KEY  → la llave "anon / public"
  //
  // La llave anon es PÚBLICA por diseño: está hecha para vivir en el
  // navegador y quien sabe leer el código fuente la va a ver. No es un
  // descuido, así funciona. Lo que protege la quiniela son las reglas RLS
  // de schema.sql, no el secreto de esta llave.
  //
  // ⚠️  La llave service_role JAMÁS va aquí. Esa salta todas las reglas de
  //     seguridad y solo debe vivir en el servidor (los Secrets del cron).
  SUPABASE_URL: 'https://fmqzzufutlefxmfpsvfv.supabase.co',
  SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZtcXp6dWZ1dGxlZnhtZnBzdmZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMDg5MTcsImV4cCI6MjA5OTc4NDkxN30.UWR-S6qZ_m-phmFUVg7AbJujKnnyHuZzmfAz7MRmboY',

  // ── Dinero ───────────────────────────────────────────────────────────
  // Solo para lo que se MUESTRA en pantalla. Los valores de verdad viven
  // en la tabla `config` de la base y mandan sobre estos: si los cambias
  // allá, la página se entera sola sin tocar código. Esto es el respaldo
  // por si la base no responde.
  CUOTA_BOTE:   50,   // lo que va al bote, por persona por jornada
  CUOTA_MANEJO: 2,    // comisión por manejo de la quiniela

  // ── Identidad ────────────────────────────────────────────────────────
  NOMBRE: 'Quiniela MX',
  TORNEO: 'Apertura 2026',

  // El usuario que se muestra en el acceso privado. Supabase inicia sesión
  // con correo + contraseña, por eso se configura también el correo real.
  // La contraseña NUNCA se escribe aquí ni se sube a GitHub.
  ADMIN_LOGIN: {
    usuario: 'jonawow',
    email: 'PON_AQUI_EL_CORREO_DEL_ADMIN_EN_SUPABASE'
  },

  // Datos visibles para quien vaya a hacer el depósito. Completa los campos
  // reales antes de publicar. `monto` es el total que se cobra.
  PAGO: {
    monto: 52,
    titular: 'PON_AQUI_EL_NOMBRE_DEL_TITULAR',
    banco: 'PON_AQUI_EL_BANCO',
    cuenta: '',
    clabe: '',
    tarjeta: '',
    referencia: ''
  }

  // ── ¿Y el panel de admin? ────────────────────────────────────────────
  // El panel se abre agregando #admin a la URL. La llave service_role nunca
  // llega al navegador: el permiso se comprueba con RLS en schema-admin.sql.
};
