/**
 * Motor de reglas: la decisión (T16).
 *
 * Este archivo es PURO: no importa el acceso a la base, no importa el cliente de
 * Meta y no lee el entorno. Recibe una regla, sus condiciones, una fila de
 * métricas y un contexto, y devuelve una decisión. Toda la E/S vive en `repo.ts`
 * y `ejecutor.ts`. Sin esta separación, probar "qué pasa si el ROI es 1,29"
 * requeriría una cuenta de Meta.
 *
 * Dos funciones, las dos puras:
 *  - `debeCorrer`: ¿le toca correr a esta regla ahora? Una vez por regla.
 *  - `evaluar`: ¿qué se hace con este objeto? Una vez por objeto.
 */

import type { Condicion, ContextoEvaluar, Decision, MetricasObjeto, MotivoOmision, Regla } from '../tipos';

// ─────────────────────────────────────────────────────────────────────────────
// debeCorrer
// ─────────────────────────────────────────────────────────────────────────────

export type ResultadoDebeCorrer = {
  correr: boolean;
  motivo: 'ok' | 'apagada' | 'fuera_de_ventana_horaria' | 'cadencia' | 'max_corridas_diarias';
};

/**
 * ¿Le toca correr a esta regla ahora? Se pregunta UNA vez por regla, ANTES de
 * pedir las métricas: la ventana horaria y la cadencia viven acá y no en
 * `evaluar` para que una regla fuera de su ventana no escriba cientos de
 * filas de "omitida por horario" cada minuto. Fuera de ventana no se registra
 * nada, sólo se loguea.
 */
export function debeCorrer(
  regla: Regla,
  ctx: {
    ahora: Date;
    horaLocal: string;
    ultimaCorridaAt: Date | null;
    corridasHoy: number;
  },
): ResultadoDebeCorrer {
  if (!regla.enabled) return { correr: false, motivo: 'apagada' };

  if (regla.windowStart !== null && regla.windowEnd !== null) {
    if (!dentroDeVentana(ctx.horaLocal, regla.windowStart, regla.windowEnd)) {
      return { correr: false, motivo: 'fuera_de_ventana_horaria' };
    }
  }

  // Cadencia: no correr antes de que se cumpla el intervalo desde la última.
  if (regla.everyMinutes > 0 && ctx.ultimaCorridaAt !== null) {
    const desdeUltima = ctx.ahora.getTime() - ctx.ultimaCorridaAt.getTime();
    if (desdeUltima < regla.everyMinutes * 60_000) {
      return { correr: false, motivo: 'cadencia' };
    }
  }

  if (regla.maxRunsPerDay !== null && ctx.corridasHoy >= regla.maxRunsPerDay) {
    return { correr: false, motivo: 'max_corridas_diarias' };
  }

  return { correr: true, motivo: 'ok' };
}

/**
 * Ventana horaria en la zona de la cuenta (D-A10). Las horas vienen como
 * 'HH:MM' (o 'HH:MM:SS'; se recorta a 'HH:MM'): la comparación lexicográfica
 * de un string 'HH:MM' con padding de cero es una comparación correcta de
 * reloj de 24 horas.
 *
 * Si `start > end` la ventana cruza la medianoche (22:00→06:00): la condición
 * no es `h >= start && h <= end` sino `h >= start || h <= end`. Con la forma
 * ingenua, una regla nocturna nunca corre.
 */
export function dentroDeVentana(hora: string, start: string, end: string): boolean {
  const h = hora.slice(0, 5);
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  if (s <= e) return h >= s && h <= e;
  return h >= s || h <= e;
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El contexto congelado de `evaluar` (§5 del plan) más `maxDailyBudgetEur`.
 *
 * `maxDailyBudgetEur` no está en `ContextoEvaluar` (tipos.ts, congelado por
 * T13) pero el chequeo del TECHO ABSOLUTO (D-A9c, paso 6b) lo necesita: el
 * valor sale de `settings.ads_max_daily_budget_eur` y `repo.ts` lo lee junto
 * con los interruptores. El ejecutor lo inyecta acá. Si falta, se trata como
 * "no hay tope" (Infinity) para no bloquear a las reglas de presupuesto en
 * los tests que no lo fijan.
 */
export type ContextoMotor = ContextoEvaluar & { maxDailyBudgetEur?: number };

export function evaluar(
  regla: Regla,
  condiciones: Condicion[],
  fila: MetricasObjeto,
  contexto: ContextoMotor,
): Decision {
  const { accionesRealesHoy, ultimaAccionRealAt, minimoPresupuesto, maxDailyBudgetEur } = contexto;
  const ahora = contexto.ahora;

  // Las métricas con las que se decide, para congelar en ad_actions.metrics (§6
  // regla 3): el gasto de hoy cambia todo el tiempo, recalcularlo después nunca
  // reproduce la decisión.
  const metrics: Record<string, number | null> = {
    spendEur: fila.spendEur,
    sales: fila.sales,
    roi: fila.roi,
    roas: fila.roas,
    dailyBudgetEur: fila.dailyBudgetEur,
  };

  // ── Paso 1: ¿cumple las condiciones? ─────────────────────────────────────
  // Todas con AND. Una métrica null NO cumple (nunca null como 0), y la
  // decisión lleva motivo 'metrica_indefinida'. Es el falso positivo más caro
  // del motor: sin esto, `roi < 1.1` pausa un conjunto que no gastó nada.
  for (const c of condiciones) {
    const valor = valorDeMetrica(c.metric, fila);
    metrics[c.metric] = valor;
    if (valor === null) {
      return decidir(fila, false, false, 'metrica_indefinida', null, null, metrics);
    }
    if (!comparar(valor, c.op, c.value)) {
      return decidir(fila, false, false, null, null, null, metrics);
    }
  }

  // ── Paso 2: ¿la acción cambia algo? (higiene, no optimización) ───────────
  // Sin esto, una regla de "pausar si el gasto > €4" llama a la API cada minuto
  // sobre un conjunto ya pausado, gasta cuota y llena el historial.
  if (regla.action === 'pause' && fila.status === 'PAUSED') {
    return decidir(fila, true, false, 'ya_esta_en_ese_estado', null, null, metrics);
  }
  if (regla.action === 'activate' && fila.status === 'ACTIVE') {
    return decidir(fila, true, false, 'ya_esta_en_ese_estado', null, null, metrics);
  }

  // ── Paso 3: ¿el presupuesto se maneja en este nivel, de forma escribible? ─
  if (regla.action === 'budget_increase' || regla.action === 'budget_decrease') {
    // El presupuesto vive donde `budgetLevel` dice. Un conjunto de una campaña
    // CBO tiene budgetLevel 'campaign': escribir en el conjunto falla.
    if (fila.budgetLevel !== fila.level) {
      return decidir(fila, true, false, 'sin_presupuesto_en_este_nivel', null, null, metrics);
    }
    // Presupuesto TOTAL: este módulo sólo escribe daily_budget (D-A10).
    if (fila.budgetMode === 'lifetime') {
      return decidir(fila, true, false, 'presupuesto_lifetime_no_soportado', null, null, metrics);
    }
    // Sin presupuesto propio que escalar (defensivo: no debería llegar acá).
    if (fila.dailyBudgetEur === null) {
      return decidir(fila, true, false, 'sin_presupuesto_en_este_nivel', null, null, metrics);
    }
  }

  // ── Paso 4: ¿está en cooldown? ───────────────────────────────────────────
  // Sólo sobre acciones REALES (confirmado o indeterminado): las simuladas no
  // consumen cupo. Verificado en _verificacion-016.sql §8.
  if (regla.cooldownMinutes > 0 && ultimaAccionRealAt !== null) {
    const hasta = ultimaAccionRealAt.getTime() + regla.cooldownMinutes * 60_000;
    if (ahora.getTime() < hasta) {
      return decidir(fila, true, false, 'cooldown', null, null, metrics);
    }
  }

  // ── Paso 5: ¿le quedan acciones hoy? ─────────────────────────────────────
  if (accionesRealesHoy >= regla.maxActionsPerObjectPerDay) {
    return decidir(fila, true, false, 'max_por_objeto', null, null, metrics);
  }

  // ── Paso 6: presupuesto nuevo (sólo acciones de presupuesto) ─────────────
  if (regla.action === 'budget_increase' || regla.action === 'budget_decrease') {
    return evaluarPresupuesto(regla, fila, metrics, minimoPresupuesto, maxDailyBudgetEur);
  }

  // ── Paso 7: aplicar (pause / activate) ───────────────────────────────────
  return decidir(fila, true, true, null, null, null, metrics);
}

function evaluarPresupuesto(
  regla: Regla,
  fila: MetricasObjeto,
  metrics: Record<string, number | null>,
  minimoPresupuesto: number | null,
  maxDailyBudgetEur: number | undefined,
): Decision {
  // D-A6: todo en unidades mínimas (céntimos), con un solo redondeo al final.
  // `actionValue`/`budgetMax`/`budgetMin` vienen en EUR → ×100 UNA vez.
  const actual = Math.round((fila.dailyBudgetEur as number) * 100);
  const presupuestoAntes = actual;

  // D-A9: el porcentaje es un FACTOR sobre el presupuesto actual, NO un
  // incremento. 250% = actual × 2,5. Verificado contra el export real del
  // usuario, donde Utmify guarda `actionPercentInfo: 2.5` y muestra "250%".
  //
  // D-A9b: con 'fixed' el valor es un importe en EUR y EL SIGNO LO PONE LA
  // ACCIÓN. `action_value` siempre es positivo (lo fuerza el CHECK de la base),
  // así que la resta tiene que ser explícita.
  const valor = regla.actionValue as number;
  const unit = regla.actionUnit as 'percent' | 'fixed';
  const signo = regla.action === 'budget_decrease' ? -1 : 1;

  const bruto =
    unit === 'percent'
      ? actual * (valor / 100) // 250 → ×2,5 · 100 → sin cambio · 50 → la mitad
      : actual + signo * Math.round(valor * 100); // 'fixed': increase suma, decrease resta

  // `minimoPresupuesto === null` significa "no sé el mínimo", no "el mínimo es
  // 0" (D-A10): si es null se usa sólo el piso del usuario.
  const techo = regla.budgetMax !== null ? Math.round(regla.budgetMax * 100) : Infinity;
  const piso = Math.max(
    regla.budgetMin !== null ? Math.round(regla.budgetMin * 100) : 0,
    minimoPresupuesto ?? 0,
  );

  // "Ya está en el límite" se chequea ANTES del recorte: una subida con el
  // presupuesto ya en el techo es 'techo_alcanzado', no una acción que no hace
  // nada.
  if (regla.action === 'budget_increase' && actual >= techo) {
    return decidir(fila, true, false, 'techo_alcanzado', presupuestoAntes, null, metrics);
  }
  if (regla.action === 'budget_decrease' && actual <= piso) {
    return decidir(fila, true, false, 'piso_alcanzado', presupuestoAntes, null, metrics);
  }

  // Un solo redondeo, al final. Dos redondeos encadenados hacen que un factor de
  // 133% sobre 2500 dé 3324 en lugar de 3325.
  const nuevo = Math.min(Math.max(Math.round(bruto), piso), techo);

  // ── Paso 6b: TECHO ABSOLUTO (D-A9c) ──────────────────────────────────────
  // Va DESPUÉS del recorte por techo de regla y RECHAZA, no recorta: un pedido
  // de €25.000 recortado callado a €200 esconde un bug de unidades.
  if (maxDailyBudgetEur !== undefined) {
    const topeAbsoluto = Math.round(maxDailyBudgetEur * 100);
    if (nuevo > topeAbsoluto) {
      return decidir(fila, true, false, 'tope_absoluto', presupuestoAntes, null, metrics);
    }
  }

  return decidir(fila, true, true, null, presupuestoAntes, nuevo, metrics);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers puros
// ─────────────────────────────────────────────────────────────────────────────

function decidir(
  fila: MetricasObjeto,
  cumple: boolean,
  aplicar: boolean,
  motivo: MotivoOmision | null,
  presupuestoAntes: number | null,
  presupuestoDespues: number | null,
  metrics: Record<string, number | null>,
): Decision {
  return {
    objectId: fila.objectId,
    cumple,
    motivo,
    aplicar,
    presupuestoAntes,
    presupuestoDespues,
    // El renglón en castellano lo escribe `explicacion.ts` (paso posterior,
    // porque necesita `dryRun`). Acá queda vacío: el ejecutor lo rellena.
    explicacion: '',
    metrics,
  };
}

/** Resuelve la métrica de una condición contra la fila. null = no se puede calcular. */
function valorDeMetrica(metric: Condicion['metric'], fila: MetricasObjeto): number | null {
  switch (metric) {
    case 'sales':
      return fila.sales;
    case 'revenue':
      return fila.revenueEur;
    case 'spend':
      return fila.spendEur;
    case 'net':
      return fila.netEur;
    case 'profit':
      return fila.profitEur;
    case 'roi':
      return fila.roi;
    case 'roas':
      return fila.roas;
    case 'cpa':
      return fila.cpaEur;
    case 'budget':
      return fila.dailyBudgetEur;
    case 'impressions':
      return fila.impressions;
    case 'clicks':
      return fila.clicks;
    case 'ctr':
      return fila.ctr;
    case 'cpc':
      return fila.cpcEur;
  }
}

function comparar(valor: number, op: Condicion['op'], esperado: number): boolean {
  switch (op) {
    case '>':
      return valor > esperado;
    case '>=':
      return valor >= esperado;
    case '<':
      return valor < esperado;
    case '<=':
      return valor <= esperado;
    case '=':
      return valor === esperado;
    case '!=':
      return valor !== esperado;
  }
}
