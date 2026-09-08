/**
 * /tareas — el tablero kanban (T06 §5).
 *
 * Server component con `force-dynamic`, igual que las diez pantallas del panel
 * (molde: app/(panel)/anuncios/reglas/page.tsx): el fetch inicial pasa acá para
 * que la PRIMERA pintura ya tenga las tarjetas. El drag & drop, el switch y el
 * modal viven en TableroView (cliente).
 *
 * El guard de permiso NO va acá: lo puso app/(panel)/tareas/layout.tsx (T03).
 * `sesionActual` se importa SÓLO para leer quién entró (el `yo` que baja como
 * prop), no para re-chequear el acceso.
 *
 * `yo` baja al cliente para no ofrecer botones que van a dar 403 (D5): quién
 * puede editar qué lo decide igual el route de T05, esto es cosmético.
 */

import { redirect } from 'next/navigation';
import { sesionActual } from '@/lib/permisos';
import { listarTareas } from '@/lib/queries/tareas';
import { listarUsuarios } from '@/lib/queries/usuarios';
import { TableroView } from './TableroView';

export const dynamic = 'force-dynamic';

export default async function TareasPage({
  searchParams,
}: {
  searchParams?: { asignado?: string };
}): Promise<JSX.Element> {
  const sesion = await sesionActual();
  // El layout ya redirige si no hay sesión; este chequeo es defensivo para el
  // tipo (sesion podría ser null) y no una segunda capa de permiso.
  if (!sesion) redirect('/');

  // El filtro viaja en ?asignado= (default 'todas'), como ?s= en Config:
  // sobrevive al refresh y se puede compartir por link. Pero el server trae
  // SIEMPRE todas las tareas: el switch es igual para todos y filtra en el
  // cliente, así que cambiar de persona no dispara un refetch y el drag & drop
  // trabaja sobre el conjunto completo. `?asignado=` sólo fija la opción inicial
  // del select.
  const crudo = searchParams?.asignado ?? 'todas';

  const [tareas, usuarios] = await Promise.all([
    listarTareas({ asignadoA: null }),
    listarUsuarios(),
  ]);

  return (
    <TableroView
      initial={{ tareas, usuarios }}
      yo={{ id: sesion.usuarioId, nombre: sesion.nombre, esAdmin: sesion.esAdmin }}
      asignadoInicial={crudo}
    />
  );
}
