-- ═══════════════════════════════════════════════════════════════════════
--  MIGRACIÓN · Bajar la comisión de manejo de $5 a $2
-- ═══════════════════════════════════════════════════════════════════════
--
--  POR QUÉ HACE FALTA ESTO
--    El valor de la comisión que ve la gente NO sale de config.js: sale de
--    la tabla `config` de la base, que manda sobre el código. Como esa fila
--    ya existe con '5', el schema.sql (que usa ON CONFLICT DO NOTHING) no la
--    pisa. Este UPDATE es el único que de verdad cambia lo que se muestra.
--
--  CÓMO CORRERLO
--    supabase.com → tu proyecto → SQL Editor → New query → pega esto → RUN.
--    Corre una sola vez. La página se entera sola en el siguiente refresco.
-- ═══════════════════════════════════════════════════════════════════════

update config set valor = '2' where clave = 'cuota_manejo';

-- Comprobación: debe devolver una fila con valor = 2
select clave, valor from config where clave = 'cuota_manejo';
