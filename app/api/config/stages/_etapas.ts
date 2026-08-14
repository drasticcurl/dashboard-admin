/**
 * El vocabulario y las validaciones de las etapas del embudo (017).
 *
 * Vive en un archivo aparte de route.ts porque Next 14 valida los exports de
 * los routes y rechaza funciones extra: la validación pura que testea
 * `route.test.ts` importa de acá, y el route la llama antes de tocar la base.
 */

export const MILESTONES = ['sales_view', 'checkout_click', 'purchase'] as const;

/** Una etapa tal como llega de la UI (las fuentes van null si no aplican). */
export type EtapaEntrada = {
  stageOrder: number;
  label: string;
  startsAtSlug: string | null;
  milestone: string | null;
};

export type EtapaGuardada = EtapaEntrada & { funnelId: number };

/**
 * Las reglas del §4 de T07, como función pura. `slugsDelFunnel` son los slugs
 * que existen en `funnel_steps` de ese funnel. Devuelve null si está todo
 * bien, o el motivo en castellano (el route lo convierte en 400).
 */
export function validarEtapas(
  slugsDelFunnel: Set<string>,
  etapas: EtapaEntrada[],
): { error: string; detail: string } | null {
  if (etapas.length === 0) {
    // Borrar todas las etapas dejaría el funnel sin embudo, y el seed de la
    // 017 lo rellenaría con las 8 por defecto en la próxima migración: es un
    // estado que no se puede distinguir de "nunca configuré". Mejor pedir al
    // menos una.
    return {
      error: 'stages_vacio',
      detail: 'el embudo necesita al menos una etapa: borrá las que sobren, no todas.',
    };
  }

  const ordenes = etapas.map((e) => e.stageOrder).sort((a, b) => a - b);
  const esperado = Array.from({ length: etapas.length }, (_, i) => i);
  if (ordenes.some((o, i) => o !== esperado[i])) {
    return {
      error: 'stage_order_invalido',
      detail: 'stage_order tiene que ser 0, 1, 2… sin huecos ni repetidos dentro del funnel.',
    };
  }

  const slugVisto = new Set<string>();
  const hitoVisto = new Set<string>();

  for (const e of etapas) {
    const nombre = e.label.trim() || `#${e.stageOrder}`;

    if (!e.label.trim()) {
      return { error: 'etapa_sin_nombre', detail: `la etapa ${e.stageOrder} no tiene nombre.` };
    }

    const tieneSlug = e.startsAtSlug !== null && e.startsAtSlug !== undefined;
    const tieneHito = e.milestone !== null && e.milestone !== undefined;
    if (tieneSlug === tieneHito) {
      return {
        error: 'etapa_sin_fuente_unica',
        detail: `la etapa «${nombre}» tiene que salir de un paso (startsAtSlug) o de un hito (milestone), no de los dos ni de ninguno.`,
      };
    }

    if (tieneSlug) {
      const slug = e.startsAtSlug as string;
      if (!slugsDelFunnel.has(slug)) {
        return {
          error: 'slug_inexistente',
          detail: `el paso «${slug}» no existe en los pasos de este funnel: la etapa nacería huérfana.`,
        };
      }
      if (slugVisto.has(slug)) {
        return {
          error: 'slug_repetido',
          detail: `el paso «${slug}» ya arranca otra etapa de este funnel.`,
        };
      }
      slugVisto.add(slug);
    } else {
      const hito = e.milestone as string;
      if (!(MILESTONES as readonly string[]).includes(hito)) {
        return {
          error: 'milestone_invalido',
          detail: `el hito «${hito}» de la etapa «${nombre}» no existe: usá sales_view, checkout_click o purchase.`,
        };
      }
      if (hitoVisto.has(hito)) {
        return {
          error: 'milestone_repetido',
          detail: `el hito «${hito}» ya tiene su etapa en este funnel.`,
        };
      }
      hitoVisto.add(hito);
    }
  }

  return null;
}
