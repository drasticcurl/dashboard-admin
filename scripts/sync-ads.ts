/**
 * Trae el gasto de publicidad de Meta y lo guarda en `ad_spend`.
 *
 *   npm run ads:sync                      hoy y ayer (lo que corre el cron)
 *   npm run ads:sync -- --days=7          últimos 7 días
 *   npm run ads:sync -- --from=2026-08-01 --to=2026-08-12
 *   npm run ads:sync -- --descubrir       lista las cuentas que ve el token
 *   npm run ads:sync -- --dry-run         no escribe nada
 *
 * POR QUÉ EL DEFAULT ES HOY *Y AYER*
 * El gasto del día en curso sigue cambiando, y el de ayer se ajusta unas horas
 * después del cierre (Meta corrige entregas). Reprocesar dos días en cada
 * corrida hace que el número converja solo, sin intervención. El upsert es
 * idempotente, así que repetir no duplica.
 *
 * La lógica vive en lib/ads/sync.ts: el panel llama la misma función al abrir
 * una pantalla que incluye hoy, así el gasto se ve en vivo y no hay que esperar
 * al cron. Acá queda solo la línea de comandos y lo que se imprime.
 */

import { q } from '../lib/db';
import { listAccounts } from '../lib/ads/meta';
import { cuentasActivas, refrescarMetadatosCuentas, syncAdSpend } from '../lib/ads/sync';

function arg(n: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : undefined;
}
const tiene = (n: string): boolean => process.argv.includes(`--${n}`);

/** Días hacia atrás desde hoy, en la TZ del dashboard (no en UTC). */
async function rango(): Promise<{ from: string; to: string }> {
  const from = arg('from');
  const to = arg('to');
  if (from && to) return { from, to };

  const dias = Number(arg('days') ?? 1);
  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  const r = await q<{ from: string; to: string }>(
    `SELECT ((now() AT TIME ZONE $1)::date - $2::int)::text AS from,
             (now() AT TIME ZONE $1)::date::text            AS to`,
    [tz, Number.isFinite(dias) && dias > 0 ? dias : 1],
  );
  return r[0]!;
}

async function main(): Promise<void> {
  const dryRun = tiene('dry-run');

  if (tiene('descubrir')) {
    // Sirve para dar de alta cuentas sin tener que buscar el id a mano en Meta.
    const cuentas = await listAccounts();
    if (cuentas.length === 0) {
      console.log('El token no ve ninguna cuenta publicitaria.');
      console.log('Revisá que el usuario del sistema tenga la cuenta ASIGNADA (Analista o más),');
      console.log('no solo que el token tenga ads_read: son dos cosas distintas.');
      return;
    }
    console.log(`${cuentas.length} cuenta(s) visibles para el token:\n`);
    for (const c of cuentas) {
      console.log(
        `  ${c.accountId.padEnd(22)} ${(c.name ?? '').padEnd(34)} ` +
          `${(c.currency ?? '?').padEnd(4)} ${c.timezone ?? 'zona desconocida'}`,
      );
    }
    console.log('\nDalas de alta en /config → Publicidad, o con:');
    console.log("  INSERT INTO ad_accounts (account_id, name, currency, funnel_id) VALUES ('act_...', 'Nombre', 'ARS', 1);");
    return;
  }

  const cuentas = await cuentasActivas();
  if (cuentas.length === 0) {
    console.log('No hay cuentas publicitarias configuradas. Corré --descubrir para verlas.');
    return;
  }

  const avisoMeta = await refrescarMetadatosCuentas();
  if (avisoMeta) console.log(`  aviso: no se pudo refrescar la zona horaria de las cuentas (${avisoMeta})`);

  const { from, to } = await rango();
  console.log(`Gasto de Meta, ${from} → ${to}\n`);

  const res = await syncAdSpend({ from, to, dryRun, cuentas });
  for (const c of res.cuentas) {
    if (c.error) {
      console.error(`  ${c.accountId.padEnd(20)} ERROR: ${c.error}`);
      continue;
    }
    console.log(
      `  ${c.accountId.padEnd(20)} ${String(c.filas).padStart(4)} filas con gasto · ` +
        `${c.total.toFixed(2)} ${c.currency}${c.funnelId === null ? '  (SIN FUNNEL ASIGNADO)' : ''}`,
    );
  }

  console.log(
    dryRun
      ? `\n[dry-run] ${res.filas} filas con gasto. No se escribió nada.`
      : `\n${res.filas} filas guardadas. Corré el rollup para el Resumen:\n  npm run rollup -- --days=7`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
