import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { dibujoDeEstado, senalDeEntrega, type DibujoEstado } from './celdas';
import type { MetricasObjeto, NivelAds } from '@/lib/ads/tipos';

/**
 * Property 5 (Bug_Condition) de `toggle-conjuntos-entrega`, task 3: el control no
 * habla de la entrega.
 *
 * ## ESTE ARCHIVO TIENE QUE FALLAR HOY, Y EL FALLO ES EL ENTREGABLE
 *
 * Se escribe ANTES del arreglo y **no se arregla ni el test ni el código cuando
 * falle**: la task 13.5 vuelve a correr ESTE archivo y ahí sí tiene que pasar.
 *
 * ## EL FALLO ES POR CAMPO AUSENTE, NO POR VALOR EQUIVOCADO
 *
 * Y eso es información, no un detalle de forma: el defecto es que **el dato no
 * existe**, no que esté mal calculado. `dibujoDeEstado` (`celdas.tsx:427`)
 * devuelve hoy una unión de dos ramas y la del interruptor tiene exactamente dos
 * campos —`control` y `encendido`—, así que no hay ninguna expresión en el repo
 * que derive mal la señal de entrega: no hay ninguna que la derive. Si el fallo
 * fuera por valor, el arreglo sería cambiar una comparación; siendo por campo
 * ausente, el arreglo es agregar un dato al tipo (task 13.1) y ese cambio rompe
 * a los llamadores que hoy comparan el dibujo entero con `toEqual` — los tres
 * que la task 7 dejó inventariados.
 *
 * ## Los contraejemplos, textuales, medidos contra el código sin arreglar
 *
 * El caso de los **92 de 169 conjuntos** de la cuenta real (§Bug Details, C₃):
 *
 *     ACTIVE / CAMPAIGN_PAUSED: devuelto hoy {"control":"interruptor","encendido":true},
 *       sin ningún campo de entrega:
 *       expected { control: 'interruptor', …(1) } to have property "entrega"
 *
 * O sea: un interruptor verde, `aria-checked="true"`, sin ninguna diferencia
 * visible contra los 10 conjuntos que sí entregan. Meta ya dijo que ese conjunto
 * no entrega —está en `effective_status`, en la misma fila— y el control no lo
 * usa para nada.
 *
 * El hermano por el otro antepasado, para que la señal tenga que NOMBRARLO y no
 * alcance con un booleano:
 *
 *     ACTIVE / ADSET_PAUSED: devuelto hoy {"control":"interruptor","encendido":true},
 *       sin ningún campo de entrega:
 *       expected { control: 'interruptor', …(1) } to have property "entrega"
 *
 * El de la decisión de alcance B2, que falla por la misma razón:
 *
 *     PENDING_BILLING_INFO: el campo de entrega no existe, así que ni siquiera se
 *       puede afirmar que la señal esté ausente A PROPÓSITO:
 *       expected undefined to deeply equal { estado: 'sin_senal' }
 *
 * Y el de la property, tal como lo imprimió fast-check en la corrida de esta task:
 *
 *     Property failed after 3 tests
 *     { seed: -1649821117, path: "2:0", endOnFailure: true }
 *     Counterexample: [{"objectId":"s1","level":"campaign","accountId":"act_1","status":"ACTIVE","effectiveStatus":null}]
 *     Shrunk 1 time(s)
 *     status="ACTIVE" effectiveStatus=null: el dibujo no trae ningún campo de entrega.
 *       Devuelto: {"control":"interruptor","encendido":true}: expected undefined not to be undefined
 *
 * Otra corrida, con otra semilla, shrinkeó al par vacío por el mismo camino:
 *
 *     { seed: -317889743, path: "2:0:0", endOnFailure: true }
 *     Counterexample: [{"objectId":"s1","level":"campaign","accountId":"act_1","status":"","effectiveStatus":null}]
 *     Shrunk 2 time(s)
 *     status="" effectiveStatus=null: el dibujo no trae ningún campo de entrega.
 *       Devuelto: {"control":"interruptor","encendido":false}: expected undefined not to be undefined
 *
 * **Que la property shrinkee a `effectiveStatus: null` y no al caso de los 92 es
 * un hallazgo de esta corrida y hay que leerlo bien.** El campo falta para TODO
 * par, así que el contraejemplo mínimo es un `sin_senal` y no un
 * `antepasado_apagado`: fast-check encuentra la ausencia antes que la mentira. Los
 * dos son el mismo defecto de estructura, pero pesan distinto y conviene no
 * confundirlos. En los 92 la ausencia **miente**: el control afirma con su
 * posición y su color algo que la fila desmiente. En los otros la ausencia sólo
 * impide afirmar que la señal está vacía a propósito, que es lo que el arreglo
 * convierte en un `sin_senal` explícito. Por eso los cuatro `it` de arriba están
 * además de la property: fijan los casos que importan sin depender de por dónde
 * shrinkee la semilla del día.
 *
 * Y dice una segunda cosa: la señal **no depende de `status`**. Una fila
 * `status: ''` bajo una campaña pausada tampoco entrega y también tiene que
 * decirlo, y su interruptor está APAGADO. Por eso la property cuantifica sobre el
 * par entero y no sobre `status: 'ACTIVE'`.
 *
 * ## La mitad que YA PASA, y por qué queda escrita igual
 *
 * `encendido === (status === 'ACTIVE')` pasa hoy y tiene que seguir pasando
 * después del arreglo: es 2.10 y 3.6, la ortogonalidad. La posición sale de
 * `status` y la señal de `effective_status`, y agregar la segunda no puede mover
 * la primera. Está afirmada en la MISMA property y no en un test aparte a
 * propósito: si el arreglo hiciera que `encendido` mirara el efectivo —que es la
 * forma más fácil de "arreglar" esto y la peor— este archivo lo cazaría en la
 * misma corrida en la que verifica la señal.
 *
 * ## CONDICIÓN DE CORTE
 *
 * Si este archivo NO falla, `dibujoDeEstado` no es la de `celdas.tsx:427`: alguien
 * ya agregó el campo `entrega` (y entonces la task 13.1 está hecha y este test no
 * es de exploración) o el import resuelve a otro módulo. **Parar y volver al
 * diseño** en lugar de escribir el arreglo.
 *
 * ## El generador está COPIADO de `toggleEstado.test.ts`, a propósito
 *
 * `statusArbitrario` es el de ahí, carácter por carácter. Es un `const` sin
 * exportar dentro de un archivo de test, así que copiarlo o extraerlo eran las
 * dos opciones; extraerlo es un refactor de un archivo que en este plan tiene
 * otros dos editores (la task 6 le agrega la forma `plazo` al generador y la 13.2
 * endurece sus `toEqual`). Lo que NO se hizo es escribir uno más pobre: sus
 * `null`, `''`, minúsculas y texto libre son justo los valores que a nadie se le
 * ocurren, y son los que encontraron el badge en blanco de `celdas.tsx:432`.
 *
 * ## Este archivo tiene DOS mitades y la segunda PASA
 *
 * Todo lo de arriba es la task 3 (Property 5, exploración) y **falla hoy**. Al
 * final del archivo la task 7 agregó la mitad nueva de la **Property 6
 * (preservación)**: la ortogonalidad de `encendido` contra `effective_status`, que
 * **pasa contra el código sin arreglar** y tiene que seguir pasando después. Las
 * dos viven acá porque las dos cuantifican sobre el mismo par y con el mismo
 * generador; lo que las separa es qué significa su resultado, y eso está escrito
 * en el docblock de cada una.
 */

// ─── El puente hacia el campo `entrega`, que todavía no existe ───────────────

/**
 * Los dos casos de `SenalEntrega` tal como el diseño los define (§B1): unión
 * discriminada, y **ninguno de los dos se llama `entrega`**. `sin_senal` es «Meta
 * no dice que un antepasado lo tenga sin entregar», que NO es «entrega»: un
 * `PENDING_BILLING_INFO` tampoco entrega y cae ahí.
 */
type SenalEsperada =
  | { estado: 'sin_senal' }
  | { estado: 'antepasado_apagado'; antepasado: 'campaign' | 'adset' };

/**
 * El campo `entrega` del dibujo, leído por el puente de `unknown`.
 *
 * El puente está a propósito y es el mismo criterio que `montoAmbiguo.test.ts` y
 * `numeroDeCampo.preservacion.test.ts`: sin él, nombrar `dibujo.entrega` acá
 * sería un error de compilación contra el código sin arreglar y
 * `npx tsc --noEmit` dejaría de estar limpio mientras este test falla. Un test de
 * exploración tiene que fallar por la aserción, no por el typecheck.
 *
 * Devuelve `undefined` hoy, para todo par. Cuando la task 13.1 agregue el campo,
 * el puente sigue funcionando sin cambios y se puede sacar en la 13.5.
 */
function senalDeDibujo(dibujo: DibujoEstado): unknown {
  return (dibujo as unknown as { entrega?: unknown }).entrega;
}

/**
 * La Senal_Entrega que le corresponde a un `effective_status`, según el diseño
 * (§B1, `senalDeEntrega`). Es el oráculo de la property, y **no mira `status`**:
 * eso es la ortogonalidad de 2.10 dicha en la firma.
 *
 * Los dos únicos efectivos con señal son los que Meta usa para decir «el padre lo
 * tiene apagado». Todo lo demás —incluido `PENDING_BILLING_INFO`, que tampoco
 * entrega— es `sin_senal`: ver la decisión de alcance B2 y el `it` de más abajo
 * que la fija.
 */
function senalEsperada(effectiveStatus: string | null): SenalEsperada {
  if (effectiveStatus === 'CAMPAIGN_PAUSED') return { estado: 'antepasado_apagado', antepasado: 'campaign' };
  if (effectiveStatus === 'ADSET_PAUSED') return { estado: 'antepasado_apagado', antepasado: 'adset' };
  return { estado: 'sin_senal' };
}

// ─── Helper, copiado de `toggleEstado.test.ts` ───────────────────────────────

type Fila = Pick<MetricasObjeto, 'objectId' | 'level' | 'accountId' | 'status' | 'effectiveStatus'>;

function fila(status: string | null, sobre: Partial<Fila> = {}): Fila {
  return { objectId: 's1', level: 'adset', accountId: 'act_1', status, effectiveStatus: status, ...sobre };
}

// ─── Generador, copiado de `toggleEstado.test.ts` ────────────────────────────

/**
 * Todo valor de `status` que puede llegar en una fila: los que Meta documenta,
 * los efectivos que aparecen en `effectiveStatus`, los que este cliente no
 * conoce, la cadena vacía, minúsculas y texto al azar. El peso está en los
 * conocidos para que las ramas que importan se recorran seguido, y el texto libre
 * está para que ningún caso quede afuera por no habérsele ocurrido a nadie.
 */
const statusArbitrario: fc.Arbitrary<string | null> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.constantFrom(
      'ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED', 'DISAPPROVED', 'WITH_ISSUES',
      'PENDING_REVIEW', 'IN_PROCESS', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED',
      'PENDING_BILLING_INFO', 'active', 'Active', 'paused', '',
    ),
  },
  { weight: 3, arbitrary: fc.constant(null) },
  { weight: 2, arbitrary: fc.string({ maxLength: 24 }) },
);

const filaArbitraria: fc.Arbitrary<Fila> = fc
  .tuple(statusArbitrario, statusArbitrario, fc.constantFrom<NivelAds>('campaign', 'adset', 'ad'))
  .map(([status, effectiveStatus, level]) => fila(status, { effectiveStatus, level }));

// ─── Los contraejemplos concretos ────────────────────────────────────────────

/**
 * Fijados sin depender de la semilla, con el `JSON.stringify` del dibujo en el
 * mensaje: es lo que hace que el fallo se lea sin abrir el diseño y sin correr
 * fast-check.
 */
describe('C₃: el interruptor de los 92 no dice que el objeto no entrega (1.10, 2.9)', () => {
  const CASOS: readonly (readonly [string, string, SenalEsperada])[] = [
    // El caso reportado, y el mayoritario de la cuenta: 92 de 169 conjuntos.
    ['ACTIVE', 'CAMPAIGN_PAUSED', { estado: 'antepasado_apagado', antepasado: 'campaign' }],
    // El mismo defecto por el otro antepasado. Está para que la señal tenga que
    // NOMBRAR al padre: con un booleano «no entrega» los dos casos serían
    // indistinguibles y 2.12 —el link que lleva al antepasado— no tendría de
    // dónde salir.
    ['ACTIVE', 'ADSET_PAUSED', { estado: 'antepasado_apagado', antepasado: 'adset' }],
    // Y el que prueba que la señal no sale de `status`: apagado y sin entregar
    // son dos hechos distintos, y el segundo también hay que decirlo.
    ['PAUSED', 'CAMPAIGN_PAUSED', { estado: 'antepasado_apagado', antepasado: 'campaign' }],
  ];

  for (const [status, effectiveStatus, esperada] of CASOS) {
    it(`${status} / ${effectiveStatus} trae la señal de antepasado apagado y la nombra`, () => {
      const dibujo = dibujoDeEstado(fila(status, { effectiveStatus }));

      // Que dibuje interruptor es la premisa de la property, no lo que se
      // afirma: si esto fallara, el caso sería ¬C₃ por 3.10 y el test estaría
      // mal armado.
      expect(dibujo.control).toBe('interruptor');

      // HOY: `expected { control: 'interruptor', encendido: … } to have property "entrega"`.
      // El fallo es por CAMPO AUSENTE: la rama del interruptor tiene dos campos y
      // ninguno habla de la entrega.
      expect(
        dibujo,
        `${status} / ${effectiveStatus}: devuelto hoy ${JSON.stringify(dibujo)}, sin ningún campo de entrega`,
      ).toHaveProperty('entrega');
      expect(senalDeDibujo(dibujo)).toEqual(esperada);

      // Y la posición no se mueve: el interruptor sigue reflejando el `status`
      // propio, que es el que va a invertir. 2.9 pide «en la misma posición».
      if (dibujo.control === 'interruptor') expect(dibujo.encendido).toBe(status === 'ACTIVE');
    });
  }

  it('PENDING_BILLING_INFO devuelve sin_senal: el tercer estado NO se extiende ahí (decisión B2)', () => {
    // Esta fila TAMPOCO entrega, y aun así la señal es `sin_senal`. La decisión
    // de alcance queda fijada por un test y no por un comentario, que es la
    // diferencia entre una decisión y una omisión.
    //
    // El motivo: `sin_senal` significa «Meta no dice que un ANTEPASADO lo tenga
    // sin entregar», no «entrega». Un `PENDING_BILLING_INFO` no entrega por un
    // problema de la cuenta, y no hay ninguna fila de antepasado a la que llevar
    // al usuario —que es la mitad del valor del tercer estado (2.12)—. Además ya
    // tiene su propio badge en `TablaAds.tsx:254`, que 3.17 preserva.
    //
    // Este caso también FALLA hoy, y por la MISMA razón que los otros tres: el
    // campo no existe. `undefined` no es `sin_senal`.
    const dibujo = dibujoDeEstado(fila('ACTIVE', { effectiveStatus: 'PENDING_BILLING_INFO' }));

    expect(dibujo.control).toBe('interruptor');
    expect(
      senalDeDibujo(dibujo),
      'PENDING_BILLING_INFO: el campo de entrega no existe, así que ni siquiera se puede afirmar que la señal esté ausente A PROPÓSITO',
    ).toEqual({ estado: 'sin_senal' });
    if (dibujo.control === 'interruptor') expect(dibujo.encendido).toBe(true);
  });
});

// ─── La property ─────────────────────────────────────────────────────────────

// Feature: toggle-conjuntos-entrega, Property 5: Bug Condition — El control
// distingue la entrega sin cambiar de posición
//
// **Validates: Requirements 2.9, 2.10, 2.12**
describe('Property 5: El control distingue la entrega sin cambiar de posición', () => {
  it('todo dibujo de interruptor trae la Senal_Entrega que su effective_status permite afirmar', () => {
    fc.assert(
      fc.property(filaArbitraria, (f) => {
        const dibujo = dibujoDeEstado(f);

        // La property está cuantificada SOBRE LA RAMA DEL INTERRUPTOR, y el
        // cuantificador importa: `effective_status` sí decide interruptor vs
        // badge (`NO_TOGGLEABLE` lo mira), así que la señal se afirma DENTRO de
        // esa rama y no fuera. La rama `badge` no lleva `entrega` y no tiene que
        // llevarlo (3.10), igual que no lleva `encendido`.
        if (dibujo.control === 'badge') return;

        const ctx = `status=${JSON.stringify(f.status)} effectiveStatus=${JSON.stringify(f.effectiveStatus)}`;

        // La mitad que FALLA hoy, para todo par: el campo no existe.
        expect(
          senalDeDibujo(dibujo),
          `${ctx}: el dibujo no trae ningún campo de entrega. Devuelto: ${JSON.stringify(dibujo)}`,
        ).not.toBeUndefined();

        // La mitad que dice qué señal es. Los dos efectivos de antepasado apagado
        // lo NOMBRAN; todo otro caso —incluidos `null`, `''`, minúsculas y texto
        // libre— es `sin_senal`.
        expect(senalDeDibujo(dibujo), ctx).toEqual(senalEsperada(f.effectiveStatus));

        // Y la mitad que YA PASA y tiene que seguir pasando: la posición sale de
        // `status` y de nada más. Es la MISMA comparación que invierte
        // `accionDeToggle`, y agregar la señal no puede moverla (2.10, 3.6).
        expect(dibujo.encendido, `${ctx}: la posición del interruptor`).toBe(f.status === 'ACTIVE');
      }),
      { numRuns: 500 },
    );
  });
});

// ─── La mitad nueva de la Property 6 (task 7): la ortogonalidad ──────────────

/**
 * Property 6 (Preservation) de `toggle-conjuntos-entrega`, task 7 — la mitad que
 * el tercer estado hace necesaria.
 *
 * ## ESTA MITAD PASA HOY, Y ESO ES EL PUNTO
 *
 * Al revés que todo lo de arriba: acá no hay nada que falle. Hoy es
 * **trivialmente verdadera** porque `encendido` sale de `fila.status === 'ACTIVE'`
 * (`celdas.tsx:443`) y no mira `effective_status` en ninguna rama. Lo que se está
 * protegiendo es que **siga siendo verdadera después del arreglo**, cuando
 * `dibujoDeEstado` empiece a leer `effective_status` para armar la Senal_Entrega:
 * a partir de la task 13.1 la función tiene dos consumidores del mismo campo y
 * uno de ellos NO puede influir en el otro. Es 2.10 y 3.6.
 *
 * Verla pasar ANTES es la mitad del valor: un test de preservación que se corre
 * por primera vez después del arreglo no prueba que el arreglo preservó nada,
 * prueba que es consistente consigo mismo.
 *
 * ## EL CUANTIFICADOR IMPORTA, y hay que escribirlo así
 *
 * La ortogonalidad se afirma **DENTRO de la rama del interruptor y no fuera**,
 * porque `effective_status` **sí** decide interruptor vs badge: la guarda de
 * `celdas.tsx:431` es `NO_TOGGLEABLE.has(fila.status ?? '') ||
 * NO_TOGGLEABLE.has(fila.effectiveStatus ?? '')` y mira los dos campos. O sea que
 * «`encendido` no depende de `effective_status`» es falso si se dice sobre el par
 * entero —un `ACTIVE / ARCHIVED` no tiene `encendido` en absoluto— y verdadero, y
 * es lo que hay que fijar, sobre los pares que los dos dibujan interruptor.
 *
 * Por eso la property cuantifica sobre `status` y un **PAR** de `effectiveStatus`,
 * y descarta el par en el que alguno de los dos lados cae en la rama badge. Dicho
 * de otro modo: `effective_status` puede decidir **si hay** interruptor, y no
 * puede decidir **de qué lado** está.
 *
 * ## Qué mataría este test, o sea contra qué defiende
 *
 * El arreglo «obvio» del bug 3 y el peor: hacer que `encendido` mire el efectivo,
 * y dibujar apagados a los 92 conjuntos `ACTIVE / CAMPAIGN_PAUSED`. Eso rompe la
 * invariante que sostiene al control —la fila dibujada apagada pide `activate`
 * (Property 1 de `toggleEstado.test.ts`)— porque esos conjuntos ya están `ACTIVE`
 * y el preflight omitiría el `activate` como `ya_esta_en_ese_estado`: el
 * interruptor quedaría muerto en una dirección, que es exactamente la clase de
 * bug que el spec anterior vino a arreglar. El diseño ya lo descartó en 2.9; este
 * test es el que lo hace imposible de reintroducir por accidente.
 *
 * El par que lo caza es el mixto: `ACTIVE / ACTIVE` (uno de los 10 que entregan)
 * contra `ACTIVE / CAMPAIGN_PAUSED` (uno de los 92 que no). Los dos tienen que
 * dibujarse **encendidos**. Está fijado abajo como caso concreto y además
 * generado por construcción en la segunda property, para que no dependa de por
 * dónde shrinkee la semilla del día.
 */

/**
 * Si un `effectiveStatus` deja la fila en la rama del interruptor.
 *
 * Se pregunta a `dibujoDeEstado` en lugar de copiar `NO_TOGGLEABLE` —que no está
 * exportado— porque «dibuja interruptor» es un observable de la función bajo test
 * y no una lista: si mañana alguien agrega un estado a ese Set, el generador se
 * entera solo en vez de quedar desactualizado en silencio.
 *
 * El `status` de sonda es `'ACTIVE'` a propósito: no está en `NO_TOGGLEABLE`, así
 * que lo único que puede mandar el par a la rama badge es el efectivo, que es lo
 * que se está midiendo.
 */
function efectivoDibujaInterruptor(effectiveStatus: string | null): boolean {
  return dibujoDeEstado(fila('ACTIVE', { effectiveStatus })).control === 'interruptor';
}

/** Los dos efectivos que Meta usa para decir «un antepasado lo tiene apagado». */
const EFECTIVOS_CON_SENAL = ['CAMPAIGN_PAUSED', 'ADSET_PAUSED'] as const;

function tieneSenal(effectiveStatus: string | null): boolean {
  return EFECTIVOS_CON_SENAL.includes(effectiveStatus as (typeof EFECTIVOS_CON_SENAL)[number]);
}

// Feature: toggle-conjuntos-entrega, Property 6: Preservation — Coherencia y
// accionabilidad del interruptor
//
// **Validates: Requirements 3.6, 3.7, 3.10, 3.17**
describe('Property 6: la posición del interruptor no depende de effective_status', () => {
  /**
   * Los pares concretos, fijados sin depender de la semilla. El primero es el que
   * importa: los 10 que entregan contra los 92 que no, con el MISMO `status`.
   */
  const PARES: readonly (readonly [string | null, string | null, string | null])[] = [
    // Los 10 vs los 92. Mismo `status = ACTIVE`, y los dos encendidos.
    ['ACTIVE', 'ACTIVE', 'CAMPAIGN_PAUSED'],
    // El mismo par por el otro antepasado.
    ['ACTIVE', 'ACTIVE', 'ADSET_PAUSED'],
    // El espejo apagado: los 67 conjuntos `PAUSED / PAUSED` contra un `PAUSED`
    // bajo campaña pausada. Los dos apagados, y por su `status`.
    ['PAUSED', 'PAUSED', 'CAMPAIGN_PAUSED'],
    // El que prueba que tampoco se cuela por un efectivo raro que igual dibuja
    // interruptor: `PENDING_BILLING_INFO` no está en `NO_TOGGLEABLE` (3.10) y su
    // fila tampoco entrega, y la posición sigue siendo la del `status` propio.
    ['ACTIVE', 'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED'],
    // Y los valores que a nadie se le ocurren, con el efectivo nulo y vacío:
    // ninguno de los dos está en `NO_TOGGLEABLE`, así que los dos dibujan
    // interruptor y la posición la sigue poniendo el `status`.
    [null, null, 'CAMPAIGN_PAUSED'],
    ['', '', 'ADSET_PAUSED'],
    ['UN_ESTADO_QUE_NO_CONOCEMOS', null, 'CAMPAIGN_PAUSED'],
  ];

  for (const [status, efA, efB] of PARES) {
    it(`status ${JSON.stringify(status)}: la posición no cambia entre ${JSON.stringify(efA)} y ${JSON.stringify(efB)}`, () => {
      const a = dibujoDeEstado(fila(status, { effectiveStatus: efA }));
      const b = dibujoDeEstado(fila(status, { effectiveStatus: efB }));

      // La premisa del cuantificador, afirmada y no supuesta: si alguno cayera en
      // la rama badge el par no pertenecería a la property y el caso estaría mal
      // elegido.
      expect(a.control, `${JSON.stringify(status)} / ${JSON.stringify(efA)}`).toBe('interruptor');
      expect(b.control, `${JSON.stringify(status)} / ${JSON.stringify(efB)}`).toBe('interruptor');
      if (a.control === 'badge' || b.control === 'badge') return;

      expect(a.encendido, `la posición cambió al variar el efectivo`).toBe(b.encendido);
      // Y de dónde sale: la MISMA comparación que invierte `accionDeToggle`.
      expect(a.encendido).toBe(status === 'ACTIVE');
    });
  }

  it('para todo status y todo par de effectiveStatus que los dos dibujen interruptor, encendido no cambia', () => {
    // Contadores de no-vacuidad: sin esto la property podría estar pasando porque
    // el filtro descarta todo, que es la forma más fácil de tener un test verde
    // que no mira nada.
    let pares = 0;
    let variados = 0;
    let mixtos = 0;

    fc.assert(
      fc.property(
        statusArbitrario,
        statusArbitrario,
        statusArbitrario,
        fc.constantFrom<NivelAds>('campaign', 'adset', 'ad'),
        (status, efA, efB, level) => {
          const a = dibujoDeEstado(fila(status, { effectiveStatus: efA, level }));
          const b = dibujoDeEstado(fila(status, { effectiveStatus: efB, level }));

          // EL CUANTIFICADOR: el par tiene que dibujar interruptor de los dos
          // lados. `effective_status` sí decide interruptor vs badge, así que la
          // ortogonalidad se afirma DENTRO de esa rama y no fuera.
          if (a.control === 'badge' || b.control === 'badge') return;

          pares += 1;
          if (efA !== efB) variados += 1;
          if (tieneSenal(efA) !== tieneSenal(efB)) mixtos += 1;

          const ctx = `status=${JSON.stringify(status)} efA=${JSON.stringify(efA)} efB=${JSON.stringify(efB)}`;

          // La ortogonalidad, dicha como lo que es: variar el efectivo no mueve
          // la posición.
          expect(a.encendido, `${ctx}: la posición cambió al variar el efectivo`).toBe(b.encendido);

          // Y de dónde sale la posición, en los dos: `status === 'ACTIVE'`, la
          // misma comparación que invierte `accionDeToggle` (3.6).
          expect(a.encendido, `${ctx}: la posición no sale de status`).toBe(status === 'ACTIVE');
        },
      ),
      { numRuns: 500 },
    );

    // La property no es vacua. Con la mezcla de `statusArbitrario`, una corrida de
    // 500 deja del orden de 215 pares dentro de la rama del interruptor, ~200 con
    // los dos efectivos distintos y ~40 mixtos (un lado con señal de antepasado
    // apagado y el otro sin ella), que es el subconjunto que caza el arreglo
    // equivocado.
    const detalle = `pares=${pares} variados=${variados} mixtos=${mixtos}`;
    expect(pares, `ningún par quedó en la rama del interruptor; ${detalle}`).toBeGreaterThan(0);
    expect(variados, `ningún par varió el efectivo; ${detalle}`).toBeGreaterThan(0);
    expect(mixtos, `ningún par cruzó señal contra sin_senal; ${detalle}`).toBeGreaterThan(0);
  });

  it('el par mixto —un lado con antepasado apagado y el otro sin él— tampoco mueve la posición', () => {
    /**
     * La misma property con el generador acotado al subconjunto que importa, por
     * la razón que el análisis de la mezcla deja a la vista: el par
     * `status = 'ACTIVE'` con exactamente un lado en `CAMPAIGN_PAUSED`/
     * `ADSET_PAUSED` sale del generador general unas 2 veces en 500 corridas, así
     * que afirmar su no-vacuidad allá sería frágil. Acá se genera por
     * construcción y es el caso de los **92 contra los 10**.
     */
    let encendidos = 0;

    fc.assert(
      fc.property(
        // El `status` tiene que dibujar interruptor por su cuenta, o el par cae en
        // la rama badge por el lado del status y el caso se descarta siempre.
        statusArbitrario.filter(efectivoDibujaInterruptor),
        fc.constantFrom(...EFECTIVOS_CON_SENAL),
        // El otro lado: cualquier efectivo que dibuje interruptor y NO tenga
        // señal. Incluye `null`, `''`, minúsculas, `PENDING_BILLING_INFO` y texto
        // libre.
        statusArbitrario.filter((s) => efectivoDibujaInterruptor(s) && !tieneSenal(s)),
        // Que el lado con señal sea el primero o el segundo no puede cambiar
        // nada: la ortogonalidad es simétrica y se genera en los dos órdenes.
        fc.boolean(),
        (status, conSenal, sinSenal, señalPrimero) => {
          const [efA, efB] = señalPrimero ? [conSenal, sinSenal] : [sinSenal, conSenal];

          const a = dibujoDeEstado(fila(status, { effectiveStatus: efA }));
          const b = dibujoDeEstado(fila(status, { effectiveStatus: efB }));
          if (a.control === 'badge' || b.control === 'badge') return;

          if (a.encendido) encendidos += 1;

          const ctx = `status=${JSON.stringify(status)} efA=${JSON.stringify(efA)} efB=${JSON.stringify(efB)}`;

          // Lo que rompería el arreglo equivocado: acá `a` y `b` difieren
          // EXACTAMENTE en tener o no la señal de antepasado apagado, así que si
          // `encendido` empezara a mirar el efectivo, esta igualdad se cae en la
          // misma corrida.
          expect(a.encendido, `${ctx}: la señal de entrega movió la posición`).toBe(b.encendido);
          expect(a.encendido, `${ctx}: la posición no sale de status`).toBe(status === 'ACTIVE');
        },
      ),
      { numRuns: 500 },
    );

    // El caso de los 92: `status = 'ACTIVE'` con un antepasado apagado tiene que
    // dibujarse ENCENDIDO. Si este contador quedara en 0, la property estaría
    // afirmando la ortogonalidad sólo sobre filas apagadas, que es la mitad
    // barata: el par que el arreglo equivocado rompe es justamente el encendido.
    expect(encendidos, 'ningún par generado quedó encendido: falta el caso de los 92').toBeGreaterThan(0);
  });
});

// ─── `senalDeEntrega` sola, sin pasar por el dibujo (task 13.1) ──────────────

/**
 * Los casos de la task 13.1 contra la función pura, además de los de arriba que
 * la miran a través de `dibujoDeEstado`.
 *
 * POR QUÉ LOS DOS NIVELES. Arriba se verifica lo que el CONTROL afirma, que es lo
 * que el usuario lee; acá lo que la función afirma, que es lo que el tipo
 * garantiza. La diferencia importa en un caso concreto: `dibujoDeEstado` no puede
 * mostrar la señal de un efectivo que está en `NO_TOGGLEABLE` —esa fila dibuja
 * badge— así que a través del dibujo hay valores de `effective_status` que no se
 * pueden preguntar. La función sí los contesta, y contesta `sin_senal`.
 *
 * **La firma es la mitad de la afirmación**: `senalDeEntrega` recibe un
 * `effectiveStatus` y nada más, así que «no mira `status`» no es algo que este
 * test tenga que verificar caso por caso —no hay `status` que pasarle—. Es la
 * ortogonalidad de 2.10 dicha en el tipo y no en un comentario, y por eso el
 * bloque de abajo es corto.
 */
describe('senalDeEntrega: qué permite afirmar cada effective_status (task 13.1)', () => {
  it('los dos efectivos con señal nombran al antepasado', () => {
    expect(senalDeEntrega('CAMPAIGN_PAUSED')).toEqual({ estado: 'antepasado_apagado', antepasado: 'campaign' });
    expect(senalDeEntrega('ADSET_PAUSED')).toEqual({ estado: 'antepasado_apagado', antepasado: 'adset' });
  });

  it('null y la cadena vacía son sin_senal: «no sé» no es «un antepasado está apagado»', () => {
    expect(senalDeEntrega(null)).toEqual({ estado: 'sin_senal' });
    expect(senalDeEntrega('')).toEqual({ estado: 'sin_senal' });
  });

  it('PENDING_BILLING_INFO es sin_senal aunque tampoco entregue (decisión B2)', () => {
    // El mismo caso que el `it` de arriba, dicho contra la función: `sin_senal`
    // es «Meta no dice que un ANTEPASADO lo tenga sin entregar», no «entrega».
    expect(senalDeEntrega('PENDING_BILLING_INFO')).toEqual({ estado: 'sin_senal' });
  });

  it('los estados propios, los desconocidos y las minúsculas son sin_senal', () => {
    // `ACTIVE` y `PAUSED` son el estado PROPIO resuelto por Meta y no dicen nada
    // del padre: un conjunto PAUSED bajo una campaña PAUSED llega con `PAUSED`.
    // Las minúsculas están porque Meta manda mayúsculas: `campaign_paused` es un
    // valor inesperado y no un sinónimo, y tratarlo como señal sería inventar.
    for (const s of ['ACTIVE', 'PAUSED', 'ARCHIVED', 'campaign_paused', 'adset_paused', 'UN_ESTADO_QUE_NO_CONOCEMOS']) {
      expect(senalDeEntrega(s), s).toEqual({ estado: 'sin_senal' });
    }
  });
});
