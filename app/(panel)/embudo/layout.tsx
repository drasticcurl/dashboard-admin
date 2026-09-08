/**
 * Guard de permiso de /embudo.
 *
 * Va en un layout y no en el page.tsx por dos razones (D4 del plan): es un
 * archivo NUEVO, así que no toca la pantalla que ya funciona, y cubre las
 * sub-rutas gratis. El chequeo de `debeCambiarClave` NO va acá: lo hace el
 * layout general de `(panel)`, para que alguien con la clave por defecto y sin
 * secciones no caiga en /sin-acceso sin poder cambiarla (D8).
 */
import type { ReactNode } from 'react';
import { requerirSeccion } from '@/lib/permisos';

export default async function EmbudoLayout({ children }: { children: ReactNode }) {
  await requerirSeccion('embudo');
  return <>{children}</>;
}
