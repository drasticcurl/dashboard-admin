import { existsSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { causaDeRelectura, type ObjetoPreflight } from './acciones';

/**
 * Property 1 (Bug_Condition) de `toggle-conjuntos-entrega`, task 1: el umbral de
 * relectura no tiene margen contra el período del cron.
 *
 * **El archivo tiene dos mitades con estado esperado distinto.** Todo lo que
 * sigue en este docblock es la Property 1, de la task 1, y su mitad de 2.1 está
 * ROJA a propósito. La task 5 agregó al final la Property 2 (preservación), que
 * está VERDE hoy y tiene que quedar verde: ver su propio docblock, «Esta mitad
 * del archivo PASA hoy».
 *
 * ## ESTE ARCHIVO TIENE QUE FALLAR HOY, Y EL FALLO ES EL ENTREGABLE
 *
 * Se escribe ANTES del arreglo. La mitad de 2.1 falla contra el código de hoy y
 * eso es lo que confirma que la causa es la que el diseño hipotetizó
 * (§Hypothesized Root Cause, punto 1: dos números que tienen que estar
 * relacionados y nada que lo diga). **No se arregla ni el test ni el código
 * cuando falle**: la task 11.4 vuelve a correr ESTE archivo y ahí sí tiene que
 * pasar completo.
 *
 * La otra mitad —la de 2.2— **pasa desde el principio, y eso es correcto**: es
 * la cota SUPERIOR del margen, y está acá para detectar si el arreglo la rompe.
 * Un margen mayor o igual que el período haría que un objeto que se perdió una
 * corrida (edad ≈ 2 × período) dejara de disparar la relectura, que es la razón
 * por la que la relectura existe. O sea: hoy una mitad roja y una verde; después
 * de la 11.3, las dos verdes. Las dos rojas o las dos verdes son dos formas
 * distintas de que algo esté mal.
 *
 * ## El defecto, con el número textual
 *
 * `causaDeRelectura` compara `edad > umbralSegundos` (`acciones.ts:848`), y el
 * umbral que le llega es el de `settings` (`ads_frescura_umbral_segundos`, 900 s
 * por el seed de la migración 025). El cron que refresca la jerarquía corre cada
 * 15 minutos (`deploy/cron.panel:113`, o sea 900 s: el schedule textual va en un
 * comentario de línea más abajo, porque la barra de un cron cierra un comentario
 * de bloque). Los dos números son iguales y su igualdad no está escrita en
 * ningún lado, así que TODO objeto que
 * la última corrida sana confirmó hace más de 900 s —que es cualquier objeto,
 * porque la corrida siguiente todavía no pasó— entra al camino crítico de un
 * click con una lectura a Meta que no hacía falta.
 *
 * Contraejemplo textual, medido corriendo este archivo contra el código sin
 * arreglar (el `it` de más abajo lo fija sin depender de la semilla):
 *
 *     synced_at de hace 905 s, umbral 900, período 900
 *     esperado: null   ·   devuelto hoy: 'vieja'
 *
 * y el de la property, textual, tal como lo imprimió fast-check en la corrida de
 * esta task (seed 1445730022, path "0:16:1", shrunk 2 veces):
 *
 *     Counterexample: [[908,89,909,"isoOffset"]]
 *     umbral=908 período=900 duración=89 edad=909: expected 'vieja' to be null
 *
 * O sea: un objeto que el cron confirmó hace 909 s, con una corrida que tardó
 * 89 s, en una base cuyo umbral es 908. La ventana del defecto no es sólo la de
 * 900: es `(umbral, período + duración]` para todo umbral. Otra corrida, con otra
 * semilla, dio el contraejemplo que el diseño había predicho a mano
 * (§Exploratory, punto 1):
 *
 *     Counterexample: [[900,206,901,"iso"]]
 *     umbral=900 período=900 duración=206 edad=901: expected 'vieja' to be null
 *
 * ## Por qué una property y no unos casos
 *
 * El umbral efectivo NO es 900 por definición: sale de `settings` en runtime, y
 * este repo no puede verificar qué valor tiene la base de producción (está
 * declarado como no verificable en §Testing Strategy, punto 2). Un test contra
 * 900 no diría nada de una base con otro valor, y ese es exactamente el hueco
 * que la task 11.2 —que compara la constante del período contra el crontab— no
 * puede cubrir. Acá el umbral se genera con `fc.integer`.
 *
 * ## Lo que NO se puede cuantificar, y por qué (hallazgo de esta task)
 *
 * La Property 1 del diseño está escrita sobre PARES (umbral, período). El umbral
 * se puede generar porque es un parámetro de `causaDeRelectura`; **el período
 * no**: no aparece en la firma y el arreglo (task 11.3) lo va a tomar de una
 * constante de módulo (`PERIODO_SYNC_JERARQUIA_SEGUNDOS`, espejo del crontab).
 * Generarlo libremente haría que la mitad de 2.2 fuera falsa POR CONSTRUCCIÓN
 * después del arreglo: con un período generado de 300 s el margen seguiría
 * saliendo del período real (450 s), y un objeto con edad 600 s no superaría
 * `umbral + 450`. El test estaría afirmando algo sobre un sistema que no existe.
 *
 * Así que el período —y el margen— salen del código por el puente de abajo, y lo
 * que se genera es el umbral, que es el único de los tres que un operador puede
 * mover.
 *
 * ## El puente hacia `lib/ads/frescura.ts`, que todavía no existe
 *
 * Ese módulo lo crea la task 9 (con el default 900) y la 11.1 le agrega el
 * período y `margenDeRelectura`. Hasta entonces el puente cae a los valores que
 * el diseño declara, y `npx tsc --noEmit` queda limpio en los dos mundos porque
 * el import es dinámico con especificador computado (tsc no resuelve un
 * `import()` cuyo argumento no es un literal). Mismo criterio que el puente por
 * `unknown` de `montoAmbiguo.test.ts` y `numeroDeCampo.preservacion.test.ts`,
 * para un módulo entero en lugar de un export.
 *
 * Si la 11.1 nombra la constante distinto, el puente vuelve al 900 declarado
 * acá: el test sigue diciendo la verdad sobre el período del cron —que es 900
 * mientras el crontab del repo siga en 15 minutos— y quien vigila ese nombre es
 * la 11.2. Lo que el puente NO hace es inventar el margen: si el módulo existe y
 * expone `margenDeRelectura`, se usa el suyo.
 *
 * ## Puro
 *
 * Sin base y sin red: `causaDeRelectura` es una comparación de fechas. El viaje
 * completo —preflight real, `fetchObjeto` mockeado, `settings`— está en
 * `acciones.relectura.test.ts`, que necesita Postgres y que la task 5 corre como
 * baseline de preservación.
 */

// ─── El puente hacia el módulo que la task 11.1 va a crear ───────────────────

type ModuloFrescura = {
  PERIODO_SYNC_JERARQUIA_SEGUNDOS?: number;
  margenDeRelectura?: (periodoSegundos: number) => number;
};

const RUTA_FRESCURA = path.join(process.cwd(), 'lib', 'ads', 'frescura.ts');

async function moduloFrescura(): Promise<ModuloFrescura | null> {
  if (!existsSync(RUTA_FRESCURA)) return null;
  // Especificador computado a propósito: con un literal, tsc intentaría resolver
  // un módulo que hoy no existe y `npx tsc --noEmit` dejaría de estar limpio.
  const mod: unknown = await import(/* @vite-ignore */ RUTA_FRESCURA);
  return mod as ModuloFrescura;
}

const frescura = await moduloFrescura();

/**
 * El período del cron, en segundos. Es un espejo, no la fuente: la fuente es el
 * crontab del host, y que el crontab instalado sea `deploy/cron.panel` está
 * declarado como no verificable (§Testing Strategy, punto 1). Quien vigila que
 * este número siga coincidiendo con el archivo del repo es la task 11.2.
 */
// La línea 113 de `deploy/cron.panel` empieza con `*/15`, o sea cada 15 min = 900 s.
const PERIODO_DECLARADO = 900;

const PERIODO = frescura?.PERIODO_SYNC_JERARQUIA_SEGUNDOS ?? PERIODO_DECLARADO;

/**
 * El margen. La 11.1 lo define como `período / 2`; hasta que exista, ése es el
 * valor que el diseño declara y el que este archivo usa para acotar los
 * generadores. No se usa como oráculo de nada: sólo para elegir el DOMINIO de la
 * property (ver los dos comentarios de los generadores).
 */
const MARGEN = frescura?.margenDeRelectura?.(PERIODO) ?? PERIODO / 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Un instante fijo: la edad se construye restándole segundos. */
const AHORA = new Date('2026-08-27T12:00:00.000Z');

/**
 * Las tres formas legibles en las que un `synced_at` llega de verdad: el ISO con
 * milisegundos que escribe `toISOString()`, el ISO con offset explícito, y el
 * `timestamptz` que devuelve Postgres cuando el driver lo entrega como texto.
 * `edadEnSegundos` las parsea con `new Date(string)`, así que las tres tienen que
 * dar la misma edad. Los ILEGIBLES no van acá: son ¬C₁ y los cubre la task 5.
 */
type FormaFecha = 'iso' | 'isoOffset' | 'postgres';

function escribirFecha(d: Date, forma: FormaFecha): string {
  const iso = d.toISOString(); // 2026-08-27T11:44:55.000Z
  if (forma === 'iso') return iso;
  if (forma === 'isoOffset') return iso.replace('Z', '+00:00');
  return iso.replace('T', ' ').replace('.000Z', '+00');
}

/** La fila de la jerarquía con lo mínimo que `causaDeRelectura` lee. */
function objeto(over: {
  syncedAt: string | null;
  desaparecidoAt?: string | null;
}): ObjetoPreflight {
  return {
    objectId: '120210000000000001',
    objectName: 'Conjunto frío EUR',
    accountId: 'act_1',
    status: 'ACTIVE',
    effectiveStatus: 'CAMPAIGN_PAUSED',
    campaignId: '120210000000000000',
    budgetLevel: 'adset',
    budgetMode: 'daily',
    dailyBudget: 2500,
    currency: 'EUR',
    inicioProgramado: null,
    syncedAt: over.syncedAt,
    desaparecidoAt: over.desaparecidoAt ?? null,
    statusCampania: 'PAUSED',
    statusConjunto: null,
  };
}

/** Un objeto sincronizado hace `edadSegundos`, con `desaparecido_at` nulo. */
function objetoDeEdad(edadSegundos: number, forma: FormaFecha = 'iso'): ObjetoPreflight {
  return objeto({ syncedAt: escribirFecha(new Date(AHORA.getTime() - edadSegundos * 1000), forma) });
}

// ─── Generadores ─────────────────────────────────────────────────────────────

/**
 * El umbral que `ads_frescura_umbral_segundos` puede tener, generado y no fijado
 * en 900. Las dos cotas del rango son las dos mitades de la property:
 *
 *  - **abajo, `período`**: es la condición de la Property 1 (`umbral >= período`).
 *    Por debajo del período el margen no rescata nada y el diseño lo declara como
 *    límite aceptado, no como caso a cubrir (11.1, «Límite declarado»).
 *  - **arriba, `2 × período − margen`**: es lo que hace que la mitad de 2.2 sea
 *    satisfacible. Un objeto que se perdió una corrida tiene edad ≈ 2 × período,
 *    y para que dispare relectura hace falta `umbral + margen < 2 × período`. Con
 *    un umbral mayor la relectura no se dispararía —ni hoy ni con el arreglo— y
 *    no sería un defecto: sería un operador que puso a propósito un umbral más
 *    largo que dos corridas del cron.
 */
const umbralArbitrario = fc.integer({ min: PERIODO, max: 2 * PERIODO - MARGEN - 1 });

/**
 * Cuánto tarda una corrida de la jerarquía, más el jitter del cron. Está acotada
 * al margen porque ésa es la cota INFERIOR del margen: absorber la corrida. Es
 * el número que el diseño declara elegido por argumento y no por medición
 * (§Testing Strategy, punto 3): si una corrida tardara más que el margen, este
 * generador dejaría de describir la realidad y el síntoma sería el de hoy.
 */
const duracionArbitraria = fc.integer({ min: 1, max: MARGEN });

const formaArbitraria = fc.constantFrom<FormaFecha>('iso', 'isoOffset', 'postgres');

/** (umbral, duración de la corrida, edad DENTRO de la última corrida sana, forma). */
const enLaUltimaCorrida = fc
  .tuple(umbralArbitrario, duracionArbitraria, formaArbitraria)
  .chain(([umbral, duracion, forma]) =>
    fc.tuple(
      fc.constant(umbral),
      fc.constant(duracion),
      fc.integer({ min: 0, max: PERIODO + duracion }),
      fc.constant(forma),
    ),
  );

/** (umbral, edad de un objeto que se perdió AL MENOS una corrida, forma). */
const corridaPerdida = fc.tuple(
  umbralArbitrario,
  fc.integer({ min: 2 * PERIODO, max: 2 * PERIODO + 30 * 86_400 }),
  formaArbitraria,
);

// ─── La property, las dos mitades ────────────────────────────────────────────

// Feature: toggle-conjuntos-entrega, Property 1: Bug Condition — Umbral con
// margen contra el período del cron
//
// **Validates: Requirements 2.1, 2.2, 2.4**
describe('Property 1: Umbral con margen contra el período del cron', () => {
  /**
   * MITAD DE 2.1 — FALLA HOY. Es el entregable de esta task.
   *
   * El objeto se sincronizó en la última corrida sana: su dato es lo más nuevo
   * que el cron puede haber traído, así que la decisión de una Omisión se toma
   * con él y no hace falta ninguna lectura a Meta. Hoy, para toda edad en
   * `(umbral, período + duración]`, `causaDeRelectura` devuelve `'vieja'` y mete
   * un `fetchObjeto` en el camino crítico de un click.
   */
  it('un objeto sincronizado en la última corrida sana NO dispara la relectura (2.1)', () => {
    fc.assert(
      fc.property(enLaUltimaCorrida, ([umbral, duracion, edad, forma]) => {
        const o = objetoDeEdad(edad, forma);

        expect(
          causaDeRelectura(o, umbral, AHORA),
          `umbral=${umbral} período=${PERIODO} duración=${duracion} edad=${edad} forma=${forma}`,
        ).toBeNull();
      }),
      { numRuns: 500 },
    );
  });

  /**
   * MITAD DE 2.2 — PASA HOY, Y TIENE QUE SEGUIR PASANDO.
   *
   * Está acá como cota superior del margen. Hoy pasa por una razón trivial —el
   * umbral es chico, así que todo lo viejo cae del lado de `'vieja'`— y después
   * del arreglo tiene contenido: si alguien elige un margen mayor o igual que el
   * período, una corrida perdida deja de disparar la relectura y se pierde
   * justamente el caso para el que la relectura se escribió (un objeto que el
   * cron no confirmó puede haber cambiado en Meta sin que la base lo sepa).
   */
  it('un objeto que se perdió al menos una corrida SÍ dispara la relectura (2.2)', () => {
    fc.assert(
      fc.property(corridaPerdida, ([umbral, edad, forma]) => {
        const o = objetoDeEdad(edad, forma);

        expect(
          causaDeRelectura(o, umbral, AHORA),
          `umbral=${umbral} período=${PERIODO} edad=${edad} forma=${forma}`,
        ).toBe('vieja');
      }),
      { numRuns: 500 },
    );
  });
});

// ─── Los contraejemplos concretos, sin depender de la semilla ────────────────

/**
 * El caso del reporte, con los números del mundo real. Está aparte de la
 * property para que el contraejemplo se pueda reproducir y leer sin una semilla
 * de fast-check, y para que quede escrito qué devuelve HOY cada uno.
 */
describe('los dos bordes con los números del mundo real (umbral 900, período 900)', () => {
  it('905 s: el cron acaba de confirmar el objeto y no hace falta releerlo', () => {
    // HOY: 'vieja' → una lectura a Meta en el camino crítico del click, sobre un
    // objeto que la última corrida sana confirmó hace 5 s más que el umbral.
    // Con el arreglo: 905 <= 900 + 450, así que null.
    expect(causaDeRelectura(objetoDeEdad(905), 900, AHORA)).toBeNull();
  });

  it('1350 s: el borde de arriba del margen sigue del lado de no releer', () => {
    // El último valor que el margen cubre: `edad === umbral + margen`, y la
    // comparación es `>`. HOY: 'vieja'.
    expect(causaDeRelectura(objetoDeEdad(1350), 900, AHORA)).toBeNull();
  });

  it('1351 s: un segundo más y la relectura vuelve a dispararse', () => {
    // Pasa hoy y tiene que seguir pasando: el margen mueve el borde, no lo borra.
    expect(causaDeRelectura(objetoDeEdad(1351), 900, AHORA)).toBe('vieja');
  });

  it('1810 s: el objeto que la última corrida no trajo se relee igual (2.2)', () => {
    // La fila «edad 1810 s» de la tabla de §Examples del diseño. Pasa hoy.
    expect(causaDeRelectura(objetoDeEdad(1810), 900, AHORA)).toBe('vieja');
  });
});
// ═════════════════════════════════════════════════════════════════════════════
// Task 5 — Property 2 (Preservation): «no sé de cuándo es este dato» sigue
// releyendo. TODO LO DE ACÁ ABAJO PASA HOY, contra el código SIN arreglar.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * ## Esta mitad del archivo PASA hoy, y por eso está escrita antes del arreglo
 *
 * Un test de preservación que nunca se corrió antes del arreglo no prueba que el
 * arreglo preservó nada: prueba que el arreglo es consistente consigo mismo. Así
 * que se escribe acá, en la misma ventana en la que la mitad de 2.1 de arriba
 * está roja, y se lo ve pasar.
 *
 * **Ojo con leer el docblock de arriba de más:** «este archivo tiene que fallar
 * hoy» vale para la Property 1 y sólo para su mitad de 2.1. Los tres casos de
 * abajo tienen que estar VERDES hoy y seguir verdes después de la task 11. Un
 * fallo acá, en cualquiera de los dos momentos, es una regresión.
 *
 * ## El baseline de la tanda A, corrido en esta task (2026-08-27)
 *
 * `lib/ads/acciones.relectura.test.ts` — **10 passed**, ni un cambio en el
 * archivo. Los seis casos que la task 5 nombra, textuales, todos ✓:
 *
 *  1. «un Objeto_Desaparecido se relee aunque su dato esté fresco»
 *  2. «si fetchObjeto tira, se decide con la base y se anota, sin bloquear la acción»
 *  3. «si Meta no devuelve el objeto, queda no_encontrado y el estado local no se toca»
 *  4. «un lote con más candidatos que el tope relee 10 y anota el resto»
 *  5. «con un backoff por cuota activo no se le suma ni una lectura a Meta»
 *  6. «el presupuesto de tiempo corta el lote sin dejar la lectura colgada» (4.0 s)
 *
 * `app/api/ads/acciones/route.edad.test.ts` — **5 passed**, sin cambios.
 *
 * ## Por qué ninguno de esos once cambia cuando entre el margen (verificado, no supuesto)
 *
 * El margen mueve UN número: el borde pasa de 900 a 1350 s (umbral 900 + 450).
 * Las fechas de esos archivos están a dos órdenes de magnitud del borde, así que
 * las dos siguen del mismo lado:
 *
 * | Archivo | Fecha | Edad | Hoy (>900) | Con margen (>1350) |
 * |---|---|---|---|---|
 * | `acciones.relectura.test.ts` | `VIEJO` | 48 h = 172 800 s | `'vieja'` | `'vieja'` |
 * | `acciones.relectura.test.ts` | `FRESCO` | 60 s | `null` | `null` |
 * | `route.edad.test.ts` | `VIEJO` | 5 d = 432 000 s | `'vieja'` | `'vieja'` |
 * | `route.edad.test.ts` | el fresco | `now()`, ~0 s | `null` | `null` |
 *
 * El margen tendría que valer 171 900 s (casi dos días) para mover el `VIEJO` de
 * 48 h, y negativo para mover el `FRESCO`. **Si alguno de esos archivos falla
 * después de la task 11, es una regresión del arreglo y no un caso esperado**, y
 * la primera cosa a mirar es si el margen se colgó de `frescuraDeFila` —que no
 * lleva margen (decisión A1)— en lugar de sólo de `causaDeRelectura`.
 *
 * ## Los dos casos que hoy NO tenían test
 *
 * `synced_at` nulo y `synced_at` ilegible están escritos en el comentario de
 * `causaDeRelectura` («un `synced_at` nulo o ilegible cuenta como viejo») y hasta
 * acá estaban verificados **por lectura y no por ejecución**. Son justo los dos
 * que el margen podría romper, porque los dos terminan en el mismo `if` que el
 * arreglo toca:
 *
 *     if (edad === null || edad > umbralSegundos) return 'vieja';
 *
 * Con `edad === null` la segunda mitad del `||` no se evalúa, así que el número
 * comparado es irrelevante: **3.15 se preserva por la forma del código, no por
 * cuidado**. Eso es una afirmación sobre el cortocircuito, y es exactamente lo
 * que estos tests fijan antes de que alguien reordene ese `if`. El día que la
 * comparación se mueva arriba del `edad === null`, o que el margen entre como un
 * `Math.min`/`Math.max` sobre la edad en lugar de sobre el umbral, estos tres
 * casos se ponen rojos y el que lo hizo se entera en la misma corrida.
 *
 * ## Cómo se cuantifica sobre el margen contra un código que todavía no lo tiene
 *
 * `causaDeRelectura` hoy no recibe margen: la task 11.3 cambia UNA línea y el
 * número comparado pasa de `umbralSegundos` a `umbralSegundos + margen`. O sea
 * que evaluar la función de HOY con `umbral + margen` es, término por término, la
 * comparación de MAÑANA. Por eso `conYSinMargen` la corre con los dos números y
 * afirma que dan lo mismo: eso es «ningún margen los toca» y no «con 450 no se
 * rompen», y es verificable hoy sin tocar el código.
 *
 * El margen generado va **a propósito más allá** de lo que un margen sano puede
 * valer (la cota superior es `margen < período`, la mitad de 2.2 de arriba). Si
 * alguno de estos tres casos se rompiera con un margen absurdo, sería porque está
 * comparando la edad —y lo que se está afirmando es que no la mira.
 */

/**
 * El umbral, sin las cotas de la Property 1. Acá no hacen falta: estos tres
 * casos no comparan la edad, así que el dominio es todo lo que `settings` puede
 * llegar a tener, incluido el 0.
 */
const umbralCualquiera = fc.integer({ min: 0, max: 10 * PERIODO });

/** El margen candidato, deliberadamente más ancho que un margen sano. */
const margenCandidato = fc.integer({ min: 0, max: 4 * PERIODO });

/**
 * Textos que `new Date()` deja en `Invalid Date`. Salen de las formas en las que
 * un `synced_at` llega roto de verdad: la columna vacía, el `''` de un import, el
 * texto de un `NULL` serializado a mano, y una fecha con campos fuera de rango.
 * El propio test verifica que sigan siendo ilegibles (ver la primera línea de la
 * property): un generador que dejara de cumplir su premisa haría pasar el test
 * por la razón equivocada.
 */
const fechaIlegible = fc.constantFrom(
  '',
  '   ',
  'no es una fecha',
  '0000-00-00',
  '2026-13-01',
  '2026-08-27T99:99:99Z',
  'null',
  'undefined',
  'NaN',
  'now()',
  '20260827',
);

/** Edades legibles, de recién sincronizado a un mes de atraso. */
const edadCualquiera = fc.integer({ min: 0, max: 30 * 86_400 });

/**
 * Todo lo que la columna `synced_at` puede tener: nulo, ilegible, o legible con
 * cualquier edad y en cualquiera de las tres formas. Es el dominio del caso de la
 * marca de desaparición, que tiene que devolver `'desaparecida'` para todos.
 */
const syncedAtCualquiera: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fechaIlegible,
  fc
    .tuple(edadCualquiera, formaArbitraria)
    .map(([edad, forma]) => escribirFecha(new Date(AHORA.getTime() - edad * 1000), forma)),
);

/** Las formas en las que `desaparecido_at` llega cuando el cron no vio la fila. */
const desaparecidoArbitrario = fc
  .tuple(fc.integer({ min: 0, max: 30 * 86_400 }), formaArbitraria)
  .map(([edad, forma]) => escribirFecha(new Date(AHORA.getTime() - edad * 1000), forma));

/**
 * `causaDeRelectura` con el umbral pelado Y con `umbral + margen`, que es el
 * número que la task 11.3 va a comparar. Los dos resultados tienen que ser el
 * mismo: ahí está la cuantificación sobre el margen.
 */
function conYSinMargen(
  o: ObjetoPreflight,
  umbral: number,
  margen: number,
): ('vieja' | 'desaparecida' | null)[] {
  return [causaDeRelectura(o, umbral, AHORA), causaDeRelectura(o, umbral + margen, AHORA)];
}

// Feature: toggle-conjuntos-entrega, Property 2: Preservation — «No sé de cuándo
// es este dato» sigue releyendo
//
// **Validates: Requirements 3.15, 3.16**
describe('Property 2: «no sé de cuándo es este dato» sigue releyendo', () => {
  /** 3.15, primer caso sin test hasta hoy. PASA contra el código sin arreglar. */
  it('un synced_at NULO sigue devolviendo vieja, para todo umbral y todo margen', () => {
    fc.assert(
      fc.property(umbralCualquiera, margenCandidato, (umbral, margen) => {
        const o = objeto({ syncedAt: null });

        for (const causa of conYSinMargen(o, umbral, margen)) {
          expect(causa, `umbral=${umbral} margen=${margen} synced_at=null`).toBe('vieja');
        }
      }),
      { numRuns: 500 },
    );
  });

  /** 3.15, segundo caso sin test hasta hoy. PASA contra el código sin arreglar. */
  it('un synced_at ILEGIBLE sigue devolviendo vieja, para todo umbral y todo margen', () => {
    fc.assert(
      fc.property(umbralCualquiera, margenCandidato, fechaIlegible, (umbral, margen, texto) => {
        // La premisa del generador, verificada y no supuesta: si alguno de estos
        // textos dejara de ser `Invalid Date`, el caso ya no sería el de 3.15 y
        // el test lo diría acá, en lugar de pasar por la razón equivocada.
        expect(
          Number.isNaN(new Date(texto).getTime()),
          `«${texto}» ya no es ilegible para new Date()`,
        ).toBe(true);

        const o = objeto({ syncedAt: texto });

        for (const causa of conYSinMargen(o, umbral, margen)) {
          expect(causa, `umbral=${umbral} margen=${margen} synced_at=«${texto}»`).toBe('vieja');
        }
      }),
      { numRuns: 500 },
    );
  });

  /**
   * 3.15, el tercero: éste sí tiene test de integración
   * (`acciones.relectura.test.ts`, «un Objeto_Desaparecido se relee aunque su
   * dato esté fresco»), pero con UNA fecha fresca y UN umbral. Acá se cuantifica:
   * la marca gana para toda edad —fresca, vieja, nula o ilegible— y para todo
   * margen, porque el `return` de la marca está ANTES de que la edad se calcule.
   */
  it('desaparecido_at no nulo sigue devolviendo desaparecida ANTES de mirar la edad', () => {
    fc.assert(
      fc.property(
        umbralCualquiera,
        margenCandidato,
        syncedAtCualquiera,
        desaparecidoArbitrario,
        (umbral, margen, syncedAt, desaparecidoAt) => {
          const o = objeto({ syncedAt, desaparecidoAt });

          for (const causa of conYSinMargen(o, umbral, margen)) {
            expect(
              causa,
              `umbral=${umbral} margen=${margen} synced_at=${JSON.stringify(syncedAt)} desaparecido_at=${desaparecidoAt}`,
            ).toBe('desaparecida');
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  /**
   * El contraste que le da contenido al caso de arriba. Sin esto, «devuelve
   * desaparecida para todo synced_at» se podría cumplir con una función que
   * devuelve siempre `'desaparecida'`: lo que hay que ver es que el MISMO dato
   * fresco, sin la marca, no dispara nada.
   */
  it('y el mismo dato fresco SIN la marca no dispara nada: la marca es la que decide', () => {
    const fresco = escribirFecha(new Date(AHORA.getTime() - 60_000), 'iso');

    expect(causaDeRelectura(objeto({ syncedAt: fresco, desaparecidoAt: null }), 900, AHORA)).toBeNull();
    expect(
      causaDeRelectura(objeto({ syncedAt: fresco, desaparecidoAt: '2026-08-27T11:00:00.000Z' }), 900, AHORA),
    ).toBe('desaparecida');
  });
});
