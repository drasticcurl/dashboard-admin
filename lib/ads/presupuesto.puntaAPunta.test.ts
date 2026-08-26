import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { MINIMO_EUR, parsearPresupuesto } from './presupuesto';
import { presupuestoDelDialogo } from '@/app/(panel)/anuncios/GestorAnuncios';
import { techoPositivo, textoDeC, textoDeCampo, textoDeFamiliaE } from '@/lib/test/preservacion-montos';

/**
 * Feature: parseo-montos-anuncios — task 5: el recorrido del presupuesto, de una
 * punta a la otra.
 *
 * **Validates: Requirements 2.1, 3.5**
 *
 * Es el recorrido de la introducción del bugfix, medido completo:
 *
 *     texto del campo → presupuestoDelDialogo → payload → el schema
 *     `presupuestoEur` del Endpoint_Acciones → las unidades que se le mandan a Meta
 *
 * Los tests que ya existen miran cada tramo por separado: `presupuesto.test.ts` y
 * `presupuesto.mapeo.test.ts` el parseo, `presupuestoDialogo.test.ts` el payload
 * del diálogo, `route.esquema.test.ts` los mensajes del schema. Ninguno contesta
 * la pregunta con la que empieza el bugfix: **¿puede un `1.000` escrito a mano
 * seguir llegando a la campaña real de Meta como `daily_budget: '100'`?** Para eso
 * hay que recorrer los cuatro tramos en la misma corrida, que es lo único que
 * hace este archivo.
 *
 * ─── QUÉ SE VERIFICA POR IMPORT Y QUÉ POR EQUIVALENCIA ──────────────────────
 *
 * · **El schema, por import y de verdad.** El `POST` de
 *   `app/api/ads/acciones/route.ts` se puede importar en un test de node sin base:
 *   `@/lib/db` va mockeado con un centinela que tira, así que un pedido que muere
 *   ahí es la prueba de que **pasó la validación** y siguió camino. El precedente
 *   —y la receta— es `route.esquema.test.ts`, que corre los rechazos del schema sin
 *   Postgres por el mismo motivo: la validación ocurre antes del preflight.
 *
 *   `presupuestoEur` (`route.ts:110`, usado en la rama `budget_set` en `:190`) no
 *   está exportado, así que se lo ejercita por donde entra un pedido real: el
 *   handler. Es más fiel que importar el `z.number()` suelto, porque incluye el
 *   `JSON.stringify` del cliente, el `strict()` del esquema y el armado del
 *   `detail`.
 *
 * · **La conversión a unidades de Meta, por equivalencia.** `Math.round(eur * 100)`
 *   vive en dos lugares del route y los dos son privados:
 *
 *       route.ts:986   preparar()          → campos: { daily_budget: String(Math.round(presupuesto * 100)) }
 *       route.ts:889   aplicarPresupuesto() → const unidades = Math.round(budgetEur * 100)
 *
 *   Llegar hasta cualquiera de los dos pide preflight con la jerarquía sembrada y
 *   una llamada de escritura a Meta, o sea base y red: exactamente lo que este
 *   módulo no hace. Así que la expresión se reproduce acá abajo
 *   (`unidadesParaMeta`) y **la equivalencia queda anotada con el número de línea
 *   para que se pueda cotejar a ojo**. Si alguien cambia la conversión en el route,
 *   este test no se va a enterar: lo que sí queda cubierto es que ningún importe
 *   que el diálogo acepta puede hacer tirar al último hop
 *   (`setDailyBudget`, `lib/ads/meta.ts:778`, que exige entero y mayor que cero en
 *   `:779` y `:782` antes de tocar la red).
 *
 * ─── LO QUE NO ESTÁ ACÁ ─────────────────────────────────────────────────────
 *
 * El **round-trip de la celda** —`textoDeImporte(eur)` → campo → parseo → el mismo
 * importe— ya existe como propiedad en
 * `app/(panel)/anuncios/presupuestoDialogo.test.ts` («para todo importe válido,
 * sembrar el campo y volver a leerlo devuelve el mismo importe», Property 4 de
 * `frescura-y-acciones-anuncios`) y sigue pasando sin cambios: es la verificación
 * de que sacar el `type="number"` no rompió la siembra desde la celda. No se
 * duplica acá.
 */

// El mock va ANTES del import del route: `vi.mock` se iza, así que el `import`
// estático de abajo ya recibe el módulo mockeado.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true), getClientIp: () => 'test-ip' };
});

/**
 * El centinela: cualquier consulta a la base tira con un mensaje reconocible. Es
 * lo que convierte «no hubo 400» en una afirmación fuerte —el pedido pasó el
 * schema y siguió hasta el preflight— y de paso garantiza que este archivo no
 * necesita Postgres para nada.
 */
const CENTINELA = 'CENTINELA: el pedido pasó la validación y llegó a la base';

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  const prohibido = (): never => {
    throw new Error(CENTINELA);
  };
  return { ...actual, q: vi.fn(prohibido), q1: vi.fn(prohibido), tx: vi.fn(prohibido) };
});

import { POST } from '@/app/api/ads/acciones/route';

const TECHO = 5_000;
const CUENTA = 'act_1234567890';
const CONJUNTO = '23851234567890123';

/**
 * La conversión a unidades mínimas de Meta, **reproducida por equivalencia** de
 * `route.ts:986` (`preparar`, la rama `budget_set`) y `route.ts:889`
 * (`aplicarPresupuesto`, la rama de la duplicación). Las dos son privadas y las
 * dos hacen `Math.round(eur * 100)`; el `String(...)` lo pone `preparar` y, del
 * otro lado, `setDailyBudget` (`lib/ads/meta.ts:785`).
 */
const unidadesParaMeta = (eur: number): string => String(Math.round(eur * 100));

type VeredictoDelEndpoint =
  | { acepta: true }
  /** El 400 del schema, con el `detail` que el cliente muestra tal cual. */
  | { acepta: false; detail: string };

/**
 * Le manda al Endpoint_Acciones el pedido que armaría el diálogo y contesta si la
 * **validación** lo aceptó. Todo lo que pase después del schema es preflight, y el
 * preflight consulta la base: ahí está el centinela, y llegar hasta él es la señal
 * de que el payload es válido.
 *
 * El cuerpo viaja por `JSON.stringify`, igual que en el cliente: es el paso donde
 * una clave con `undefined` desaparece, que es cómo se descubrió que el diálogo
 * mandaba pedidos sin importe (R1 c1 de `frescura-y-acciones-anuncios`).
 */
async function veredictoDelEndpoint(cuerpo: Record<string, unknown>): Promise<VeredictoDelEndpoint> {
  const req = new Request('http://localhost/api/ads/acciones', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

  let respuesta: { status: number; cuerpo: { error?: string; detail?: string } } | null = null;
  let tiro: unknown = null;
  try {
    const res = await POST(req as never);
    respuesta = { status: res.status, cuerpo: (await res.json()) as { error?: string; detail?: string } };
  } catch (err) {
    tiro = err;
  }

  if (respuesta !== null) {
    if (respuesta.status === 400 && respuesta.cuerpo.error === 'invalid_payload') {
      return { acepta: false, detail: respuesta.cuerpo.detail ?? '' };
    }
    // Un pedido que pasa el schema TIENE que llegar al centinela: el preflight
    // consulta la base antes de cualquier otra cosa. Cualquier otra respuesta
    // (un 401, un corte del preflight que no vimos venir) significa que el
    // recorrido se cortó en un lugar que este test no previó, y afirmar «el schema
    // lo aceptó» ahí sería una afirmación vacía. Por eso es un fallo y no un
    // «acepta: true».
    throw new Error(
      `el endpoint contestó ${respuesta.status} ${JSON.stringify(
        respuesta.cuerpo,
      )} en lugar de llegar al centinela de la base`,
    );
  }

  // Si murió en otro lado, el mensaje lo dice y el test falla mostrando cuál.
  expect((tiro as Error).message, 'el pedido tenía que morir en el centinela de la base').toContain(
    CENTINELA,
  );
  return { acepta: true };
}

/** El pedido completo de `budget_set`, con el fragmento que arma el diálogo. */
const pedido = (cuerpo: { budgetEur: number }): Record<string, unknown> => ({
  level: 'adset',
  accountId: CUENTA,
  action: 'budget_set',
  objectIds: [CONJUNTO],
  ...cuerpo,
});

/**
 * El recorrido entero en una función: qué le llega a Meta cuando alguien escribe
 * `texto` en el campo y aprieta Ejecutar. `null` significa que **no hay pedido**:
 * el diálogo bloqueó el botón y no se arma ningún payload.
 */
async function loQueLeLlegaAMeta(
  texto: string,
  techoEur: number,
): Promise<{ dailyBudget: string; bloqueo: null } | { dailyBudget: null; bloqueo: string }> {
  const r = presupuestoDelDialogo(texto, techoEur);
  if (!r.ok) return { dailyBudget: null, bloqueo: r.bloqueo };

  const veredicto = await veredictoDelEndpoint(pedido(r.cuerpo));
  expect(
    veredicto.acepta,
    `el diálogo aceptó ${JSON.stringify(texto)} y el endpoint lo rechazó: ${
      veredicto.acepta ? '' : veredicto.detail
    }`,
  ).toBe(true);
  return { dailyBudget: unidadesParaMeta(r.cuerpo.budgetEur), bloqueo: null };
}

// ─── El caso de la introducción del bugfix ───────────────────────────────────

describe('el euro que llegaba a Meta como daily_budget «100»', () => {
  it('«1.000» no produce ningún pedido: el recorrido se corta en el campo', async () => {
    const r = await loQueLeLlegaAMeta('1.000', TECHO);

    // Lo que pasaba antes de este arreglo, para que el test diga qué está
    // impidiendo: `parsearPresupuesto('1.000', 5000)` devolvía
    // `{"ok":true,"valor":1}`, el payload viajaba con `budgetEur: 1`, el schema lo
    // aceptaba (1 es positivo, finito y de dos decimales) y `preparar` mandaba
    // `daily_budget: '100'` a la campaña real. Un euro donde la persona quiso mil.
    expect(unidadesParaMeta(1), 'el importe corrompido valía esto en unidades').toBe('100');

    expect(r.dailyBudget, 'no puede llegar NINGÚN importe a Meta').toBeNull();
    expect(r.bloqueo, 'y el campo tiene que decir por qué').not.toBeNull();
    // Las dos lecturas, que es lo que 2.1 pide: el valor del rechazo está en que
    // la persona elija, no en que se entere de que algo salió mal.
    expect(r.bloqueo).toContain('1000');
    expect(r.bloqueo).toContain('1');
  });

  it('«1000» llega a Meta como daily_budget «100000», que es Math.round(1000 * 100)', async () => {
    const r = await loQueLeLlegaAMeta('1000', TECHO);
    expect(r.bloqueo).toBeNull();
    expect(r.dailyBudget).toBe('100000');
    // El número del bugfix, escrito de las dos formas para que la equivalencia con
    // `route.ts:986` se lea sin ir a buscarla.
    expect(r.dailyBudget).toBe(String(Math.round(1000 * 100)));
  });

  it('el endpoint NO es una segunda línea de defensa, y por eso el parseo del cliente es la única', async () => {
    // Consecuencia declarada del diseño y anotada como pendiente en el plan: el
    // schema recibe un `number` YA parseado, así que el 1 corrompido le parece un
    // importe legítimo. La cláusula 3.5 pide justamente que el endpoint siga
    // aceptando los mismos importes que el formulario, así que mover la validación
    // al server quedó fuera de alcance: quien postee directo con curl puede
    // seguir escribiendo 1.
    const veredicto = await veredictoDelEndpoint(pedido({ budgetEur: 1 }));
    expect(veredicto.acepta, 'el schema acepta el 1 corrompido: no lo detiene nadie del lado server').toBe(
      true,
    );
  });

  it('los importes que el schema SÍ rechaza siguen siendo los de siempre', async () => {
    // La otra mitad de 3.5: que el endpoint no se haya ablandado. Son los mensajes
    // de `presupuestoEur` (`route.ts:110`) tal como los fija `route.esquema.test.ts`;
    // acá se los mira desde este recorrido para que un cambio en el schema aparezca
    // en el test que habla de punta a punta y no sólo en el que habla del schema.
    const cero = await veredictoDelEndpoint(pedido({ budgetEur: 0 }));
    expect(cero.acepta).toBe(false);
    if (!cero.acepta) expect(cero.detail).toContain('mayor que cero');

    const tresDecimales = await veredictoDelEndpoint(pedido({ budgetEur: 10.999 }));
    expect(tresDecimales.acepta).toBe(false);
    if (!tresDecimales.acepta) expect(tresDecimales.detail).toContain('dos decimales');
  });
});

// ─── La tabla del recorrido ──────────────────────────────────────────────────

describe('el recorrido completo, texto por texto', () => {
  const CASOS: readonly { texto: string; dailyBudget: string | null; nota: string }[] = [
    { texto: '1.000', dailyBudget: null, nota: 'la Bug_Condition: ambiguo, no hay pedido' },
    { texto: '1000', dailyBudget: '100000', nota: 'mil euros, sin separadores' },
    { texto: '1000.000', dailyBudget: null, nota: 'familia (e): la regla ancha también es ambigua' },
    { texto: '100,50', dailyBudget: '10050', nota: 'la coma decimal, que ahora se acepta (2.2)' },
    { texto: '1.234,56', dailyBudget: '123456', nota: 'agrupación de miles Y coma decimal (2.3)' },
    { texto: '€5', dailyBudget: '500', nota: 'el ruido se limpia (2.5)' },
    { texto: '1e3', dailyBudget: null, nota: 'notación exponencial: se rechaza a propósito (2.5)' },
    { texto: '0,01', dailyBudget: '1', nota: 'el mínimo de Meta, que es una unidad' },
    { texto: '', dailyBudget: null, nota: 'el campo en blanco: bloqueo sin borde rojo (3.2)' },
    { texto: '9999', dailyBudget: null, nota: 'sobre el techo de la cuenta (3.3)' },
  ];

  for (const c of CASOS) {
    it(`${JSON.stringify(c.texto)} → ${c.dailyBudget ?? 'no hay pedido'} · ${c.nota}`, async () => {
      const r = await loQueLeLlegaAMeta(c.texto, TECHO);
      expect(r.dailyBudget).toBe(c.dailyBudget);
      if (c.dailyBudget === null) {
        expect(r.bloqueo, 'un recorrido cortado tiene que tener motivo').not.toBe('');
      }
    });
  }

  it('el mínimo de la cuenta viaja como una unidad y no como cero', async () => {
    const r = await loQueLeLlegaAMeta(MINIMO_EUR.toFixed(2), TECHO);
    expect(r.dailyBudget).toBe('1');
  });
});

// ─── Las propiedades del recorrido ───────────────────────────────────────────

describe('para todo texto, el recorrido es coherente de punta a punta', () => {
  it('lo que el diálogo acepta, el endpoint acepta, y lo que le llega a Meta es un entero positivo', async () => {
    // `fc.assert` con la propiedad asíncrona: cada iteración que pasa el diálogo
    // hace un POST real contra el handler, que muere en el centinela.
    let aceptados = 0;
    let bloqueados = 0;

    await fc.assert(
      fc.asyncProperty(textoDeCampo, techoPositivo, async (texto, techoEur) => {
        const parseado = parsearPresupuesto(texto, techoEur);
        const r = await loQueLeLlegaAMeta(texto, techoEur);

        if (!parseado.ok) {
          bloqueados++;
          // Sin importe no hay pedido: es la mitad de 2.1 que importa para Meta.
          expect(r.dailyBudget, `${JSON.stringify(texto)} produjo un pedido`).toBeNull();
          expect(r.bloqueo!.length, 'todo rechazo tiene texto (3.6)').toBeGreaterThan(0);
          return;
        }

        aceptados++;
        // `loQueLeLlegaAMeta` ya afirmó adentro que el endpoint no lo rechazó:
        // eso es la cláusula 3.5, «el endpoint acepta exactamente los mismos
        // importes que el formulario».
        expect(r.dailyBudget).toBe(unidadesParaMeta(parseado.valor));

        // Las dos precondiciones del último hop, `setDailyBudget`
        // (`lib/ads/meta.ts:779` y `:782`): entero y mayor que cero. Un importe
        // aceptado que no las cumpliera tiraría un `MetaAdsError` que en el log
        // parece un problema de permisos.
        const unidades = Number(r.dailyBudget);
        expect(Number.isInteger(unidades), `${JSON.stringify(texto)} → ${r.dailyBudget}`).toBe(true);
        expect(unidades).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );

    // La propiedad no es vacía: si el generador o la validación dejaran todo
    // bloqueado, las aserciones del camino aceptado no correrían nunca y el test
    // seguiría verde. Los pisos están bien por debajo de lo medido (≈70 y ≈130
    // de 200) para que no dependan de la semilla.
    expect(aceptados, 'textos que llegaron a Meta').toBeGreaterThan(15);
    expect(bloqueados, 'textos que se cortaron en el campo').toBeGreaterThan(15);
  });

  it('para todo texto ambiguo y todo techo, no existe ningún pedido', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(textoDeC, textoDeFamiliaE), techoPositivo, async (texto, techoEur) => {
        const r = await loQueLeLlegaAMeta(texto, techoEur);
        expect(r.dailyBudget, `${JSON.stringify(texto)} llegó a Meta`).toBeNull();
        // El mensaje trae las dos escrituras posibles. `presupuestoDialogo.test.ts`
        // y `montoAmbiguo.test.ts` ya lo miran campo por campo; acá se conserva la
        // aserción porque un bloqueo sin las dos lecturas deja a la persona con el
        // recorrido cortado y sin saber qué escribir.
        expect(r.bloqueo).toContain(texto.split('.').join(''));
        expect(r.bloqueo).toContain(texto.slice(0, texto.indexOf('.')));
      }),
      { numRuns: 150 },
    );
  });
});
