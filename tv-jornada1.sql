-- ═══════════════════════════════════════════════════════════════════════
--  QUINIELA MX · Canales de la Jornada 1 (Apertura 2026)
-- ═══════════════════════════════════════════════════════════════════════
--
--  Pégalo en SQL Editor y dale RUN. Nada que editar.
--
--  ── DE DÓNDE SALEN ────────────────────────────────────────────────────
--  NO salen de un scraper adivinando logos. Se sacaron de dos notas de
--  prensa distintas y se cruzaron una contra otra:
--    · futboltotal.com.mx  (Jornada 1, horarios y canales)
--    · vanguardia.com.mx   (Jornada 1, transmisiones y TV abierta)
--
--  Las dos coinciden en el canal de los 9 partidos. Lo único en lo que no
--  se ponen de acuerdo es en cómo llamarle a la marca de FOX ("Fox Sports"
--  / "FOX One" / "Fox Sports Premium"), que son señales hermanas del mismo
--  grupo. Aquí se usa "FOX Sports" para todas: es el nombre que la gente
--  reconoce y busca en su tele.
--
--  ── TV ABIERTA (gratis, sin cable ni suscripción) ─────────────────────
--  Solo 3 de los 9 partidos:
--    · Azteca 7  → Juárez vs Puebla
--    · Canal 5   → Pumas vs Pachuca  ·  Monterrey vs Santos
-- ═══════════════════════════════════════════════════════════════════════

update partidos set tv = 'FOX Sports'              where jornada_id = 1 and local = 'Necaxa';
update partidos set tv = 'FOX Sports'              where jornada_id = 1 and local = 'Tijuana';
update partidos set tv = 'ESPN, Disney+, ViX'      where jornada_id = 1 and local = 'Atlético de San Luis';
update partidos set tv = 'FOX Sports'              where jornada_id = 1 and local = 'León';
update partidos set tv = 'Azteca 7, FOX Sports'    where jornada_id = 1 and local = 'FC Juarez';
update partidos set tv = 'Canal 5, TUDN, ViX'      where jornada_id = 1 and local = 'Pumas UNAM';
update partidos set tv = 'Canal 5, TUDN, ViX'      where jornada_id = 1 and local = 'Monterrey';
update partidos set tv = 'Prime Video'             where jornada_id = 1 and local = 'Guadalajara';
update partidos set tv = 'FOX Sports'              where jornada_id = 1 and local = 'Querétaro';


-- ── Comprobación ───────────────────────────────────────────────────────
-- Después del RUN, esto te muestra cómo quedó. Los 9 deben tener canal.
-- Si alguno sale con "⚠ FALTA", es que el nombre del equipo en la base no
-- coincide con el de arriba (por ejemplo "FC Juarez" sin acento, tal como
-- lo manda ESPN) — dímelo y lo ajusto.

select
  numero            as jornada,
  local || ' vs ' || visitante  as partido,
  to_char(fecha at time zone 'America/Mexico_City', 'DD/MM HH24:MI') as hora_centro,
  coalesce(tv, '⚠ FALTA')       as donde_ver
from partidos p
join jornadas j on j.id = p.jornada_id
where j.numero = 1
order by p.fecha;
