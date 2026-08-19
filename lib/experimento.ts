/**
 * Constantes de la dimensión del experimento A/B, en un módulo SIN dependencias
 * de servidor.
 *
 * Vive acá y no en `lib/queries/funnel.ts` por la misma razón que
 * `lib/funnel-nombre.ts` existe: ese módulo importa `pg`, y un componente de
 * cliente que necesite el centinela lo arrastraría al bundle del browser.
 * `lib/queries/funnel.ts` lo re-exporta, así que el código de servidor lo
 * sigue encontrando en el mismo lugar que el resto del embudo.
 */

/**
 * Centinela de la dimensión: las sesiones que no participaron del experimento
 * (`experiment` NULL) agrupan bajo este valor en el desglose.
 *
 * Empieza con '(' a propósito, para que la función pura de orden
 * (`calcularTasasExperimento`) pueda mandarlo SIEMPRE al final sin depender de
 * la collation del servidor.
 */
export const SIN_EXPERIMENTO = '(sin asignar)';
