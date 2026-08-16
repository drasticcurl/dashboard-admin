/**
 * /finanzas — el patrimonio del negocio (plan FINANZAS §6).
 *
 * Server component: hace el fetch inicial acá para que la primera pintura ya
 * tenga datos, y FinanzasView se encarga del resto. A diferencia de Resumen,
 * esta pantalla NO lee `?range=` del RangePicker global: el patrimonio es de
 * TODO el histórico por definición (D1), así que el query param se ignora a
 * propósito.
 */

import { getFinanceOverview, listMovements, listScheduledPayments } from '@/lib/queries/finance';
import { FinanzasView } from './FinanzasView';

export const dynamic = 'force-dynamic';

export default async function FinanzasPage() {
  const [overview, movements, scheduledPayments] = await Promise.all([
    getFinanceOverview(),
    listMovements({}),
    listScheduledPayments(),
  ]);
  return (
    <FinanzasView
      initialOverview={overview}
      initialMovements={movements}
      initialScheduledPayments={scheduledPayments}
    />
  );
}
