#!/usr/bin/env node
/**
 * Cron diario que asigna campañas a un funnel por el nombre de sus conjuntos.
 *
 * Existe por un pedido que se repetía casi todos los días: las campañas «arroz»
 * se crean en la cuenta HIlvanapp, cuyo funnel de cuenta es Alma Gemela, pero
 * son de Chau Hinchazón. Sin fila en `ad_campaign_funnel` su gasto cae en Alma
 * Gemela (cascada de la migración 033). Ver registro.md, 2026-10-07 a 2026-10-15.
 *
 * Por cada regla: las campañas de esa cuenta con ALGÚN conjunto cuyo nombre
 * contiene el patrón y que NO tienen mapeo → se mapean al funnel, y su gasto ya
 * sincronizado se reimputa. El rollup de cada 10 min (`rollup.ts --days=3`)
 * recalcula el Resumen solo; acá no se corre.
 *
 * Una campaña que YA tiene mapeo (a cualquier funnel) no se toca: si alguien la
 * asignó a mano a otro lado, esa decisión gana.
 *
 * Horario: 0:01 de Lisboa. Las tandas se crean la noche anterior (18–22 h) y
 * empiezan a gastar al día siguiente, así que a esa hora el sync de jerarquía
 * (cada 15 min) ya las trajo y todavía no gastaron.
 *
 * Uso:
 *   npx tsx scripts/asignar-campanas-por-nombre.ts          # aplica
 *   npx tsx scripts/asignar-campanas-por-nombre.ts --seco   # sólo lista
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q } from '../lib/db';

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

type Regla = { cuenta: string; patron: string; funnelSlug: string };

export const REGLAS: readonly Regla[] = [
  // «arroz» de HIlvanapp → Chau Hinchazón (pedido del 2026-10-15).
  { cuenta: 'act_2501344510302910', patron: 'arroz', funnelSlug: 'chauhinchazon' },
];

type Candidata = { campaign_id: string; name: string | null };

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const seco = args.includes('--seco');
  const hoy = new Date().toISOString().slice(0, 10);
  let total = 0;

  for (const r of REGLAS) {
    const candidatas = await q<Candidata>(
      `SELECT c.campaign_id, c.name
         FROM ad_campaigns c
        WHERE c.account_id = $1
          AND EXISTS (SELECT 1 FROM ad_sets s
                       WHERE s.campaign_id = c.campaign_id AND s.name ILIKE '%' || $2 || '%')
          AND NOT EXISTS (SELECT 1 FROM ad_campaign_funnel m WHERE m.campaign_id = c.campaign_id)
        ORDER BY c.created_time`,
      [r.cuenta, r.patron],
    );
    if (candidatas.length === 0) {
      console.log(`${hoy}: «${r.patron}» → ${r.funnelSlug}: nada nuevo`);
      continue;
    }
    const nombres = candidatas.map((c) => c.name ?? c.campaign_id).join(', ');
    if (seco) {
      console.log(`${hoy}: «${r.patron}» → ${r.funnelSlug}: asignaría ${candidatas.length}: ${nombres}`);
      continue;
    }

    const ids = candidatas.map((c) => c.campaign_id);
    const mapeadas = await q<{ campaign_id: string; funnel_id: number }>(
      `INSERT INTO ad_campaign_funnel (campaign_id, funnel_id, account_id, campaign_name, nota)
       SELECT c.campaign_id, f.id, c.account_id, c.name,
              'automático: conjuntos «' || $3 || '» (scripts/asignar-campanas-por-nombre.ts, ' || $4 || ')'
         FROM ad_campaigns c CROSS JOIN funnels f
        WHERE c.campaign_id = ANY($1::text[]) AND f.slug = $2
       ON CONFLICT (campaign_id) DO NOTHING
       RETURNING campaign_id, funnel_id`,
      [ids, r.funnelSlug, r.patron, hoy],
    );
    if (mapeadas.length === 0) {
      throw new Error(`no existe el funnel '${r.funnelSlug}'`);
    }
    const reimputadas = await q(
      `UPDATE ad_spend SET funnel_id = $2
        WHERE campaign_id = ANY($1::text[]) AND funnel_id IS DISTINCT FROM $2
       RETURNING id`,
      [mapeadas.map((m) => m.campaign_id), mapeadas[0]!.funnel_id],
    );
    total += mapeadas.length;
    console.log(
      `${hoy}: «${r.patron}» → ${r.funnelSlug}: ${mapeadas.length} campañas (${nombres}); ` +
        `${reimputadas.length} filas de gasto reimputadas`,
    );
  }
  return total;
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('asignar-campanas-por-nombre falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
