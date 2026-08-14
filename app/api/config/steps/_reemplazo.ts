/**
 * El reemplazo completo del catálogo de pasos de un funnel, en una tx.
 *
 * Vive en un archivo aparte de route.ts porque Next 14 valida los exports de
 * los routes y rechaza funciones extra: la lógica que se testea
 * (`route.test.ts`) importa de acá.
 *
 * `counts_in_funnel` NO es parte del catálogo: es un ajuste por paso que
 * lib/funnels.ts lee para el embudo. El INSERT no puede dejarlo en default
 * (bug de producción corregido en T07 §2): se lee el valor actual por slug
 * antes del DELETE y se reinyecta. Un paso nuevo nace en `true`.
 */

import { tx } from '@/lib/db';

export async function reemplazarCatalogo(
  funnelId: number,
  steps: { stepIndex: number; slug: string; label: string; kind: string }[],
): Promise<void> {
  await tx(async (c) => {
    // counts_in_funnel sobrevive al DELETE+INSERT: se lee por slug ANTES de
    // borrar y se reinyecta. Sin esto, cada importación devolvía todos los
    // pasos a `true` y el embudo cambiaba de números solo.
    const prev = await c.query<{ slug: string; counts_in_funnel: boolean }>(
      'SELECT slug, counts_in_funnel FROM funnel_steps WHERE funnel_id = $1',
      [funnelId],
    );
    const countsPorSlug = new Map(prev.rows.map((r) => [r.slug, r.counts_in_funnel]));

    await c.query('DELETE FROM funnel_steps WHERE funnel_id = $1', [funnelId]);
    for (const s of steps) {
      await c.query(
        `INSERT INTO funnel_steps (funnel_id, step_index, slug, label, kind, counts_in_funnel)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [funnelId, s.stepIndex, s.slug, s.label, s.kind, countsPorSlug.get(s.slug) ?? true],
      );
    }
  });
}
