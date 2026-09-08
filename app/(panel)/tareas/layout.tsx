/**
 * Guard de permiso de /tareas.
 *
 * Va en un layout y no en el page.tsx por dos razones (D4 del plan): es un
 * archivo NUEVO, así que no toca la pantalla, y cubre las sub-rutas gratis. La
 * pantalla (page.tsx, TableroView, etc.) la escribe T06; este archivo es el
 * guard y es de T03. El chequeo de `debeCambiarClave` NO va acá: lo hace el
 * layout general de `(panel)`, para que alguien con la clave por defecto y sin
 * secciones no caiga en /sin-acceso sin poder cambiarla (D8).
 */
import type { ReactNode } from 'react';
import { requerirSeccion } from '@/lib/permisos';

export default async function TareasLayout({ children }: { children: ReactNode }) {
  await requerirSeccion('tareas');
  return <>{children}</>;
}
