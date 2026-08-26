import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parsearPresupuesto, textoDeMotivo, type PresupuestoParseado } from '@/lib/ads/presupuesto';
// La task 3.1 movió este módulo de `app/(panel)/finanzas/monto.ts` a
// `lib/monto.ts` y este import se actualizó con el movimiento: fue el único
// ajuste que hizo falta acá. Vale anotar que la 3.1 declaraba un solo import a
// actualizar (el de `FinanzasView.tsx`) y eran dos, porque este archivo lo
// agregó la task 1, después de que la 3.1 se escribiera.
import { parsearMonto } from '@/lib/monto';
import * as Reglas from './reglas/ReglasView';
import {
  payloadDeForm,
  problema,
  problemaAccion,
  problemaCondiciones,
  problemaProgramacion,
} from './reglas/ReglasView';
import { formBase, type FormEstado } from './reglas/_formBase';

/**
 * Feature: parseo-montos-anuncios — Property 1: Bug Condition
 *
 * **Validates: Requirements 1.1, 1.6, 1.7, 1.8, 1.9, 2.1, 2.6, 2.7, 2.8, 2.9**
 *
 * ESTE ARCHIVO SE ESCRIBIÓ PARA FALLAR, y el fallo fue el entregable de la task
 * 1: es lo que confirma que la causa raíz es la que hipotetizó el diseño
 * (§Hypothesized Root Cause) y no otra. Las aserciones afirman el comportamiento
 * ESPERADO —rechazo con las dos lecturas y ningún valor en ningún payload—, no
 * el actual. La task 3.7 vuelve a correr ESTE MISMO archivo y ahí tiene que
 * pasar.
 *
 * Cruza `lib/ads/presupuesto` y `reglas/ReglasView` a propósito: es lo que hace
 * de esto un bug y no cuatro. Los cuatro parseos son funciones puras, así que no
 * hay base, ni red, ni render, ni nada que mockear.
 *
 * ─── LOS CONTRAEJEMPLOS, CORRIDOS CONTRA EL CÓDIGO SIN ARREGLAR ─────────────
 *
 * Salen de correr los módulos reales (vitest, environment node), no de leer el
 * código. Los seis casos del diseño reprodujeron EXACTAMENTE el veredicto que
 * §Exploratory Bug Condition Checking predijo, así que la condición de corte de
 * la task 1 no se disparó y la hipótesis quedó confirmada:
 *
 *   1. parsearPresupuesto('1.000', 5000)        → {"ok":true,"valor":1}
 *   2. numeroDeTexto('1.000')                   → 1
 *      problemaAccion(actionValue '1.000')      → null      ← aprueba 1 por 1000
 *      payloadDeForm(...).actionValue           → 1
 *   3. problemaCondiciones(spend > '1.000')     → null
 *      payloadDeForm(...).conditions            → [{"metric":"spend","op":">","value":1}]
 *   4. problemaProgramacion(maxRunsPerDay '1.000') → null
 *      payloadDeForm(...).maxRunsPerDay         → 1
 *   5. parsearPresupuesto('1000.000', 5000)     → {"ok":true,"valor":1000}
 *   6. parsearPresupuesto('100,50', 5000)       → {"ok":false,"motivo":"no_numero"}
 *      parsearMonto('100,50')                   → {"ok":true,"valor":100.5}
 *
 * Y los que aparecieron de más al medir, todos del mismo modo de falla:
 *
 *   problemaAccion(budgetMax '1.000') → null,  payloadDeForm(...).budgetMax → 1
 *   problemaAccion(budgetMin '1.000') → null,  payloadDeForm(...).budgetMin → 1
 *   problema(f) → null para los CINCO campos: el botón Guardar queda habilitado
 *   numeroDeTexto('1.500') → 1.5   ·   ('2.000') → 2   ·   ('10.000') → 10
 *   parsearPresupuesto('1.500', 5000) → valor 1.5   ·   ('10.000', 5000) → valor 10
 *   parsearPresupuesto('12345.678', 5000) → sobre_el_techo (familia (e): hoy
 *     también se rechaza, pero por el techo y no por ambiguo)
 *   parsearPresupuesto('0.000', 5000) → bajo_el_minimo (dentro de C, rechazado
 *     hoy por otro motivo y con un mensaje que no ofrece ninguna lectura)
 *
 * El patrón es uno: los cuatro sitios leen un número mil veces menor y NINGUNO
 * rechaza nada. Con `actionValue: '1.000'` el formulario deja guardar una regla
 * que sube el presupuesto a 1 EUR, y con `1.000` en el diálogo el importe llega
 * a la campaña real de Meta como `daily_budget: '100'`.
 *
 * ─── Y los contraejemplos que encontraron las propiedades ───────────────────
 *
 * La semilla es distinta en cada corrida, así que el texto exacto cambia; el
 * modo de falla no. Los que salieron, con lo que fast-check reportó:
 *
 *   ["0.000", 1]      → `expected +0 to be null`: numeroDeTexto("0.000") es 0.
 *   ["1000.000"]      → `expected 1000 to be null`: la familia (e) se lee
 *                        completa, sin rechazo.
 *   ["1000.000"]      → `actionValue = "1000.000": problema() dejó guardar`
 *                        (`expected null not to be null`): el botón Guardar
 *                        queda habilitado con un techo mil veces menor.
 *   ["0.000", 1]      → el presupuesto SÍ rechaza, pero por `bajo_el_minimo`, y
 *                        el mensaje es «el importe mínimo es 0,01 EUR»: no
 *                        ofrece «0000» ni ninguna lectura, así que la persona no
 *                        tiene con qué corregir.
 *   ["1000.000", 1]   → mismo caso con `sobre_el_techo` («el importe supera el
 *                        techo de presupuesto configurado»).
 *
 * Los dos últimos son el hallazgo que la tabla de seis casos no cubría: dentro
 * de C hay textos que hoy se rechazan igual, pero por el motivo equivocado. El
 * rechazo no alcanza: 2.1 pide que el mensaje traiga las dos escrituras.
 */

// ─── Las dos lecturas de un texto ambiguo ────────────────────────────────────

/** "1.000" → "1000". La lectura como agrupación de miles. */
const sinElPunto = (texto: string): string => texto.split('.').join('');

/** "1.000" → "1". La lectura como decimal, que es la que `Number` elige. */
const truncadoEnElPunto = (texto: string): string => texto.slice(0, texto.indexOf('.'));

/**
 * `expectedBehavior` de §Expected Behavior: el mensaje del rechazo tiene que
 * traer LAS DOS escrituras posibles, no una. El valor del rechazo está en que la
 * persona elija, no en que se entere de que algo salió mal (2.1).
 */
function explicaLasDosLecturas(mensaje: string, texto: string, ctx: string): void {
  expect(mensaje, `${ctx}: el mensaje tiene que ofrecer «${sinElPunto(texto)}»`).toContain(
    sinElPunto(texto),
  );
  expect(mensaje, `${ctx}: el mensaje tiene que ofrecer «${truncadoEnElPunto(texto)}»`).toContain(
    truncadoEnElPunto(texto),
  );
}

/**
 * El mensaje de un rechazo del presupuesto, leído de forma que sirva en los dos
 * mundos: hoy sale del catálogo de `textoDeMotivo`, y con el arreglo sale del
 * campo `texto` que la task 3.3 agrega a la rama de rechazo (interpolado, porque
 * la explicación de la ambigüedad no puede salir de un `Record` fijo).
 *
 * El puente por `unknown` está a propósito: sin él, nombrar `texto` acá sería un
 * error de compilación contra el código sin arreglar, y `npx tsc --noEmit` tiene
 * que seguir limpio mientras este test falla.
 */
function mensajeDeRechazo(r: Extract<PresupuestoParseado, { ok: false }>): string {
  const propio = (r as unknown as { texto?: unknown }).texto;
  return typeof propio === 'string' ? propio : textoDeMotivo(r.motivo);
}

/**
 * El número que Reglas lee de un texto. Se resuelve por el módulo entero y no
 * por un import nombrado porque la task 3.5 reemplaza `numeroDeTexto` (devuelve
 * `number`, con NaN como única señal) por `numeroDeCampo` (devuelve estado): así
 * la aserción es la misma en los dos mundos y este archivo no hay que editarlo
 * cuando el nombre cambie. `null` significa «no leyó ningún número».
 */
function numeroQueLeeReglas(texto: string): number | null {
  const mod = Reglas as unknown as {
    numeroDeCampo?: (s: string) => { estado: string; valor?: number };
    numeroDeTexto?: (s: string) => number;
  };
  if (typeof mod.numeroDeCampo === 'function') {
    const r = mod.numeroDeCampo(texto);
    return r.estado === 'ok' && typeof r.valor === 'number' ? r.valor : null;
  }
  const n = mod.numeroDeTexto!(texto);
  return Number.isFinite(n) ? n : null;
}

// ─── El formulario de Reglas ─────────────────────────────────────────────────

// `formBase` y `FormEstado` salieron de acá en la task 4.1, a
// `reglas/_formBase.ts`: estaban copiados en tres tests y el de la 4.1 iba a ser
// la cuarta copia. Es el mismo fixture, sin un campo cambiado; lo único que se
// movió es dónde está escrito.

/**
 * Los CINCO campos numéricos de Reglas, cada uno con el estado mínimo que lo
 * pone bajo prueba sin disparar ningún otro motivo de bloqueo, y con dónde
 * aparece su número en el payload.
 *
 * `actionUnit: 'fixed'` en los tres de presupuesto es deliberado: con `percent`
 * los avisos de «un factor menor a 100 BAJA el presupuesto» taparían el motivo
 * que se está midiendo, y el test diría que bloqueó cuando bloqueó por otra cosa.
 *
 * `nombre` es el fragmento del mensaje que nombra el campo (2.6 y 2.7). Para
 * `maxRunsPerDay` va vacío: 2.8 pide que se rechace por ambiguo y no exige que
 * el mensaje lo nombre, así que exigirlo sería inventar una cláusula.
 */
const CAMPOS: readonly {
  campo: string;
  nombre: string;
  form: (texto: string) => FormEstado;
  valorEnPayload: (p: Record<string, unknown>) => unknown;
}[] = [
  {
    campo: 'actionValue',
    nombre: 'valor de la acción',
    form: (t) =>
      formBase({ action: 'budget_increase', actionUnit: 'fixed', actionValue: t, budgetMax: '9999' }),
    valorEnPayload: (p) => p.actionValue,
  },
  {
    campo: 'budgetMax',
    nombre: 'límite máximo',
    form: (t) =>
      formBase({ action: 'budget_increase', actionUnit: 'fixed', actionValue: '50', budgetMax: t }),
    valorEnPayload: (p) => p.budgetMax,
  },
  {
    campo: 'budgetMin',
    nombre: 'límite mínimo',
    form: (t) =>
      formBase({ action: 'budget_decrease', actionUnit: 'fixed', actionValue: '50', budgetMin: t }),
    valorEnPayload: (p) => p.budgetMin,
  },
  {
    campo: 'condicion',
    nombre: 'condición 1',
    form: (t) => formBase({ conditions: [{ metric: 'spend', op: '>', value: t }] }),
    valorEnPayload: (p) => (p.conditions as readonly { value: unknown }[])[0]!.value,
  },
  {
    campo: 'maxRunsPerDay',
    nombre: '',
    form: (t) => formBase({ maxRunsPerDay: t }),
    valorEnPayload: (p) => p.maxRunsPerDay,
  },
];

/**
 * «SHALL NOT existir ningún camino por el que ese texto produzca un valor
 * guardado o aplicado» (Property 1). Para los cuatro campos escalares el diseño
 * fija la forma del «ningún valor»: `valorONull`, o sea `null` y nunca 0, que es
 * la lección de 3.7. Para el `value` de una condición no la fija, así que acá se
 * exige lo que la propiedad pide y nada más: que no salga ningún número.
 */
function sinValor(valor: unknown, ctx: string): void {
  expect(
    valor === null || (typeof valor === 'number' && Number.isNaN(valor)),
    `${ctx}: el payload no puede llevar un valor, y lleva ${JSON.stringify(valor)}`,
  ).toBe(true);
}

// ─── Los seis casos del diseño, como tabla ───────────────────────────────────
// Van además de las propiedades para que el contraejemplo sea reproducible y no
// dependa de la semilla: son los seis de §Exploratory Bug Condition Checking, en
// el mismo orden, con el veredicto de hoy anotado en cada uno.

describe('los seis casos de exploración de la Bug_Condition', () => {
  const TECHO = 5000;

  it('1. el diálogo de presupuesto rechaza «1.000» y ofrece las dos lecturas', () => {
    // Hoy: {"ok":true,"valor":1}, y de ahí sale `daily_budget: '100'` a Meta.
    const r = parsearPresupuesto('1.000', TECHO);
    expect(r.ok, 'parsearPresupuesto("1.000") no puede aceptar').toBe(false);
    if (r.ok) return;
    // Sin `valor` en la rama de rechazo: la unión discriminada ya lo hace
    // imposible, así que lo único que queda por verificar es el mensaje.
    explicaLasDosLecturas(mensajeDeRechazo(r), '1.000', 'presupuesto «1.000»');
  });

  it('2. el valor de la acción no se lee como 1 y el guardado se bloquea nombrando el campo', () => {
    // Hoy: numeroDeTexto('1.000') → 1; problemaAccion → null; payload → 1.
    // Es el contraejemplo de 1.8 y 2.9: la validación aprueba un valor mil veces
    // menor porque sólo ve el número YA corrompido.
    expect(numeroQueLeeReglas('1.000'), 'Reglas no puede leer ningún número de «1.000»').toBeNull();

    const f = formBase({
      action: 'budget_increase',
      actionUnit: 'fixed',
      actionValue: '1.000',
      budgetMax: '9999',
    });
    const p = problemaAccion(f);
    expect(p, 'problemaAccion tiene que reportar el valor ambiguo').not.toBeNull();
    expect(p!).toContain('valor de la acción');
    explicaLasDosLecturas(p!, '1.000', 'actionValue «1.000»');
    sinValor(payloadDeForm(f).actionValue, 'actionValue «1.000»');
  });

  it('3. el valor de una condición no se guarda como «gasto > 1»', () => {
    // Hoy: problemaCondiciones → null y el payload lleva
    // [{"metric":"spend","op":"gt","value":1}]. En una regla de pausar, un umbral
    // mil veces más bajo pausa casi todo lo que pase el filtro de alcance.
    const f = formBase({ conditions: [{ metric: 'spend', op: '>', value: '1.000' }] });
    const p = problemaCondiciones(f);
    expect(p, 'problemaCondiciones tiene que reportar el valor ambiguo').not.toBeNull();
    expect(p!).toContain('gasto');
    expect(p!).toContain('condición 1');
    explicaLasDosLecturas(p!, '1.000', 'condición spend > «1.000»');
    sinValor((payloadDeForm(f).conditions as readonly { value: unknown }[])[0]!.value, 'condición');
  });

  it('4. el límite de ejecuciones diarias no se guarda como 1', () => {
    // Hoy: Number('1.000') es 1 y Number.isInteger(1) es true, así que pasa la
    // validación «entero mayor a 0» y se guarda 1 ejecución en lugar de 1000.
    const f = formBase({ maxRunsPerDay: '1.000' });
    const p = problemaProgramacion(f);
    expect(p, 'problemaProgramacion tiene que reportar el tope ambiguo').not.toBeNull();
    explicaLasDosLecturas(p!, '1.000', 'maxRunsPerDay «1.000»');
    sinValor(payloadDeForm(f).maxRunsPerDay, 'maxRunsPerDay «1.000»');
  });

  it('5. el borde de la regla ancha: «1000.000» también es ambiguo (familia (e))', () => {
    // Hoy: {"ok":true,"valor":1000}. Es una aceptación que el arreglo PIERDE a
    // propósito: la regla implementada no mira cuántos dígitos hay a la
    // izquierda, y angostarla rompería los veredictos que 3.13 congela.
    const r = parsearPresupuesto('1000.000', TECHO);
    expect(r.ok, 'parsearPresupuesto("1000.000") no puede aceptar').toBe(false);
    if (r.ok) return;
    explicaLasDosLecturas(mensajeDeRechazo(r), '1000.000', 'presupuesto «1000.000»');
  });

  it('6. el mismo texto con coma da el mismo veredicto en el presupuesto que en Finanzas', () => {
    // Hoy: el presupuesto devuelve {"ok":false,"motivo":"no_numero"} y Finanzas
    // {"ok":true,"valor":100.5}. El mismo panel se comporta distinto según la
    // pantalla, y la coma es como se escribe la plata en castellano (1.4 y 2.2).
    const finanzas = parsearMonto('100,50');
    expect(finanzas.ok, 'parsearMonto("100,50") acepta desde antes de este arreglo').toBe(true);

    const r = parsearPresupuesto('100,50', TECHO);
    expect(r.ok, 'el presupuesto tiene que aceptar «100,50» como Finanzas').toBe(true);
    if (!r.ok) return;
    expect(r.valor).toBe(100.5);
    expect(finanzas.ok && finanzas.valor).toBe(r.valor);
  });
});

// ─── Generadores de la familia ───────────────────────────────────────────────

/**
 * La Bug_Condition entera: un punto, cero comas, 1 a 3 dígitos a la izquierda y
 * exactamente 3 a la derecha. Es el generador de §Fix Checking, tal cual.
 */
const textoDeC: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 999 }))
  .map(([izq, der]) => `${izq}.${String(der).padStart(3, '0')}`);

/**
 * La familia (e) de §Alcance: `^\d{4,}\.\d{3}$`, 4 a 8 dígitos a la izquierda.
 * Queda fuera de la C escrita en 2.1 y se rechaza igual, porque la regla
 * implementada es más ancha a propósito.
 */
const textoDeFamiliaE: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1_000, max: 99_999_999 }), fc.integer({ min: 0, max: 999 }))
  .map(([izq, der]) => `${izq}.${String(der).padStart(3, '0')}`);

const textoAmbiguo: fc.Arbitrary<string> = fc.oneof(textoDeC, textoDeFamiliaE);

// ─── Las propiedades sobre la familia entera ─────────────────────────────────

describe('Feature: parseo-montos-anuncios, Property 1: Bug Condition', () => {
  it('para todo texto ambiguo, el diálogo de presupuesto lo rechaza y ofrece las dos lecturas', () => {
    fc.assert(
      fc.property(textoAmbiguo, fc.integer({ min: 1, max: 500_000 }), (texto, centimos) => {
        // El techo no puede cambiar el veredicto: la ambigüedad se decide antes
        // de mirar rango, así que un texto de C se rechaza con cualquier techo.
        const r = parsearPresupuesto(texto, centimos / 100);
        expect(r.ok, `parsearPresupuesto(${JSON.stringify(texto)}) aceptó`).toBe(false);
        if (r.ok) return;
        explicaLasDosLecturas(mensajeDeRechazo(r), texto, `presupuesto ${JSON.stringify(texto)}`);
      }),
      { numRuns: 300 },
    );
  });

  it('para todo texto ambiguo, Reglas no lee ningún número', () => {
    fc.assert(
      fc.property(textoAmbiguo, (texto) => {
        expect(numeroQueLeeReglas(texto), `Reglas leyó un número de ${JSON.stringify(texto)}`).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it('para todo texto ambiguo y los cinco campos de Reglas, el guardado se bloquea y el payload no lleva valor', () => {
    fc.assert(
      fc.property(textoAmbiguo, (texto) => {
        for (const c of CAMPOS) {
          const ctx = `${c.campo} = ${JSON.stringify(texto)}`;
          const f = c.form(texto);

          // `problema` es la composición que decide si Guardar está habilitado:
          // se afirma sobre ella y no sobre la `problema*` de la pestaña porque
          // lo que 2.6 y 2.7 piden es que el GUARDADO se bloquee.
          const p = problema(f);
          expect(p, `${ctx}: problema() dejó guardar`).not.toBeNull();
          if (c.nombre !== '') expect(p!, `${ctx}: el mensaje no nombra el campo`).toContain(c.nombre);
          explicaLasDosLecturas(p!, texto, ctx);

          sinValor(c.valorEnPayload(payloadDeForm(f)), ctx);
        }
      }),
      { numRuns: 300 },
    );
  });
});
