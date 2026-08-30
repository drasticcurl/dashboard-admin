/**
 * El texto en castellano que va al historial Y a Telegram (T16).
 *
 * Este archivo es PURO: no importa el acceso a la base, no importa el cliente de
 * Meta y no lee el entorno. Es la razón de ser del historial: el usuario pidió
 * que el log se lea bien, con los números que decidieron adentro. Un renglón, en
 * castellano, con locale es-AR.
 *
 * `explicacion` se escribe SIEMPRE, incluso cuando se omite. Nunca "error
 * desconocido" ni un motivo en inglés: el `MotivoOmision` es un enum interno,
 * el texto es para una persona. El `switch` es exhaustivo (con
 * `const _: never = motivo` en el `default`) para que agregar un motivo nuevo
 * rompa la compilación en lugar de producir una explicación vacía.
 */

import type { Condicion, Decision, MetricasObjeto, MotivoOmision, Regla } from '../tipos';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '@/lib/moneda-reporte';

// ─── Formateadores ──────────────────────────────────────────────────────────
// Igual que fmtMoney de components/ui.tsx (leído, no importado: este archivo es
// puro y no depende de un archivo de React). es-AR: coma decimal, punto de
// miles. Sin espacio entre el símbolo y el número (los ejemplos del §5 dicen
// "€4,37", no "€ 4,37").

const dosDecimales = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "€4,37" · "€1.234,56" · para un negativo, "-€4,37". */
export function formatearEur(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const signo = n < 0 ? '-' : '';
  return `${signo}${SIMBOLO_REPORTE}${dosDecimales.format(Math.abs(n))}`;
}

/** "1,52" — para ROI/ROAS/CTR/CPC, que son múltiplos o ratios, no importes. */
function formatearNumero(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return dosDecimales.format(n);
}

function formatearEntero(n: number): string {
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n);
}

// ─── Etiquetas ──────────────────────────────────────────────────────────────

const ETIQUETA_NIVEL: Record<MetricasObjeto['level'], string> = {
  campaign: 'Campaña',
  adset: 'Conjunto',
  ad: 'Anuncio',
};

const ETIQUETA_METRICA: Record<Condicion['metric'], string> = {
  sales: 'ventas',
  revenue: 'ingresos',
  spend: 'gasto',
  net: 'neto',
  profit: 'ganancia',
  roi: 'ROI',
  roas: 'ROAS',
  cpa: 'CPA',
  budget: 'presupuesto',
  impressions: 'impresiones',
  clicks: 'clics',
  ctr: 'CTR',
  cpc: 'CPC',
};

const VERBO_OMISION: Record<Regla['action'], string> = {
  pause: 'pausar',
  activate: 'activar',
  budget_increase: 'subir el presupuesto',
  budget_decrease: 'bajar el presupuesto',
};

/**
 * El renglón completo. `d` es la decisión de `evaluar` (con `explicacion` sin
 * rellenar). `dryRun` es el modo sombra efectivo (flag de la regla O el global).
 */
export function explicar(
  regla: Regla,
  condiciones: Condicion[],
  fila: MetricasObjeto,
  d: Omit<Decision, 'explicacion'>,
  dryRun: boolean,
): string {
  const prefijo = dryRun ? '[SIMULACIÓN] ' : '';
  const objeto = describirObjeto(fila);
  const resumen = resumenMetricas(fila, condiciones, regla);

  // La acción se va a aplicar de verdad (o habría, en sombra).
  if (d.motivo === null) {
    return `${prefijo}${objeto}: ${resumen} → ${accionAplicada(regla, fila, d, dryRun)}. Condición: ${describirCondiciones(condiciones)}${estadoAnterior(regla, fila, dryRun)}`;
  }

  // Cumple pero un freno lo detuvo: "cumple para X, pero no se tocó: <por qué>".
  return `${prefijo}${objeto}: ${resumen} → cumple para ${VERBO_OMISION[regla.action]}, pero no se tocó: ${motivoTexto(d.motivo, regla)}.`;
}

// ─── Piezas ─────────────────────────────────────────────────────────────────

function describirObjeto(fila: MetricasObjeto): string {
  const nombre = fila.objectName ?? '(sin nombre)';
  return `${ETIQUETA_NIVEL[fila.level]} «${nombre}» (${fila.accountId})`;
}

/**
 * El resumen de métricas que acompaña al objeto. Incluye el gasto (formateado
 * en es-AR) y las ventas, y agrega el ROI cuando la regla decide por ROI.
 * Para los períodos de 7 días, el gasto no es "de hoy" y se lo dice.
 */
function resumenMetricas(fila: MetricasObjeto, condiciones: Condicion[], regla: Regla): string {
  const miraRoi = condiciones.some((c) => c.metric === 'roi' || c.metric === 'roas');
  const periodo = regla.period;
  const enSieteDias = periodo === '7d' || periodo === '7d_excl_today';

  if (enSieteDias) {
    if (miraRoi && fila.roi !== null) {
      return `ROI ${formatearNumero(fila.roi)} en los últimos 7 días`;
    }
    return `gastó ${formatearEur(fila.spendEur)} en los últimos 7 días con ${ventas(fila.sales)}`;
  }

  const gasto = `${formatearEur(fila.spendEur)} de gasto`;
  if (miraRoi && fila.roi !== null) {
    const base = `ROI ${formatearNumero(fila.roi)} con ${gasto}`;
    return condiciones.some((c) => c.metric === 'sales') ? `${base} y ${ventas(fila.sales)}` : base;
  }
  return `gastó ${formatearEur(fila.spendEur)} ${periodo === 'yesterday' ? 'ayer' : 'hoy'} con ${ventas(fila.sales)}`;
}

function ventas(n: number): string {
  return `${formatearEntero(n)} ${n === 1 ? 'venta' : 'ventas'}`;
}

/** "gasto > €4,00 y ventas = 0" — las condiciones, unidas con AND. */
function describirCondiciones(condiciones: Condicion[]): string {
  if (condiciones.length === 0) return 'sin condiciones';
  return condiciones.map(describirCondicion).join(' y ');
}

function describirCondicion(c: Condicion): string {
  const valor = formatearValor(c);
  return `${ETIQUETA_METRICA[c.metric]} ${c.op} ${valor}`;
}

function formatearValor(c: Condicion): string {
  switch (c.metric) {
    case 'sales':
    case 'impressions':
    case 'clicks':
      return formatearEntero(c.value);
    case 'roi':
    case 'roas':
    case 'ctr':
    case 'cpc':
      return formatearNumero(c.value);
    default:
      return formatearEur(c.value);
  }
}

/**
 * La acción aplicada (modo real) o el condicional (modo sombra). Para las
 * acciones de presupuesto incluye el importe antes/después y el delta.
 */
function accionAplicada(
  regla: Regla,
  fila: MetricasObjeto,
  d: Omit<Decision, 'explicacion'>,
  dryRun: boolean,
): string {
  if (regla.action === 'pause') {
    return dryRun ? 'se habría pausado' : 'se pausó';
  }
  if (regla.action === 'activate') {
    return dryRun ? 'se habría activado' : 'se activó';
  }
  // Presupuesto: de €X a €Y (+Z%).
  const antes = formatearEur((d.presupuestoAntes ?? 0) / 100);
  const despues = formatearEur((d.presupuestoDespues ?? 0) / 100);
  const pct = d.presupuestoAntes
    ? Math.round(((d.presupuestoDespues ?? 0) - d.presupuestoAntes) / d.presupuestoAntes * 100)
    : 0;
  const delta = pct >= 0 ? `+${pct}%` : `${pct}%`;
  return dryRun
    ? `el presupuesto habría pasado de ${antes} a ${despues} (${delta})`
    : `el presupuesto pasó de ${antes} a ${despues} (${delta})`;
}

/** " Estado anterior: ACTIVE." — sólo en modo real y para pause/activate. */
function estadoAnterior(regla: Regla, fila: MetricasObjeto, dryRun: boolean): string {
  if (dryRun) return '';
  if (regla.action === 'pause' || regla.action === 'activate') {
    if (fila.status) return ` Estado anterior: ${fila.status}.`;
  }
  return '';
}

/**
 * El texto de cada motivo de omisión. Exhaustivo: si se agrega un motivo a
 * `MotivoOmision` y no se escribe su texto acá, el `default` con
 * `const _: never` rompe la compilación.
 */
function motivoTexto(motivo: MotivoOmision, regla: Regla): string {
  switch (motivo) {
    case 'cooldown':
      return `hubo una acción reciente y el cooldown es de ${regla.cooldownMinutes} minutos`;
    case 'max_por_objeto':
      return `ya alcanzó el máximo de ${regla.maxActionsPerObjectPerDay} acciones por objeto en el día`;
    case 'techo_alcanzado':
      return `ya está en el techo de ${formatearEur(regla.budgetMax ?? 0)}`;
    case 'piso_alcanzado':
      return `ya está en el piso de ${formatearEur(regla.budgetMin ?? 0)}`;
    case 'sin_presupuesto_en_este_nivel':
      return 'el presupuesto no se maneja en este nivel (vive en la campaña, que es CBO)';
    case 'ya_esta_en_ese_estado': {
      const destino = regla.action === 'pause' ? 'PAUSED' : 'ACTIVE';
      return `ya está en ese estado (${destino})`;
    }
    case 'metrica_indefinida':
      return 'una métrica de la condición no se puede calcular (por ejemplo, sin gasto no hay ROI)';
    case 'fuera_de_ventana_horaria':
      return 'está fuera de la ventana horaria de la regla';
    case 'presupuesto_bajo_el_minimo':
      return 'el resultado quedaría por debajo del mínimo de presupuesto de la cuenta';
    case 'presupuesto_lifetime_no_soportado':
      return 'el objeto usa presupuesto total y este módulo sólo escribe presupuesto diario';
    case 'moneda_no_soportada':
      return 'la cuenta no factura en EUR y este módulo no convierte monedas';
    case 'zonas_horarias_mezcladas':
      return 'la regla alcanza cuentas en zonas horarias distintas, así que "hoy" no es uno solo';
    case 'tope_absoluto':
      return 'el pedido supera el tope absoluto de presupuesto diario (ads_max_daily_budget_eur)';
    case 'resultado_indeterminado_previo':
      return 'quedó una acción sin cerrar de una corrida anterior: primero hay que reconciliar';
    default: {
      const _exhaustivo: never = motivo;
      return `motivo no contemplado: ${String(_exhaustivo)}`;
    }
  }
}
