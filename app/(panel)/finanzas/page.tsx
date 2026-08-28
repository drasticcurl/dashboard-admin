/**
 * /finanzas — cuánta plata hay (plan SALDO §6).
 *
 * Server component: el fetch inicial va acá para que la primera pintura ya tenga
 * datos, y FinanzasView se encarga del resto. Esta pantalla NO lee `?range=` del
 * RangePicker global: el patrimonio es la foto del último día que el usuario
 * cargó, no un agregado de un rango, así que el query param se ignora a
 * propósito.
 *
 * El patrimonio ya no se calcula desde `daily_metrics`: lo mide el usuario. Por
 * eso este archivo consulta dos módulos distintos — `finance.ts` para los
 * movimientos y los pagos programados, `saldo.ts` para el patrimonio y las series
 * del gráfico.
 */

import { getFinanceOverview, listMovements, listScheduledPayments } from '@/lib/queries/finance';
import { getSaldoOverview, listAccounts, serieDiaria, serieMensual } from '@/lib/queries/saldo';
import { FinanzasView } from './FinanzasView';

export const dynamic = 'force-dynamic';

export default async function FinanzasPage() {
  // `overview` primero y solo: de él sale `hoy`, resuelto en DASHBOARD_TZ por el
  // server, y de `hoy` sale el mes del gráfico diario.
  //
  // EL MES NO SE CALCULA CON `new Date()`: el 31 a las 21:30 de Buenos Aires, la
  // TZ del browser (o la del server, si está en Europa) ya devuelve el mes
  // siguiente, y el gráfico "diario de este mes" aparecería vacío justo la noche
  // del cierre. Está verificado en `_verificacion-028.sql` #14.
  const overview = await getFinanceOverview();
  const mesActual = overview.hoy.slice(0, 7);

  const [movements, scheduledPayments, saldo, diario, mensual, cuentas] = await Promise.all([
    listMovements({}),
    listScheduledPayments(),
    getSaldoOverview(),
    serieDiaria(mesActual),
    serieMensual(12),
    // Con las cerradas: una cuenta que desaparece de la lista es una cuenta que
    // el usuario cree que perdió.
    listAccounts({ incluirCerradas: true }),
  ]);

  return (
    <FinanzasView
      initialOverview={overview}
      initialMovements={movements}
      initialScheduledPayments={scheduledPayments}
      initialSaldo={saldo}
      initialDiario={diario}
      initialMensual={mensual}
      initialCuentas={cuentas}
    />
  );
}
