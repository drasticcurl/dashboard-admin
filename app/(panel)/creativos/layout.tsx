/**
 * Guard de permiso de /creativos. Mismo molde que `app/(panel)/tareas/layout.tsx`:
 * va en el layout y no en el page.tsx para cubrir gratis cualquier sub-ruta
 * futura. El chequeo de `debeCambiarClave` NO va acá — lo hace el layout general
 * de `(panel)`.
 */
import type { ReactNode } from 'react';
import { requerirSeccion } from '@/lib/permisos';

export default async function CreativosLayout({ children }: { children: ReactNode }) {
  await requerirSeccion('creativos');
  return <>{children}</>;
}
