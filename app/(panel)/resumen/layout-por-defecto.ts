import type { WidgetPlacement } from '@/lib/widgets/tipos';

/**
 * El layout por defecto de Resumen (D-R04: se muestra mientras la fila
 * `settings.ui_layout_resumen` esté en null, o sea que el usuario nunca
 * guardó).
 *
 * Reproduce la pantalla de hoy (task §1): los cuatro KPIs arriba en una
 * fila, el bloque de alertas, las tarjetas por funnel, el apilado de neto
 * por día y la tabla comparativa. Un usuario que no toca nada no debería
 * notar que cambió el sistema.
 *
 * Los `id` tienen que existir en lib/widgets/catalogo-resumen.tsx: un id
 * desconocido se ignora y la barra avisa (§4 regla 4 del plan).
 */
export const layoutPorDefectoResumen: WidgetPlacement[] = [
  { id: 'neto', w: 1, h: 1 },
  { id: 'ordenes', w: 1, h: 1 },
  { id: 'sesiones', w: 1, h: 1 },
  { id: 'ticket', w: 1, h: 1 },
  { id: 'alertas', w: 2, h: 1 },
  { id: 'funnels', w: 2, h: 2 },
  { id: 'neto-dia', w: 2, h: 2 },
  { id: 'tabla-funnels', w: 2, h: 2 },
];
