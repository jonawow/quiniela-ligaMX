-- QUINIELA MX · Acciones seguras del dashboard
--
-- Corre este archivo UNA vez, despues de schema-admin.sql y de
-- migracion-pagos-pendientes.sql. Es seguro ejecutarlo varias veces.
-- No borra datos existentes al instalarse; solo agrega las dos acciones que
-- usa el dashboard cuando tu las confirmas.

do $$
begin
  if to_regprocedure('public.es_admin()') is null then
    raise exception 'Primero ejecuta schema-admin.sql.';
  end if;
  if to_regclass('public.solicitudes_quiniela') is null then
    raise exception 'Primero ejecuta migracion-pagos-pendientes.sql.';
  end if;
end
$$;

-- El dashboard ya no borra participantes completos. Quitamos la antigua
-- política de cascada para proteger de forma adicional el historial.
drop policy if exists admin_borra_participantes on public.participantes;


-- Rechazar una solicitud pendiente. Quita su captura privada y deja libre el
-- nombre para que la persona pueda enviar una nueva quiniela con el deposito
-- correcto. Solo el administrador autenticado puede llamar esta funcion.
create or replace function public.rechazar_solicitud_quiniela(p_solicitud uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_estado text;
  v_comprobante_path text;
begin
  if not public.es_admin() then
    raise exception 'No autorizado.' using errcode = '42501';
  end if;

  select estado, comprobante_path
  into v_estado, v_comprobante_path
  from public.solicitudes_quiniela
  where id = p_solicitud
  for update;

  if not found then
    raise exception 'No existe esa solicitud.';
  end if;

  if v_estado <> 'pendiente' then
    raise exception 'Solo se puede rechazar una solicitud pendiente.';
  end if;

  -- La imagen queda fuera del bucket privado tambien; asi no se acumulan
  -- comprobantes que ya no corresponden a una solicitud activa.
  delete from storage.objects
  where bucket_id = 'comprobantes-pago'
    and name = v_comprobante_path;

  delete from public.solicitudes_quiniela
  where id = p_solicitud;
end;
$$;

revoke all on function public.rechazar_solicitud_quiniela(uuid) from public, anon;
grant execute on function public.rechazar_solicitud_quiniela(uuid) to authenticated;


-- Elimina exclusivamente los pronosticos de una persona en UNA jornada.
-- Importante: no borra al participante, por lo que su nombre y el historial
-- de J1, J2 u otras jornadas se conservan intactos.
create or replace function public.borrar_pronostico_jornada(
  p_participante_id bigint,
  p_jornada_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_eliminados integer;
  v_comprobantes text[];
begin
  if not public.es_admin() then
    raise exception 'No autorizado.' using errcode = '42501';
  end if;

  select slug into v_slug
  from public.participantes
  where id = p_participante_id;

  if v_slug is null then
    raise exception 'No existe esa persona.';
  end if;

  delete from public.pronosticos
  where participante_id = p_participante_id
    and jornada_id = p_jornada_id;
  get diagnostics v_eliminados = row_count;

  if v_eliminados = 0 then
    raise exception 'Esa persona no tiene una quiniela publicada en esta jornada.';
  end if;

  -- Tambien se quita el registro de pago de esa jornada, nunca los de otras.
  delete from public.pagos
  where participante_id = p_participante_id
    and jornada_id = p_jornada_id;

  -- Si esta quiniela venia del flujo de deposito, quitamos su solicitud ya
  -- publicada y la imagen privada. Eso permite que se envie una nueva version
  -- si borraste una quiniela por error o para corregirla.
  select array_agg(comprobante_path)
  into v_comprobantes
  from public.solicitudes_quiniela
  where jornada_id = p_jornada_id
    and slug = v_slug
    and estado = 'publicada';

  if coalesce(array_length(v_comprobantes, 1), 0) > 0 then
    delete from storage.objects
    where bucket_id = 'comprobantes-pago'
      and name = any (v_comprobantes);
  end if;

  delete from public.solicitudes_quiniela
  where jornada_id = p_jornada_id
    and slug = v_slug
    and estado = 'publicada';
end;
$$;

revoke all on function public.borrar_pronostico_jornada(bigint, bigint) from public, anon;
grant execute on function public.borrar_pronostico_jornada(bigint, bigint) to authenticated;
