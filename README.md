# Quiniela MX

Quiniela de la Liga MX por jornada. Una sola página: pronosticas 1X2, ves los
marcadores en vivo y la tabla se calcula sola. Sin contraseñas, sin hoja de
cálculo, sin capturar resultados a mano.

**Costo de operación: $0.** Supabase, GitHub Pages y la API de ESPN, todo en
plan gratis, con margen de sobra.

---

## Cómo está armado

```
Página (GitHub Pages)  ──lee──►  Supabase (Postgres)  ◄──escribe──  Cron cada minuto
                                                                         │
                                                                    API de ESPN
```

La página **nunca** habla con ESPN. Solo lee la base. El único que sale a
internet es el cron. Si ESPN se cae o cambia su API sin avisar, la quiniela
sigue de pie con los últimos datos buenos, en vez de romperse en la cara del
jugador.

| Archivo | Qué es |
|---|---|
| `index.html` · `styles.css` · `app.js` | La página. Se sube tal cual, no hay que compilar nada. |
| `config.js` | Lo único que se toca a mano: las llaves de Supabase. |
| `schema.sql` | Las tablas y las reglas de seguridad. |
| `supabase/functions/sync/index.ts` | El cron que jala de ESPN. |
| `cron.sql` | Programa el cron para que corra cada minuto. |

---

## Instalación (una sola vez, ~15 minutos)

### 1. Crear el proyecto en Supabase

En [supabase.com](https://supabase.com) → **New project**. Nómbralo
`quiniela-ligamx` y elige región **East US** (la más cercana a México en el
plan gratis). No pide tarjeta.

### 2. Crear las tablas

Menú lateral → **SQL Editor** → **New query** → pega todo `schema.sql` → **Run**.

Al terminar deberías ver 7 tablas y 1 vista en **Table Editor**.

### 3. Conectar la página

**Project Settings → API**, y copia a `config.js`:

```js
SUPABASE_URL: 'https://xxxxx.supabase.co',   // el "Project URL"
SUPABASE_KEY: 'eyJhbGc...',                  // la llave "anon / public"
```

> La llave `anon` es **pública a propósito**: está hecha para vivir en el
> navegador y cualquiera puede verla en el código fuente. No es un descuido.
> Lo que protege la quiniela son las reglas RLS de `schema.sql`, no el secreto
> de esa llave.
>
> La llave **`service_role` nunca va aquí.** Esa se salta todas las reglas y
> solo vive en el servidor (pasos 4 y 5).

### 4. Desplegar el sincronizador

Con el [CLI de Supabase](https://supabase.com/docs/guides/cli):

```bash
supabase login
supabase link --project-ref TU_REF
supabase functions deploy sync
```

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` ya vienen puestas solas en las
funciones — no hay que configurarlas.

Pruébala a mano antes de programarla:

```bash
supabase functions invoke sync
```

Debe responder algo como `{"ok":true,"vistos":9,"jornadas_creadas":1}` y, si te
asomas a **Table Editor → partidos**, ya deben estar los 9 partidos de la
jornada con todo y logos.

### 5. Programar el cron

**SQL Editor** → pega `cron.sql`, **cambia las dos cosas marcadas
`<<< CAMBIA >>>`** (tu Reference ID y tu llave `service_role`) → **Run**.

Para comprobar que quedó:

```sql
select ts, now() - ts as hace from latido;
```

Si `hace` es menos de 2 minutos, todo está jalando.

### 6. Publicar la página

Repo nuevo en GitHub → sube `index.html`, `styles.css`, `app.js` y `config.js`
→ **Settings → Pages → Deploy from branch → main / root**.

Queda en `https://TU_USUARIO.github.io/TU_REPO/`.

---

## Actualización: depósito antes de publicar y acceso privado

Esta versión cambia el flujo de una quiniela: ahora primero se sube el
comprobante de depósito y el administrador la publica desde `#admin` después
de revisarlo. Los pronósticos pendientes no son públicos ni cuentan en la
tabla.

1. En Supabase SQL Editor, ejecuta `schema-admin.sql` si todavía no tienes el
   panel de administración. En su bloque `mi_correo`, usa tu correo real.
2. Ejecuta `migracion-pagos-pendientes.sql`. Crea la tabla privada de
   solicitudes, el bucket de comprobantes y la función segura que publica los
   nueve picks al aprobarlos.
3. En **Authentication → Providers → Email**, confirma que Email está
   habilitado. Luego en **Authentication → Users → Add user**, elige crear un
   usuario (no enviar invitación) con el mismo correo que agregaste a
   `admins`; ahí es donde eliges su contraseña. Activa **Auto Confirm User**
   si te aparece. Así este acceso no depende del correo que está fallando.
   Si tu panel no muestra esa opción, desactiva temporalmente **Confirm
   email** dentro del proveedor Email mientras creas este único usuario.
4. En `config.js`, completa `ADMIN_LOGIN.email` con ese correo y llena los
   datos reales en `PAGO`. El usuario visible ya viene como `jonawow`.
   La contraseña no se escribe en código, `config.js` ni GitHub.
5. Sube los cambios. Entra al panel con `https://TU-SITIO/#admin`, usuario
   `jonawow` y la contraseña que creaste.

Los jugadores eligen sus nueve picks, ven la cuenta de depósito, suben una
captura JPG/PNG/WEBP de hasta 5 MB y esperan la aprobación. El panel muestra
esa captura con el botón **Confirmar depósito y publicar**. En
**Pronósticos de todos**, el botón **Guardar PDF** abre la impresión del
navegador para guardar la captura de la jornada como PDF.

## El día a día

**Nada.** En serio: el cron crea las jornadas, cierra los pronósticos al
silbatazo, jala los marcadores y calcula la tabla solo.

Lo único tuyo es cobrar y marcar quién pagó, en **Table Editor → pagos**.

### Cuando algo se sale de lo normal

| Situación | Qué hacer |
|---|---|
| ESPN se equivocó en un marcador | En **Table Editor → partidos**, corrige `resultado` y pon `manual` en `true`. El cron ya no lo vuelve a tocar. |
| Cambiar la cuota o la comisión | **Table Editor → config**, cambia `cuota_bote` o `cuota_manejo`. La página se entera sola, sin tocar código. |
| Empieza el Clausura | **config → torneo** = `Clausura 2027`. El cron empieza a numerar desde la jornada 1 otra vez. |
| Se numeró mal una jornada | **Table Editor → jornadas**, corrige `numero` a mano. |
| Reabrir una jornada | **jornadas → estado** = `abierta`. Ojo: si ya se jugó, es tirar la quiniela a la basura. |

---

## Decisiones de diseño que vale la pena conocer

**Los pronósticos son inmutables.** No existe regla de `UPDATE` ni de `DELETE`
sobre la tabla `pronosticos`. Una vez enviado, ni el autor ni yo lo podemos
cambiar. Eso es lo que vuelve justa una quiniela sin contraseñas.

**El cierre lo aplica la base, no la página.** La regla RLS compara con la hora
del *servidor*. No se puede pronosticar tarde tocando el HTML, cambiando el
reloj de la compu, ni llamando a la API directo.

**Los picks de los demás no se pueden espiar.** Mientras la jornada esté
abierta, la base no entrega los pronósticos de nadie — ni por la consola del
navegador. Se destapan todos de golpe al cierre. (Tu propio pronóstico lo
guarda tu navegador, por eso sí lo puedes ver antes.)

**El número de jornada se deduce.** Se lo pregunté a la API de ESPN y no lo
trae. Pero la Liga MX tiene 18 equipos y todos juegan cada jornada, así que son
exactamente 9 partidos por jornada, siempre: el cron corta los partidos nuevos
de 9 en 9 en orden de fecha. Si algún día la Liga cambia de número de equipos,
se ajusta `EQUIPOS` en `supabase/functions/sync/index.ts`.

**El proyecto gratis no se pausa.** Supabase pausa los proyectos free tras una
semana sin actividad. El cron escribe un latido cada minuto pase lo que pase
—incluso si ESPN falla, incluso en el parón entre torneos—, así el contador
nunca llega a cero.

---

## Las cuentas

Cada jugador paga **$55** por jornada: **$50 al bote** y **$5 de manejo**.

Está a la vista en la página, en grande y con desglose, más una sección que
explica de dónde sale el $5. A propósito: si 20 personas juegan, la página
muestra un bote de $1,000 y no de $1,100 — cualquiera que haga la cuenta va a
notar la diferencia. Un cobro escondido se descubre solo y cuesta más
credibilidad que los $5 que gana. Mejor de frente.

El bote se lo lleva quien más aciertos tenga. Si varios empatan, se reparte
entre ellos.

---

## Fuente de los datos

Partidos, marcadores en vivo, estadios y logos salen de la API pública de ESPN
(`site.api.espn.com`, sin llave). Es una API interna, no documentada: puede
cambiar sin avisar. Por eso la página no depende de ella en vivo y por eso
existe el override manual — si un día ESPN cambia, la quiniela sigue y los
resultados se capturan a mano mientras se arregla.

Página sin relación oficial con la Liga MX ni con ningún club.
