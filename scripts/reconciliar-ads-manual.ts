/**
 * `npm run ads:reconciliar` — el cierre de las duplicaciones sin resolver por
 * nombre planificado (P-G05, task 24.2). Se engancha al cron que ya corre
 * `ads:jerarquia`, así el cierre no depende de que alguien abra el panel.
 *
 *   npm run ads:reconciliar [--cuenta=act_123] [--limite=100]
 *
 * Sin `--cuenta` procesa todas las cuentas activas. Sale 0 siempre que la
 * corrida terminó (las filas que quedaron pendientes se reintentan en la
 * corrida siguiente, que es el comportamiento por diseño).
 */

import { cuentasActivas } from '../lib/ads/sync';
import { reconciliarDuplicaciones } from '../lib/ads/reconciliacion';

function arg(n: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : undefined;
}

async function main(): Promise<void> {
  const cuenta = arg('cuenta');
  const limite = Number(arg('limite') ?? '100') || 100;

  const cuentas = cuenta
    ? [{ accountId: cuenta }]
    : await cuentasActivas();

  let totalResueltas = 0;
  let totalPendientes = 0;

  for (const c of cuentas) {
    try {
      const r = await reconciliarDuplicaciones(c.accountId, limite);
      totalResueltas += r.resueltas;
      totalPendientes += r.pendientes;
      console.log(
        `${c.accountId.padEnd(22)} resueltas: ${r.resueltas} · pendientes: ${r.pendientes}`,
      );
    } catch (e) {
      console.error(`${c.accountId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n${totalResueltas} duplicaciones resueltas, ${totalPendientes} pendientes (se reintentan la próxima corrida).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('reconciliar-ads-manual falló:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
