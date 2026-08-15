/**
 * Previsualizacion (task 10.1 de gestion-campanas-anuncios): el cálculo, SIN
 * ninguna llamada, de qué haría una Accion_Lote objeto por objeto, más los
 * totales del lote (R14 c2). Pura: sin `pg`, sin red y sin recibir ningún
 * cliente HTTP — no tiene CON QUÉ llamar a nada. La usa el cliente (el
 * Dialogo_Confirmacion la muestra) y el servidor (task 18.1 revalida con la
 * MISMA función), así revalidar no puede dar un resultado distinto al que el
 * usuario confirmó.
 *
 * Los cinco motivos de omisión son el conjunto cerrado de R14 c6.
 */

import type { AccionAds, MetricasObjeto, NivelAds } from './tipos';
import { aplicarRenombre, LARGO_MAX_NOMBRE, nombresDeCopias, type ModoRenombre } from './nombres';
import { MAX_SELECCION } from './seleccion';

export type MotivoOmisionLote =
  | 'ya_esta_en_ese_estado' // R14 c6
  | 'valor_igual_al_anterior'
  | 'campo_no_aplica'
  | 'no_pertenece_al_nivel'
  | 'excede_tope_de_lote';

export type FilaPrevisualizacion = {
  objectId: string;
  objectName: string | null;
  /** Lo que la acción cambia, ya formateado. null = no aplica. */
  antes: string | null;
  despues: string | null;
  /** Cuando hay motivo, el objeto se omite y no se manda. */
  motivo: MotivoOmisionLote | null;
  /** No ejecutable: el diálogo lo marca y no lo manda (R12 c6). */
  ejecutable: boolean;
  /** Aviso que no bloquea: nombre repetido entre hermanos (R12 c7), techo, etc. */
  advertencia: string | null;
};

export type DesgloseDuplicacion = {
  /**
   * Por objeto origen: cuántos descendientes tiene. Para una campaña, conjuntos
   * y anuncios; para un conjunto, anuncios (el conjunto en sí es 1 por copia).
   * Lo arma el Gestor con filas de los niveles de abajo ya cargadas (lecturas a
   * /api/data/ads, no a Meta): sin esto la previsualización queda incompleta
   * (R14 c12) y el diálogo no deja ejecutar.
   */
  porObjeto: ReadonlyMap<string, { conjuntos: number; anuncios: number }>;
};

export type ParametrosAccion = {
  /** Duplicación: copias por objeto, entera 1..5, default 1 (R10 c4). */
  copias?: number;
  /** Presupuesto en EUR, 2 decimales. */
  budgetEur?: number;
  /** Inicio programado en ISO 8601 con offset. */
  inicio?: string;
  /** Renombrado: exactamente uno de los cuatro modos (R12 c2). */
  modo?: ModoRenombre;
  /** Duplicación: el desglose de descendientes por objeto origen (R14 c5). */
  desglose?: DesgloseDuplicacion;
};

export type Previsualizacion = {
  accion: AccionAds;
  /** Nombre de la acción en castellano (R14 c3). */
  rotuloAccion: string;
  nivel: NivelAds;
  alcanzados: number;
  filas: FilaPrevisualizacion[];
  /** Sólo en duplicaciones: el desglose de R14 c5. null = no aplica. */
  aCrear: { campanias: number; conjuntos: number; anuncios: number; total: number } | null;
  /** Sólo en presupuesto: los totales de R13 c8. */
  presupuesto: { deltaTotalEur: number; topeLoteEur: number; techoEur: number } | null;
  /** false cuando faltan datos para calcular algún antes/después (R14 c12). */
  completa: boolean;
};

/** El nombre de cada acción en castellano (R14 c3, R15 c7). Record completo:
 *  agregar un valor a AccionAds sin su rótulo rompe la compilación (R15 c8). */
export const ROTULO_ACCION: Record<AccionAds, string> = {
  pause: 'pausar',
  activate: 'activar',
  budget_increase: 'subir presupuesto',
  budget_decrease: 'bajar presupuesto',
  budget_set: 'fijar presupuesto',
  config: 'configuración',
  duplicate: 'duplicar',
  rename: 'renombrar',
  schedule: 'programar inicio',
};

// Estados que Meta muestra pero no se pueden escribir (mismo conjunto que usa el
// toggle de la tabla): para estas filas la acción de estado no aplica.
export const ESTADOS_NO_ESCRIBIBLES = new Set([
  'ARCHIVED',
  'DELETED',
  'DISAPPROVED',
  'WITH_ISSUES',
  'PENDING_REVIEW',
  'IN_PROCESS',
]);

const eur = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Fechas con día, mes, año, hora y minuto (R14 c4). */
const fechaHora = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function fmtFecha(iso: string | null): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return fechaHora.format(d);
}

function fmtEur(n: number | null): string | null {
  return n === null ? null : eur.format(n);
}

/** El padre de la fila dentro de su nivel: la campaña para los conjuntos, la
 *  cuenta para las campañas. Sirve para armar los `ocupados` de los nombres. */
function padreDe(fila: MetricasObjeto): string {
  return fila.level === 'adset' ? fila.campaignId : fila.accountId;
}

function vacia(fila: MetricasObjeto): FilaPrevisualizacion {
  return {
    objectId: fila.objectId,
    objectName: fila.objectName,
    antes: null,
    despues: null,
    motivo: null,
    ejecutable: true,
    advertencia: null,
  };
}

/**
 * Calcula la Previsualizacion completa sin tocar la red (R14 c2). Los datos
 * son las filas YA cargadas en el cliente. Cuando falta una fila, o el desglose
 * de una duplicación, `completa` queda en false y el diálogo no deja ejecutar
 * (R14 c12).
 */
export function calcularPrevisualizacion(
  accion: AccionAds,
  nivel: NivelAds,
  filas: readonly MetricasObjeto[],
  seleccion: readonly string[],
  params: ParametrosAccion,
  topes: { techoEur: number; topeLoteEur: number; minimoDiarioEur: number | null },
): Previsualizacion {
  const porId = new Map(filas.map((f) => [f.objectId, f]));
  const out: FilaPrevisualizacion[] = [];
  // Los nombres ya planificados en esta corrida (duplicaciones y renombrados):
  // son parte de los `ocupados` y de la detección de repetidos entre hermanos.
  const planeados = new Map<string, string>();
  let completa = true;

  const encontradas: MetricasObjeto[] = [];
  for (let i = 0; i < seleccion.length; i++) {
    const id = seleccion[i]!;
    const fila = porId.get(id);
    if (!fila) {
      completa = false; // R14 c12: falta el dato para calcular antes/después
      continue;
    }
    if (i >= MAX_SELECCION) {
      out.push({
        objectId: id,
        objectName: fila.objectName,
        antes: null,
        despues: null,
        motivo: 'excede_tope_de_lote',
        ejecutable: false,
        advertencia: null,
      });
      continue;
    }
    encontradas.push(fila);

    if (fila.level !== nivel) {
      out.push({
        objectId: id,
        objectName: fila.objectName,
        antes: null,
        despues: null,
        motivo: 'no_pertenece_al_nivel',
        ejecutable: false,
        advertencia: null,
      });
      continue;
    }

    out.push(calcularFila(accion, nivel, fila, filas, planeados, params, topes));
  }

  const aCrear = accion === 'duplicate' ? desgloseDuplicacion(nivel, encontradas, params) : null;
  if (accion === 'duplicate' && !params.desglose) completa = false; // R14 c5 sin datos

  const presupuesto =
    accion === 'budget_set' && typeof params.budgetEur === 'number'
      ? {
          deltaTotalEur: encontradas.reduce((acc, f) => {
            const actual = f.dailyBudgetEur ?? 0;
            return acc + Math.max(0, params.budgetEur! - actual);
          }, 0),
          topeLoteEur: topes.topeLoteEur,
          techoEur: topes.techoEur,
        }
      : null;

  return {
    accion,
    rotuloAccion: ROTULO_ACCION[accion],
    nivel,
    alcanzados: out.length,
    filas: out,
    aCrear,
    presupuesto,
    completa,
  };
}

function calcularFila(
  accion: AccionAds,
  nivel: NivelAds,
  fila: MetricasObjeto,
  filasTodas: readonly MetricasObjeto[],
  planeados: Map<string, string>,
  params: ParametrosAccion,
  topes: { techoEur: number; topeLoteEur: number; minimoDiarioEur: number | null },
): FilaPrevisualizacion {
  const base = vacia(fila);

  switch (accion) {
    case 'pause':
    case 'activate': {
      const destino = accion === 'pause' ? 'PAUSED' : 'ACTIVE';
      base.antes = fila.status;
      base.despues = destino;
      if (
        ESTADOS_NO_ESCRIBIBLES.has(fila.status ?? '') ||
        ESTADOS_NO_ESCRIBIBLES.has(fila.effectiveStatus ?? '')
      ) {
        base.motivo = 'campo_no_aplica';
        base.ejecutable = false;
      } else if (fila.status === destino) {
        base.motivo = 'ya_esta_en_ese_estado';
      }
      return base;
    }

    case 'budget_set': {
      const budgetEur = params.budgetEur;
      base.antes = fmtEur(fila.dailyBudgetEur);
      base.despues = typeof budgetEur === 'number' ? fmtEur(budgetEur) : null;
      if (nivel === 'ad' || fila.budgetLevel !== nivel || fila.budgetMode === 'lifetime') {
        base.motivo = 'campo_no_aplica';
        base.ejecutable = false;
      } else if (typeof budgetEur === 'number' && fila.dailyBudgetEur === budgetEur) {
        base.motivo = 'valor_igual_al_anterior';
      } else if (typeof budgetEur === 'number' && budgetEur > topes.techoEur) {
        base.advertencia = `supera el Techo_Absoluto de ${fmtEur(topes.techoEur)} por objeto`;
        base.ejecutable = false;
      }
      return base;
    }

    case 'rename': {
      const modo = params.modo;
      if (!modo) {
        base.motivo = 'campo_no_aplica';
        base.ejecutable = false;
        return base;
      }
      const original = fila.objectName ?? '';
      const nombreNuevo = aplicarRenombre(original, modo).trim();
      base.antes = fila.objectName;
      base.despues = nombreNuevo;
      if (nombreNuevo === '') {
        base.advertencia = 'el nombre quedaría vacío';
        base.ejecutable = false; // R12 c6
      } else if (nombreNuevo.length > LARGO_MAX_NOMBRE) {
        base.advertencia = `supera los ${LARGO_MAX_NOMBRE} caracteres`;
        base.ejecutable = false; // R12 c6
      } else if (nombreNuevo === fila.objectName) {
        base.motivo = 'valor_igual_al_anterior'; // R12 c6: marcado como idéntico
      } else {
        // R12 c7: nombre resultante repetido entre hermanos = advertencia, no bloqueo.
        const repetido =
          filasTodas.some(
            (f) =>
              f.objectId !== fila.objectId &&
              f.objectName === nombreNuevo &&
              padreDe(f) === padreDe(fila),
          ) ||
          Array.from(planeados.entries()).some(
            ([oid, nombre]) => oid !== fila.objectId && nombre === nombreNuevo,
          );
        if (repetido) base.advertencia = 'nombre repetido entre hermanos';
      }
      planeados.set(fila.objectId, nombreNuevo);
      return base;
    }

    case 'schedule': {
      base.antes = fmtFecha(fila.inicioProgramado);
      base.despues = params.inicio ? fmtFecha(params.inicio) : null;
      if (nivel !== 'adset') {
        base.motivo = 'campo_no_aplica'; // R11 c1, c9: el inicio se programa en el conjunto
        base.ejecutable = false;
      } else if (params.inicio !== undefined && fila.inicioProgramado === params.inicio) {
        base.motivo = 'valor_igual_al_anterior';
      }
      return base;
    }

    case 'duplicate': {
      if (nivel === 'ad') {
        base.motivo = 'campo_no_aplica'; // R10 c14: este panel duplica campañas y conjuntos
        base.ejecutable = false;
        return base;
      }
      const k = params.copias ?? 1;
      // ocupados = hermanos del mismo padre que el panel conoce (las filas
      // cargadas) más los nombres ya planificados en la misma corrida.
      const ocupados = new Set(
        filasTodas
          .filter((f) => f.objectId !== fila.objectId && padreDe(f) === padreDe(fila))
          .map((f) => f.objectName ?? ''),
      );
      const nombres = nombresDeCopias(fila.objectName ?? '', k, ocupados);
      for (const n of nombres) planeados.set(`${fila.objectId}#${n}`, n);
      base.antes = fila.objectName;
      base.despues = nombres.join(' · ');
      return base;
    }

    default:
      return base;
  }
}

function desgloseDuplicacion(
  nivel: NivelAds,
  seleccionadas: readonly MetricasObjeto[],
  params: ParametrosAccion,
): { campanias: number; conjuntos: number; anuncios: number; total: number } | null {
  if (nivel === 'ad' || !params.desglose) return null;
  const k = params.copias ?? 1;
  let conjuntos = 0;
  let anuncios = 0;
  for (const f of seleccionadas) {
    const d = params.desglose.porObjeto.get(f.objectId);
    if (!d) return null; // sin el desglose no se puede prometer el número (R14 c5)
    conjuntos += (nivel === 'campaign' ? d.conjuntos : 1) * k;
    anuncios += d.anuncios * k;
  }
  const campanias = nivel === 'campaign' ? seleccionadas.length * k : 0;
  return { campanias, conjuntos, anuncios, total: campanias + conjuntos + anuncios };
}
