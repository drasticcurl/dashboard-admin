/**
 * /creativos — el tracker de eficiencia de videos.
 *
 * Server component con `force-dynamic`, mismo molde que `app/(panel)/tareas/page.tsx`:
 * el fetch inicial pasa acá para que la primera pintura ya tenga la lista. El
 * formulario de alta/edición y el borrado viven en CreativosView (cliente).
 *
 * El guard de permiso NO va acá: lo puso `app/(panel)/creativos/layout.tsx`.
 */

import { listarCreativos } from '@/lib/queries/creativos';
import { CreativosView } from './CreativosView';

export const dynamic = 'force-dynamic';

export default async function CreativosPage(): Promise<JSX.Element> {
  const creativos = await listarCreativos();
  return <CreativosView initial={creativos} />;
}
