/**
 * Coherencia de una Regla: las configuraciones que se pueden guardar pero no
 * pueden funcionar.
 *
 * QUÉ HACE ACÁ Y NO EN EL FORMULARIO
 * Estas comprobaciones las usan las dos puntas: `ReglasView` para deshabilitar
 * Guardar y decir en qué pestaña está el problema, y `/api/ads/reglas` para
 * cortar con 400 lo que llegue por otro camino (un script, un curl, un import).
 * Escritas dos veces se desincronizan: la del formulario se afloja para
 * desbloquear a alguien y la del API queda distinta, y a partir de ahí el
 * mensaje que ve el usuario no corresponde a lo que la base acepta. Módulo puro,
 * sin `db` ni `fetch`, para que lo pueda importar un componente cliente.
 *
 * QUÉ NO VALIDA
 * Nada de lo que ya cubre el schema de zod (formatos, rangos, campos
 * obligatorios de presupuesto) ni los CHECK de la 016. Acá sólo van las
 * combinaciones VÁLIDAS por separado que juntas no hacen nada:
 *
 *   - una ventana horaria de un minuto,
 *   - un alcance que la acción no puede tocar,
 *   - dos condiciones sobre la misma métrica que no pueden cumplirse juntas.
 *
 * Las tres tienen la misma pinta desde afuera: una regla prendida, sin ningún
 * error, que nunca ejecuta nada. Eso es lo más caro que puede pasar en este
 * módulo, porque no se nota hasta que se busca en el historial por qué el gasto
 * siguió subiendo.
 */

export type CondicionCoherencia = {
  metric: string;
  op: string;
  /** Ya numérico. El formulario valida antes que no esté vacío. */
  value: number;
};

/** Sin etiquetas lindas, el nombre crudo de la métrica alcanza para el 400. */
type Etiqueta = (metric: string) => string;
const CRUDA: Etiqueta = (m) => m;

// ─────────────────────────────────────────────────────────────────────────────
// Ventana horaria
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La ventana va completa o vacía, y con las dos horas distintas.
 *
 * Lo de las horas iguales no es una preferencia de estilo: `dentroDeVentana`
 * (motor.ts) con inicio == fin compara `h >= s && h <= e`, así que sólo matchea
 * ese minuto exacto. La regla queda prendida y con 60 segundos por día para
 * correr; con cadencia de 15 minutos, el tick nunca cae ahí.
 */
export function motivoVentanaInvalida(
  windowStart: string | null | undefined,
  windowEnd: string | null | undefined,
): string | null {
  const desde = (windowStart ?? '').trim();
  const hasta = (windowEnd ?? '').trim();
  if ((desde === '') !== (hasta === '')) {
    return 'La ventana horaria va completa o vacía: elegí «Cualquiera» o las dos horas.';
  }
  if (desde !== '' && desde === hasta) {
    return `Con inicio y fin en ${desde} la regla sólo podría correr en ese minuto exacto: elegí horas distintas, o «Cualquiera» para que corra a toda hora.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alcance contra acción
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pausar lo que ya está pausado (o activar lo que ya está activo) es un no-op
 * garantizado, no una regla conservadora.
 *
 * Son dos frenos encadenados: el alcance sólo trae objetos con ese estado
 * (`getMetricasAds({ status })`) y el motor descarta a cada uno con
 * 'ya_esta_en_ese_estado' (paso 2). No hay dato que pueda hacer que esta regla
 * actúe alguna vez.
 *
 * Con 'any' no aplica: ahí sí hay objetos del otro estado para tocar.
 */
export function motivoAlcanceInutil(action: string, statusFilter: string): string | null {
  if (action === 'pause' && statusFilter === 'paused') {
    return 'Una regla que pausa y sólo mira objetos PAUSADOS no puede hacer nada nunca: poné el estado en «Activos» (o «Cualquier estado»).';
  }
  if (action === 'activate' && statusFilter === 'active') {
    return 'Una regla que activa y sólo mira objetos ACTIVOS no puede hacer nada nunca: poné el estado en «Pausados» (o «Cualquier estado»).';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Condiciones que se contradicen
// ─────────────────────────────────────────────────────────────────────────────

type Cota = { v: number; estricta: boolean };

const masAlta = (a: Cota, b: Cota): Cota => (b.v > a.v || (b.v === a.v && b.estricta) ? b : a);
const masBaja = (a: Cota, b: Cota): Cota => (b.v < a.v || (b.v === a.v && b.estricta) ? b : a);

/**
 * Dos condiciones sobre la MISMA métrica que no pueden cumplirse a la vez.
 *
 * Las condiciones se combinan con Y (no hay OR), así que «gasto > 10» y
 * «gasto < 5» describen un conjunto vacío: la regla es correcta, guardable, y
 * no va a actuar sobre un solo objeto en su vida. El caso típico no es tan
 * obvio como ese: es duplicar una regla, cambiarle el operador a una condición
 * y olvidarse de borrar la vieja.
 *
 * Se resuelve por métrica armando el intervalo factible con las cotas (>, >=,
 * <, <=) y cruzándolo con los iguales y distintos. Métricas distintas no se
 * comparan: no hay forma de saber si «ventas >= 1» y «gasto < 1» son
 * compatibles sin los datos, y sí la hay dentro de una misma métrica.
 */
export function motivoCondicionesImposibles(
  condiciones: readonly CondicionCoherencia[],
  etiqueta: Etiqueta = CRUDA,
): string | null {
  const porMetrica = new Map<string, CondicionCoherencia[]>();
  for (const c of condiciones) {
    if (!Number.isFinite(c.value)) continue;
    porMetrica.set(c.metric, [...(porMetrica.get(c.metric) ?? []), c]);
  }

  // `Array.from` y no `for...of` sobre el Map: el tsconfig no fija `target`, así
  // que iterar un Map directo pide --downlevelIteration. Mismo patrón que el
  // resto del repo con los Set.
  for (const [metric, cs] of Array.from(porMetrica.entries())) {
    if (cs.length < 2) continue;

    let lo: Cota = { v: Number.NEGATIVE_INFINITY, estricta: false };
    let hi: Cota = { v: Number.POSITIVE_INFINITY, estricta: false };
    const iguales = new Set<number>();
    const distintos = new Set<number>();

    for (const c of cs) {
      if (c.op === '>') lo = masAlta(lo, { v: c.value, estricta: true });
      else if (c.op === '>=') lo = masAlta(lo, { v: c.value, estricta: false });
      else if (c.op === '<') hi = masBaja(hi, { v: c.value, estricta: true });
      else if (c.op === '<=') hi = masBaja(hi, { v: c.value, estricta: false });
      else if (c.op === '=') iguales.add(c.value);
      else if (c.op === '!=') distintos.add(c.value);
    }

    const m = etiqueta(metric);

    if (iguales.size > 1) {
      const [a, b] = Array.from(iguales);
      return `Las condiciones piden que ${m} sea igual a ${a} y a ${b} al mismo tiempo: nunca se van a cumplir juntas.`;
    }

    // El intervalo de las cotas está vacío: (5, 5) o [7, 3].
    if (lo.v > hi.v || (lo.v === hi.v && (lo.estricta || hi.estricta))) {
      return `Ningún valor de ${m} cumple las dos condiciones a la vez: la regla no va a actuar nunca.`;
    }

    if (iguales.size === 1) {
      const v = Array.from(iguales)[0]!;
      if (distintos.has(v)) {
        return `Las condiciones piden que ${m} sea y no sea ${v} al mismo tiempo: nunca se van a cumplir juntas.`;
      }
      const fueraPorAbajo = v < lo.v || (v === lo.v && lo.estricta);
      const fueraPorArriba = v > hi.v || (v === hi.v && hi.estricta);
      if (fueraPorAbajo || fueraPorArriba) {
        return `${m} igual a ${v} queda afuera del rango que piden las otras condiciones: nunca se van a cumplir juntas.`;
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Todo junto
// ─────────────────────────────────────────────────────────────────────────────

export type ReglaCoherencia = {
  action: string;
  statusFilter: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  conditions?: readonly CondicionCoherencia[];
};

/**
 * El primer motivo por el que la Regla no podría funcionar, o null.
 * Es lo que usa el API; el formulario llama a cada una por separado para poder
 * señalar la pestaña.
 */
export function motivoIncoherente(r: ReglaCoherencia, etiqueta: Etiqueta = CRUDA): string | null {
  return (
    motivoAlcanceInutil(r.action, r.statusFilter) ??
    motivoVentanaInvalida(r.windowStart, r.windowEnd) ??
    motivoCondicionesImposibles(r.conditions ?? [], etiqueta)
  );
}
