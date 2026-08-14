/**
 * Sync de la jerarquía de anuncios de Meta (T14).
 *
 *   npm run ads:jerarquia                        # todas las cuentas activas
 *   npm run ads:jerarquia -- --cuenta=act_123    # una sola
 *   npm run ads:jerarquia -- --dry-run           # trae y cuenta, no escribe
 *
 * Llena `ad_campaigns`, `ad_sets` y `ads` de forma idempotente. La lógica vive
 * en lib/ads/jerarquia.ts; acá queda sólo la línea de comandos y lo que se
 * imprime.
 *
 * Sale con exit 1 si alguna cuenta falló, para poder encadenarlo en deploy.sh
 * y en el cron. Una cuenta que no factura en EUR NO es un error: se reporta y
 * se sigue con las demás (D-A10).
 */

import { sincronizarJerarquia } from '../lib/ads/jerarquia';

function arg(n: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : undefined;
}
const tiene = (n: string): boolean => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const dryRun = tiene('dry-run');
  const cuenta = arg('cuenta');

  console.log(
    `Jerarquía de anuncios de Meta${dryRun ? ' (dry-run: no escribe)' : ''}\n`,
  );

  const res = await sincronizarJerarquia({
    cuentas: cuenta ? [cuenta] : undefined,
    dryRun,
  });

  if (res.cuentas.length === 0) {
    console.log('No hay cuentas publicitarias activas para sincronizar.');
    if (cuenta) {
      console.log(`  La cuenta ${cuenta} no está activa en ad_accounts (o no es 'meta').`);
    }
    process.exit(1);
  }

  let algunaFallida = false;
  let totalTraidos = 0;
  let totalGuardados = 0;

  for (const c of res.cuentas) {
    if (c.error) {
      algunaFallida = true;
      console.error(`  ${c.accountId.padEnd(22)} ERROR: ${c.error}`);
      continue;
    }
    if (c.monedaNoSoportada !== null) {
      console.log(
        `  ${c.accountId.padEnd(22)} moneda ${c.monedaNoSoportada} no soportada — se salteó (D-A10)`,
      );
      continue;
    }
    console.log(`  ${c.accountId.padEnd(22)} ${c.name ?? ''}`);
    console.log(
      `    campañas : ${c.campanias.traidos} traídas · ${c.campanias.guardados} guardadas · ${c.campanias.huerfanos} huérfanas`,
    );
    console.log(
      `    conjuntos: ${c.conjuntos.traidos} traídos · ${c.conjuntos.guardados} guardados · ${c.conjuntos.huerfanos} huérfanos`,
    );
    console.log(
      `    anuncios : ${c.anuncios.traidos} traídos · ${c.anuncios.guardados} guardados · ${c.anuncios.huerfanos} huérfanos`,
    );
    if (c.conPresupuestoLifetime > 0) {
      console.log(`    con presupuesto TOTAL (se lista, no se automatiza): ${c.conPresupuestoLifetime}`);
    }
    if (c.desaparecidos > 0) {
      console.log(`    desaparecidos (Meta ya no los devuelve): ${c.desaparecidos}`);
    }
    totalTraidos += c.campanias.traidos + c.conjuntos.traidos + c.anuncios.traidos;
    totalGuardados += c.campanias.guardados + c.conjuntos.guardados + c.anuncios.guardados;
  }

  console.log(
    dryRun
      ? `\n[dry-run] ${totalTraidos} objetos traídos. No se escribió nada.`
      : `\n${totalGuardados} objetos guardados en las tres tablas.`,
  );

  if (algunaFallida) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
