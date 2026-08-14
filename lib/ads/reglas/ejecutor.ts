/**
 * El efecto del motor (T16): orquesta métricas → decidir → escribir en Meta →
 * auditar.
 *
 * Este archivo SÍ toca base y red (a diferencia de `motor.ts` y
 * `explicacion.ts`, que son puros). Acá viven los dos frenos del modo sombra, el
 * orden de escritura de §6c (abrir la fila ANTES del POST, cerrarla después) y
 * el reconciliador de §6b. Es el task que puede gastar plata: todo lo que sigue
 * está escrito alrededor de esa frase.
 *
 * `getMetricasAds` es el stub de T13 hasta que T15 lo implemente; se importa
 * normalmente y, si se llama antes de T15, tira. Eso es lo esperado.
 */

import { enviar, fetchMinimoPresupuesto, fetchObjeto, MetaAdsError } from '../meta';
import { getMetricasAds } from '../../queries/ads';
import { debeCorrer, evaluar } from './motor';
import { explicar, formatearEur } from './explicacion';
import * as repo from './repo';
import type { Condicion, Decision, MetricasObjeto, Regla } from '../tipos';

export type ResultadoCorrida = {
  ruleId: number;
  ruleName: string;
  runId: number | null;
  corrio: boolean;
  motivoNoCorrio: string | null;
  dryRun: boolean;
  objetosEvaluados: number;
  objetosQueCumplen: number;
  ejecutadas: number;
  simuladas: number;
  omitidas: number;
  /** Las decisiones que produjeron una fila en ad_actions. T18 las manda a Telegram. */
  acciones: { objectId: string; explicacion: string; ok: boolean }[];
  error: string | null;
};

type Interruptores = Awaited<ReturnType<typeof repo.interruptores>>;

/**
 * El acumulador del tope agregado por tick (D-A9c): cuánto presupuesto sumó el
 * módulo entre TODAS las reglas y TODOS los objetos del tick. Vive en
 * `correrTodas` y se pasa a `correrRegla`, porque el límite es del tick y no de
 * la regla. `sumado` y `topeMin` van en unidades mínimas.
 */
type AcumuladorDelta = { sumado: number; topeMin: number };

type OptsCorrerRegla = {
  forzarSombra?: boolean;
  ahora?: Date;
  switches?: Interruptores;
  acumulador?: AcumuladorDelta;
};

export async function correrRegla(
  r: { regla: Regla; condiciones: Condicion[] },
  opts?: OptsCorrerRegla,
): Promise<ResultadoCorrida> {
  const { regla, condiciones } = r;
  const ahora = opts?.ahora ?? new Date();
  const switches = opts?.switches ?? (await repo.interruptores());
  const acumulador: AcumuladorDelta =
    opts?.acumulador ?? { sumado: 0, topeMin: Math.round(switches.maxDeltaPorTickEur * 100) };

  // La doble llave del modo sombra se resuelve acá y no en el worker: el flag de
  // la regla O el global de settings, para que un "correr ahora" de la UI respete
  // los mismos frenos que el cron.
  const dryRunEfectivo = regla.dryRun || switches.forzarSombra || (opts?.forzarSombra ?? false);

  const resultado: ResultadoCorrida = {
    ruleId: regla.id,
    ruleName: regla.name,
    runId: null,
    corrio: false,
    motivoNoCorrio: null,
    dryRun: dryRunEfectivo,
    objetosEvaluados: 0,
    objetosQueCumplen: 0,
    ejecutadas: 0,
    simuladas: 0,
    omitidas: 0,
    acciones: [],
    error: null,
  };

  // 1. Freno general: si está apagado, no se toca Meta NI getMetricasAds. Es la
  //    segunda llave (el worker ya lo chequeó antes del sync).
  if (!switches.habilitado) {
    resultado.motivoNoCorrio = 'apagada';
    return resultado;
  }

  // 2. debeCorrer (ventana, cadencia, max por día) — ANTES de pedir las métricas.
  //    La ventana horaria se evalúa en la zona de la cuenta (D-A10): una zona por
  //    alcance; si hay más de una, getMetricasAds tirará 'zonas_horarias_mezcladas'.
  const zonas = await repo.zonasDeCuentas(regla.accountIds);
  const horaLocal = zonas.length === 1 ? horaLocalEn(zonas[0], ahora) : null;
  const [ultimaCorridaAt, corridasHoy] = await Promise.all([
    repo.ultimaCorridaAt(regla.id),
    repo.corridasDeHoy(regla.id),
  ]);
  const debe = debeCorrer(regla, {
    ahora,
    horaLocal: horaLocal ?? '00:00',
    ultimaCorridaAt,
    corridasHoy,
  });
  if (!debe.correr) {
    resultado.motivoNoCorrio = debe.motivo;
    return resultado;
  }

  // 4. métricas. Puede TIRAR con 'zonas horarias mezcladas' (T15 §3): se captura
  //    y la regla se omite, NO se elige una zona.
  let metricas;
  try {
    metricas = await getMetricasAds({
      level: regla.level,
      period: regla.period,
      accountIds: regla.accountIds.length ? regla.accountIds : undefined,
      status: regla.statusFilter,
      limit: 1000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    resultado.corrio = true;
    resultado.error = msg;
    const runId = await repo.abrirCorrida(regla.id, dryRunEfectivo);
    resultado.runId = runId;
    await repo.cerrarCorrida(runId, {
      objetosEvaluados: 0,
      objetosQueCumplen: 0,
      accionesEjecutadas: 0,
      accionesSimuladas: 0,
      omitidas: 0,
      error: msg,
    });
    await repo.actualizarRegla(regla.id, msg);
    return resultado;
  }

  // 5. filtro por nombre según nameFilterMode (por si getMetricasAds no lo hizo).
  let filas = metricas.filas;
  if (regla.nameFilter) {
    const q = regla.nameFilter.toLowerCase();
    filas = filas.filter((f) => {
      const nombre = (f.objectName ?? '').toLowerCase();
      return regla.nameFilterMode === 'not_contains' ? !nombre.includes(q) : nombre.includes(q);
    });
  }

  // Mínimo de presupuesto por cuenta (sólo para reglas de presupuesto). null =
  // "no sé el mínimo", no "el mínimo es 0" (D-A10). Se pide una vez por cuenta.
  const esPresupuesto = regla.action === 'budget_increase' || regla.action === 'budget_decrease';
  const minimoPorCuenta = new Map<string, number | null>();
  if (esPresupuesto) {
    const cuentas = Array.from(new Set(filas.map((f) => f.accountId)));
    await Promise.all(
      cuentas.map(async (c) => {
        try {
          minimoPorCuenta.set(c, await fetchMinimoPresupuesto(c));
        } catch {
          minimoPorCuenta.set(c, null);
        }
      }),
    );
  }

  // 6. historial por objeto, UNA consulta en lote.
  const historial = await repo.historialDeHoy(filas.map((f) => f.objectId));

  // 7. abrir la corrida.
  const runId = await repo.abrirCorrida(regla.id, dryRunEfectivo);
  resultado.runId = runId;
  resultado.corrio = true;

  // 8. por cada fila.
  for (const fila of filas) {
    resultado.objetosEvaluados += 1;
    const h = historial.get(fila.objectId);

    // 3b. mutación sin cerrar → resultado_indeterminado_previo. No se decide
    //     sobre un objeto cuyo estado real no se conoce: primero se reconcilia.
    if (h?.sinCerrar) {
      const d: Decision = {
        objectId: fila.objectId,
        cumple: true,
        motivo: 'resultado_indeterminado_previo',
        aplicar: false,
        presupuestoAntes: null,
        presupuestoDespues: null,
        explicacion: '',
        metrics: metricsBase(fila),
      };
      const texto = explicar(regla, condiciones, fila, d, dryRunEfectivo);
      await repo.registrarAccion({
        runId,
        ruleId: regla.id,
        ruleName: regla.name,
        accountId: fila.accountId,
        level: fila.level,
        objectId: fila.objectId,
        objectName: fila.objectName,
        action: regla.action,
        beforeValue: null,
        afterValue: null,
        dryRun: dryRunEfectivo,
        ok: false,
        estado: 'omitido',
        skippedReason: 'resultado_indeterminado_previo',
        explicacion: texto,
        metrics: d.metrics,
      });
      resultado.omitidas += 1;
      resultado.acciones.push({ objectId: fila.objectId, explicacion: texto, ok: false });
      continue;
    }

    const decision = evaluar(regla, condiciones, fila, {
      ahora,
      horaLocal: horaLocal ?? '00:00',
      accionesRealesHoy: h?.cuenta ?? 0,
      ultimaAccionRealAt: h?.ultimaAt ?? null,
      minimoPresupuesto: minimoPorCuenta.get(fila.accountId) ?? null,
      maxDailyBudgetEur: switches.maxDailyBudgetEur,
    });

    // Los objetos que NO cumplieron no generan fila (§6 regla 2): se cuentan en
    // objetos_evaluados y ahí termina.
    if (!decision.cumple) continue;
    resultado.objetosQueCumplen += 1;

    // 4c. tope agregado por tick (D-A9c): sólo las subidas suman al acumulador.
    let decisionFinal = decision;
    if (regla.action === 'budget_increase' && decision.aplicar) {
      const delta = (decision.presupuestoDespues ?? 0) - (decision.presupuestoAntes ?? 0);
      if (delta > 0 && acumulador.sumado + delta > acumulador.topeMin) {
        decisionFinal = { ...decision, aplicar: false, motivo: 'tope_absoluto', presupuestoDespues: null };
      } else {
        acumulador.sumado += Math.max(0, delta);
      }
    }

    const texto = explicar(regla, condiciones, fila, decisionFinal, dryRunEfectivo);
    const { before, after } = valoresAntesDespues(regla, fila, decisionFinal);

    // Cumple pero un freno lo paró → una fila 'omitido' con su skipped_reason.
    if (!decisionFinal.aplicar) {
      await repo.registrarAccion({
        runId,
        ruleId: regla.id,
        ruleName: regla.name,
        accountId: fila.accountId,
        level: fila.level,
        objectId: fila.objectId,
        objectName: fila.objectName,
        action: regla.action,
        beforeValue: before,
        afterValue: after,
        dryRun: dryRunEfectivo,
        ok: false,
        estado: 'omitido',
        skippedReason: decisionFinal.motivo,
        explicacion: texto,
        metrics: decisionFinal.metrics,
      });
      resultado.omitidas += 1;
      resultado.acciones.push({ objectId: fila.objectId, explicacion: texto, ok: false });
      continue;
    }

    // Modo sombra: fila 'simulado', NUNCA se llama a Meta.
    if (dryRunEfectivo) {
      await repo.registrarAccion({
        runId,
        ruleId: regla.id,
        ruleName: regla.name,
        accountId: fila.accountId,
        level: fila.level,
        objectId: fila.objectId,
        objectName: fila.objectName,
        action: regla.action,
        beforeValue: before,
        afterValue: after,
        dryRun: dryRunEfectivo,
        ok: true,
        estado: 'simulado',
        explicacion: texto,
        metrics: decisionFinal.metrics,
      });
      resultado.simuladas += 1;
      resultado.acciones.push({ objectId: fila.objectId, explicacion: texto, ok: true });
      continue;
    }

    // REAL: abrir la fila ANTES del POST (§6c), después POST, después cerrar.
    const accionId = await repo.abrirAccion({
      runId,
      ruleId: regla.id,
      ruleName: regla.name,
      accountId: fila.accountId,
      level: fila.level,
      objectId: fila.objectId,
      objectName: fila.objectName,
      action: regla.action,
      beforeValue: before,
      afterValue: after,
      dryRun: false,
      ok: false,
      explicacion: texto,
      metrics: decisionFinal.metrics,
    });

    try {
      const rMeta = await enviar(fila.objectId, camposMeta(regla, decisionFinal));
      if (rMeta.estado === 'confirmado') {
        await repo.cerrarAccion(accionId, { estado: 'confirmado', ok: true });
        await refrescarTrasEscribir(fila);
        resultado.ejecutadas += 1;
        resultado.acciones.push({ objectId: fila.objectId, explicacion: texto, ok: true });
      } else if (rMeta.estado === 'fallido') {
        await repo.cerrarAccion(accionId, { estado: 'fallido', ok: false, error: mensajeError(rMeta.error) });
        resultado.acciones.push({ objectId: fila.objectId, explicacion: texto, ok: false });
        // Token vencido (190): van a fallar todos, cortar la corrida entera.
        if (rMeta.error?.code === 190) {
          resultado.error = mensajeError(rMeta.error);
          await repo.actualizarRegla(regla.id, resultado.error);
          break;
        }
      } else {
        // Timeout o error de red: NO SE SABE si se aplicó. Consume cupo.
        await repo.cerrarAccion(accionId, { estado: 'indeterminado', ok: false, error: mensajeError(rMeta.error) });
        resultado.acciones.push({ objectId: fila.objectId, explicacion: texto, ok: false });
      }
    } catch (e) {
      // Error inesperado: la fila queda 'indeterminado' (consume cupo) y la cierra
      // el reconciliador, que le pregunta a Meta.
      await repo.cerrarAccion(accionId, {
        estado: 'indeterminado',
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      resultado.acciones.push({ objectId: fila.objectId, explicacion: texto, ok: false });
    }
  }

  // 9. cerrar la corrida con los contadores.
  await repo.cerrarCorrida(runId, {
    objetosEvaluados: resultado.objetosEvaluados,
    objetosQueCumplen: resultado.objetosQueCumplen,
    accionesEjecutadas: resultado.ejecutadas,
    accionesSimuladas: resultado.simuladas,
    omitidas: resultado.omitidas,
    error: resultado.error,
  });
  await repo.actualizarRegla(regla.id, resultado.error);

  return resultado;
}

/** Corre todas las reglas prendidas, con el tope agregado por tick (D-A9c). */
export async function correrTodas(opts?: { ahora?: Date }): Promise<ResultadoCorrida[]> {
  const ahora = opts?.ahora ?? new Date();
  const reglas = await repo.reglasActivas();
  const switches = await repo.interruptores();
  const acumulador: AcumuladorDelta = {
    sumado: 0,
    topeMin: Math.round(switches.maxDeltaPorTickEur * 100),
  };
  const out: ResultadoCorrida[] = [];
  for (const r of reglas) {
    out.push(await correrRegla(r, { ahora, switches, acumulador }));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// reconciliar (§6b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cierra las filas de ad_actions que quedaron en 'pendiente' o 'indeterminado'.
 * Corre al PRINCIPIO de cada tick, ANTES de evaluar cualquier regla. Meta es el
 * source of truth, no la base: un 'pendiente' de hace tres minutos no significa
 * "falló", significa que el proceso murió a mitad de camino.
 */
export async function reconciliar(): Promise<{
  revisadas: number;
  confirmadas: number;
  fallidas: number;
  sinResolver: number;
}> {
  const switches = await repo.interruptores();
  // No llama a Meta si el interruptor global está apagado: las filas quedan sin
  // cerrar y los objetos bloqueados, y eso es correcto (D-A12).
  if (!switches.habilitado) {
    return { revisadas: 0, confirmadas: 0, fallidas: 0, sinResolver: 0 };
  }

  const pendientes = await repo.mutacionesSinCerrar();
  const out = { revisadas: 0, confirmadas: 0, fallidas: 0, sinResolver: 0 };

  for (const p of pendientes) {
    out.revisadas += 1;
    try {
      const objeto = await fetchObjeto(p.objectId, p.level);
      if (!objeto) {
        out.sinResolver += 1;
        continue;
      }
      const real = valorReal(objeto, p.action);
      if (p.afterValue !== null && real === p.afterValue) {
        await repo.cerrarAccion(p.id, { estado: 'confirmado', ok: true });
        out.confirmadas += 1;
      } else if (p.beforeValue !== null && real === p.beforeValue) {
        await repo.cerrarAccion(p.id, { estado: 'fallido', ok: false, error: 'el POST no llegó a aplicarse' });
        out.fallidas += 1;
      } else {
        // Otra cosa: alguien lo cambió a mano en el administrador de anuncios.
        await repo.cerrarAccion(p.id, { estado: 'confirmado', ok: true, afterValue: real });
        out.confirmadas += 1;
      }
    } catch {
      // fetchObjeto falló: se deja como está y el objeto sigue bloqueado por
      // 'resultado_indeterminado_previo' hasta el tick siguiente.
      out.sinResolver += 1;
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function horaLocalEn(tz: string, fecha: Date): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  });
  const partes = fmt.formatToParts(fecha);
  const hh = partes.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = partes.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hh}:${mm}`;
}

function metricsBase(fila: MetricasObjeto): Record<string, number | null> {
  return {
    spendEur: fila.spendEur,
    sales: fila.sales,
    roi: fila.roi,
    roas: fila.roas,
    dailyBudgetEur: fila.dailyBudgetEur,
  };
}

/** before_value y after_value: strings (§6 regla 6). Estado → 'ACTIVE'/'PAUSED'; presupuesto → EUR formateado. */
function valoresAntesDespues(
  regla: Regla,
  fila: MetricasObjeto,
  d: Decision,
): { before: string | null; after: string | null } {
  if (regla.action === 'pause') return { before: fila.status, after: 'PAUSED' };
  if (regla.action === 'activate') return { before: fila.status, after: 'ACTIVE' };
  return {
    before: d.presupuestoAntes !== null ? formatearEur(d.presupuestoAntes / 100) : null,
    after: d.presupuestoDespues !== null ? formatearEur(d.presupuestoDespues / 100) : null,
  };
}

function camposMeta(regla: Regla, d: Decision): Record<string, string> {
  if (regla.action === 'pause') return { status: 'PAUSED' };
  if (regla.action === 'activate') return { status: 'ACTIVE' };
  return { daily_budget: String(d.presupuestoDespues ?? 0) };
}

function mensajeError(e: MetaAdsError | undefined): string {
  return e?.message ?? 'error de Meta';
}

/**
 * Después de escribir, se relee el objeto en Meta y se refresca la fila de la
 * jerarquía (§6 regla 4b). Se escribe lo que Meta devuelve, no lo que se pidió.
 * Si fetchObjeto falla, la fila de ad_actions queda 'confirmado' (el cambio se
 * aplicó) pero la jerarquía se marca vieja para que el sync de T14 la refresque.
 */
async function refrescarTrasEscribir(fila: MetricasObjeto): Promise<void> {
  try {
    const objeto = await fetchObjeto(fila.objectId, fila.level);
    if (!objeto) {
      await repo.marcarJerarquiaVieja(fila.level, fila.objectId);
      return;
    }
    await repo.actualizarJerarquia(fila.level, fila.objectId, {
      status: objeto.status,
      effectiveStatus: objeto.effectiveStatus,
      dailyBudget: objeto.dailyBudget,
      lifetimeBudget: objeto.lifetimeBudget,
    });
  } catch {
    await repo.marcarJerarquiaVieja(fila.level, fila.objectId);
  }
}

/**
 * El valor real del objeto en Meta, en el mismo vocabulario de before/after:
 * para estado, 'ACTIVE'/'PAUSED'; para presupuesto, el importe EUR formateado.
 */
function valorReal(
  objeto: Awaited<ReturnType<typeof fetchObjeto>>,
  action: string,
): string | null {
  if (!objeto) return null;
  if (action === 'pause' || action === 'activate') return objeto.status;
  if (objeto.dailyBudget !== null) return formatearEur(objeto.dailyBudget / 100);
  return null;
}
