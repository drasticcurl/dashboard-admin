/**
 * /anuncios/historial — qué hizo o habría hecho el motor, en castellano (T19).
 *
 * Server component mínimo: el fetch lo hace `HistorialView` en el client contra
 * `/api/data/ads/historial`, con los filtros y la paginación por cursor.
 */

import { HistorialView } from './HistorialView';

export const dynamic = 'force-dynamic';

export default function HistorialPage() {
  return <HistorialView />;
}
