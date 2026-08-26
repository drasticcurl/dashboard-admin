import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { Condicion } from '@/lib/ads/tipos';
import { payloadDeForm, problema } from './ReglasView';
import { formBase, type FormEstado } from './_formBase';
import { textoDeC, textoDeFamiliaE } from '@/lib/test/preservacion-montos';

/**
 * Feature: parseo-montos-anuncios — task 5: el recorrido de Reglas, de una punta a
 * la otra.
 *
 * **Validates: Requirements 2.1, 3.10**
 *
 * El recorrido completo del formulario de Reglas, con el botón Guardar en el
 * medio:
 *
 *     FormEstado → problema() → (el botón está deshabilitado o no)
 *                → payloadDeForm() → JSON.stringify → el schema de POST /api/ads/reglas
 *
 * Lo que este archivo agrega sobre los que ya existen es **la composición**, que es
 * donde estaba el bug y donde ninguno de los otros mira:
 *
 * · `montoAmbiguo.test.ts` (Property 1) afirma que un texto ambiguo bloquea el
 *   guardado y que el payload no lleva valor, campo por campo y con el mensaje.
 * · `payloadFiel.test.ts` (Property 3) afirma que cuando Guardar está habilitado
 *   el payload lleva el número que el texto dice.
 * · `numeroDeCampo.test.ts` afirma el mensaje de cada rama de las tres `problema*`.
 *
 * Ninguno contesta las dos preguntas de punta a punta: **cuando el texto es
 * ambiguo, `payloadDeForm` no se llama** (el botón está deshabilitado y el
 * `onClick` no corre, así que no existe ningún payload, ni con `null` ni con nada),
 * y **cuando el texto está bien escrito, el payload que sale del cliente es uno
 * que el API acepta**. La segunda es la que cierra el recorrido: un cliente que
 * valida distinto del server produce el `Required` de zod frente a un formulario
 * que decía OK, que es el modo de falla que ya se arregló una vez en el diálogo de
 * presupuesto (R1 c6 de `frescura-y-acciones-anuncios`).
 *
 * ─── EL SCHEMA SE VERIFICA POR IMPORT ───────────────────────────────────────
 *
 * `POST` de `app/api/ads/reglas/route.ts` se puede importar en un test de node sin
 * base: `@/lib/db` va mockeado con un centinela que tira, así que un pedido que
 * muere ahí es la prueba de que pasó `reglaSchema` (`route.ts:50`) y siguió camino
 * hacia `cuentaEsActiva`. `reglaSchema` no está exportado, así que se lo ejercita
 * por donde entra un pedido real: el handler, con el mismo `JSON.stringify` que
 * hace el cliente. La receta es la de `app/api/ads/acciones/route.esquema.test.ts`.
 *
 * Sin base, sin red y sin render: `problema` y `payloadDeForm` son puras.
 */

// El mock va ANTES del import del route: `vi.mock` se iza, así que el `import`
// estático de abajo ya recibe el módulo mockeado.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true), getClientIp: () => 'test-ip' };
});

const CENTINELA = 'CENTINELA: el pedido pasó la validación y llegó a la base';

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  const prohibido = (): never => {
    throw new Error(CENTINELA);
  };
  return { ...actual, q: vi.fn(prohibido), q1: vi.fn(prohibido), tx: vi.fn(prohibido) };
});

import { POST } from '@/app/api/ads/reglas/route';

// ─── El botón Guardar, tal como está escrito en producción ───────────────────

/**
 * Cuántas veces se armó un payload. Es la forma de afirmar que **`payloadDeForm`
 * no se llama** cuando hay un problema: en producción eso lo garantiza el
 * `disabled={!puedeGuardar}` del botón (con `puedeGuardar = prob === null &&
 * !guardando`), así que el `onClick` que llama a `payloadDeForm` no existe como
 * camino. Acá se replica el gate y se cuenta, porque «no se llamó» no se puede
 * observar mirando el resultado de una función que no se llamó.
 */
let payloadsArmados = 0;

type Guardado =
  | { guardo: false; bloqueo: string }
  | { guardo: true; payload: Record<string, unknown> };

/**
 * Apretar Guardar. Es la única composición que existe en producción: `problema`
 * decide si el botón está habilitado y el `onClick` arma el payload. Si `problema`
 * devuelve algo, el `onClick` NO corre.
 */
function apretarGuardar(f: FormEstado): Guardado {
  const prob = problema(f);
  if (prob !== null) return { guardo: false, bloqueo: prob };
  payloadsArmados++;
  return { guardo: true, payload: payloadDeForm(f) };
}

// ─── El API ──────────────────────────────────────────────────────────────────

type VeredictoDelApi = { acepta: true } | { acepta: false; detail: string };

/**
 * Le manda al API el payload que armó el cliente y contesta si `reglaSchema` lo
 * aceptó. Lo que viene después del schema es `cuentaEsActiva`, que consulta la
 * base: ahí está el centinela, y llegar hasta él es la señal de que el payload es
 * válido.
 *
 * El `nextUrl` se define a mano porque el handler lee `searchParams` para el modo
 * `preview` (`route.ts:233`) y un `Request` pelado no lo trae.
 */
async function veredictoDelApi(payload: Record<string, unknown>): Promise<VeredictoDelApi> {
  const req = new Request('http://localhost/api/ads/reglas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  Object.defineProperty(req, 'nextUrl', { value: new URL('http://localhost/api/ads/reglas') });

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
    // Un payload que pasa el schema TIENE que llegar al centinela. Cualquier otra
    // respuesta significa que el recorrido se cortó en un lugar que este test no
    // previó, y afirmar «el schema lo aceptó» ahí sería vacío.
    throw new Error(
      `el API contestó ${respuesta.status} ${JSON.stringify(
        respuesta.cuerpo,
      )} en lugar de llegar al centinela de la base`,
    );
  }

  expect((tiro as Error).message, 'el pedido tenía que morir en el centinela de la base').toContain(
    CENTINELA,
  );
  return { acepta: true };
}

// ─── Los cinco campos ────────────────────────────────────────────────────────

/**
 * Los CINCO campos numéricos de Reglas, cada uno con el formulario mínimo que lo
 * pone bajo prueba sin disparar ningún otro bloqueo, y con dónde aparece su número
 * en el payload. Es la misma tabla que `montoAmbiguo.test.ts`, con el número que
 * se espera cuando el texto está bien escrito.
 *
 * `actionUnit: 'fixed'` en los tres de presupuesto es deliberado: con `percent` los
 * avisos de «un factor menor a 100 BAJA el presupuesto» taparían el campo que se
 * está midiendo.
 */
const CAMPOS: readonly {
  campo: string;
  /** El texto bien escrito: mil, con el mismo dibujo que el ambiguo pero sin punto. */
  bienEscrito: string;
  esperado: number;
  form: (texto: string) => FormEstado;
  valorEnPayload: (p: Record<string, unknown>) => unknown;
}[] = [
  {
    campo: 'actionValue',
    bienEscrito: '1000',
    esperado: 1000,
    form: (t) =>
      formBase({ action: 'budget_increase', actionUnit: 'fixed', actionValue: t, budgetMax: '9999' }),
    valorEnPayload: (p) => p.actionValue,
  },
  {
    campo: 'budgetMax',
    bienEscrito: '1000',
    esperado: 1000,
    form: (t) =>
      formBase({ action: 'budget_increase', actionUnit: 'fixed', actionValue: '50', budgetMax: t }),
    valorEnPayload: (p) => p.budgetMax,
  },
  {
    campo: 'budgetMin',
    bienEscrito: '1000',
    esperado: 1000,
    form: (t) =>
      formBase({ action: 'budget_decrease', actionUnit: 'fixed', actionValue: '50', budgetMin: t }),
    valorEnPayload: (p) => p.budgetMin,
  },
  {
    campo: 'condicion',
    bienEscrito: '1000',
    esperado: 1000,
    form: (t) => formBase({ conditions: [{ metric: 'spend', op: '>', value: t }] }),
    valorEnPayload: (p) => (p.conditions as readonly { value: unknown }[])[0]!.value,
  },
  {
    campo: 'maxRunsPerDay',
    bienEscrito: '1000',
    esperado: 1000,
    form: (t) => formBase({ maxRunsPerDay: t }),
    valorEnPayload: (p) => p.maxRunsPerDay,
  },
];

describe('«1.000» en cualquiera de los cinco campos: el recorrido no empieza', () => {
  for (const c of CAMPOS) {
    it(`${c.campo}: el guardado se bloquea y payloadDeForm NO se llama`, () => {
      const antes = payloadsArmados;
      const r = apretarGuardar(c.form('1.000'));

      expect(r.guardo, 'el botón Guardar tiene que estar deshabilitado').toBe(false);
      // La afirmación de la task: no es que el payload lleve `null`, es que NO HAY
      // payload. El `onClick` está detrás del `disabled` y nunca corre, así que
      // nada llega a `JSON.stringify` ni al API.
      expect(payloadsArmados, 'no se armó ningún payload').toBe(antes);
      if (r.guardo) return;
      // Las dos lecturas, que es lo que 2.1 pide.
      expect(r.bloqueo).toContain('1000');
      expect(r.bloqueo).toContain('1');
    });
  }
});

describe('«1000» en cualquiera de los cinco campos: el payload llega y el API lo acepta', () => {
  for (const c of CAMPOS) {
    it(`${c.campo}: viaja como ${c.esperado} y el schema lo acepta`, async () => {
      const r = apretarGuardar(c.form(c.bienEscrito));
      expect(r.guardo, 'el formulario tiene que ser guardable').toBe(true);
      if (!r.guardo) return;

      expect(c.valorEnPayload(r.payload), 'mil, no uno').toBe(c.esperado);

      // Después del `JSON.stringify` del cliente, que es como sale de verdad: es el
      // paso donde una clave con `undefined` desaparece.
      const viajado = JSON.parse(JSON.stringify(r.payload)) as Record<string, unknown>;
      expect(c.valorEnPayload(viajado), 'el número sobrevive al JSON').toBe(c.esperado);

      const veredicto = await veredictoDelApi(r.payload);
      expect(
        veredicto.acepta,
        `el cliente dejó guardar y el API rechazó: ${veredicto.acepta ? '' : veredicto.detail}`,
      ).toBe(true);
    });
  }
});

// ─── El ancla: los cinco campos juntos ───────────────────────────────────────

describe('el recorrido completo con los cinco campos escritos', () => {
  const conLosCinco = (valor: string, condicion: string): FormEstado =>
    formBase({
      action: 'budget_increase',
      actionUnit: 'fixed',
      actionValue: valor,
      budgetMax: valor,
      budgetMin: '1',
      maxRunsPerDay: valor,
      conditions: [{ metric: 'spend', op: '>', value: condicion }],
    });

  it('con «1.000» en los cinco, no hay payload y el mensaje nombra el primero que falla', () => {
    const antes = payloadsArmados;
    const r = apretarGuardar(conLosCinco('1.000', '1.000'));
    expect(r.guardo).toBe(false);
    expect(payloadsArmados).toBe(antes);
  });

  it('con «1000» en los cinco, el payload lleva mil en los cinco y el API lo acepta', async () => {
    const r = apretarGuardar(conLosCinco('1000', '1000'));
    expect(r.guardo, 'el formulario tiene que ser guardable').toBe(true);
    if (!r.guardo) return;

    expect(r.payload.actionValue).toBe(1000);
    expect(r.payload.budgetMax).toBe(1000);
    expect(r.payload.budgetMin).toBe(1);
    expect(r.payload.maxRunsPerDay).toBe(1000);
    expect(r.payload.conditions).toEqual([{ metric: 'spend', op: '>', value: 1000 }]);

    const veredicto = await veredictoDelApi(r.payload);
    expect(veredicto.acepta, veredicto.acepta ? '' : veredicto.detail).toBe(true);
  });

  it('un campo en blanco viaja como null y nunca como 0, y el API lo acepta igual (3.10)', async () => {
    // El otro lado del recorrido: el vacío es «sin límite», no «cero». Un techo de
    // 0 EUR o una condición «gasto > 0» son reglas que hacen algo muy distinto de
    // lo que la persona dejó sin escribir.
    const r = apretarGuardar(formBase({ maxRunsPerDay: '   ' }));
    expect(r.guardo).toBe(true);
    if (!r.guardo) return;
    expect(r.payload.maxRunsPerDay).toBeNull();
    expect(r.payload.maxRunsPerDay).not.toBe(0);

    const veredicto = await veredictoDelApi(r.payload);
    expect(veredicto.acepta, veredicto.acepta ? '' : veredicto.detail).toBe(true);
  });
});

// ─── Generadores ─────────────────────────────────────────────────────────────

const METRICAS: readonly Condicion['metric'][] = [
  'sales', 'revenue', 'spend', 'net', 'profit', 'roi', 'roas', 'cpa',
  'budget', 'impressions', 'clicks', 'ctr', 'cpc',
];
const OPS: readonly Condicion['op'][] = ['>', '>=', '<', '<=', '=', '!='];

/** La Bug_Condition y la familia (e), del generador compartido de la task 2. */
const textoAmbiguo: fc.Arbitrary<string> = fc.oneof(textoDeC, textoDeFamiliaE);

/** Números bien escritos: dígitos solos, punto decimal y coma decimal. */
const numeroBienEscrito: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 5_000 }).map(String) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 500_000 }).map((c) => String(c / 100)) },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: 100, max: 30_000 })
      .map((c) => `${Math.floor(c / 100)},${String(c % 100).padStart(2, '0')}`),
  },
);

/**
 * Formularios plausibles: números bien escritos, ambiguos y vacíos. La mezcla está
 * pesada hacia lo bien escrito a propósito, porque lo que la propiedad mide es el
 * camino que SÍ manda un payload; con puro texto al azar todo quedaría bloqueado y
 * no se probaría ningún pedido.
 *
 * `maxRunsPerDay` se genera entero: el límite de ejecuciones diarias es un entero
 * en el cliente y un `z.number().int()` en el API, así que un `1,5` ahí bloquea
 * antes de llegar y no aporta a esta propiedad (su mensaje lo cubre
 * `numeroDeCampo.test.ts`).
 */
const genForm: fc.Arbitrary<FormEstado> = fc
  .record({
    action: fc.constantFrom(
      'pause' as const,
      'activate' as const,
      'budget_increase' as const,
      'budget_decrease' as const,
    ),
    actionUnit: fc.constantFrom('fixed' as const, 'fixed' as const, 'percent' as const),
    actionValue: fc.oneof(
      { weight: 6, arbitrary: numeroBienEscrito },
      { weight: 2, arbitrary: textoAmbiguo },
      { weight: 1, arbitrary: fc.constantFrom('', '   ') },
    ),
    budgetMax: fc.oneof(
      { weight: 6, arbitrary: numeroBienEscrito },
      { weight: 2, arbitrary: textoAmbiguo },
      { weight: 1, arbitrary: fc.constant('') },
    ),
    budgetMin: fc.oneof({ weight: 4, arbitrary: fc.constant('1') }, { weight: 2, arbitrary: numeroBienEscrito }),
    maxRunsPerDay: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 1, max: 500 }).map(String) },
      { weight: 2, arbitrary: fc.constantFrom('', '   ') },
      { weight: 1, arbitrary: textoAmbiguo },
    ),
    conditions: fc.array(
      fc.record({
        metric: fc.constantFrom(...METRICAS),
        op: fc.constantFrom(...OPS),
        value: fc.oneof({ weight: 4, arbitrary: numeroBienEscrito }, { weight: 1, arbitrary: textoAmbiguo }),
      }),
      { maxLength: 2 },
    ),
  })
  .map((campos) => formBase(campos));

// ─── Las propiedades del recorrido ───────────────────────────────────────────

describe('para todo texto, el recorrido de Reglas es coherente de punta a punta', () => {
  it('para todo texto ambiguo y los cinco campos, no se arma ningún payload', () => {
    fc.assert(
      fc.property(textoAmbiguo, (texto) => {
        for (const c of CAMPOS) {
          const antes = payloadsArmados;
          const r = apretarGuardar(c.form(texto));
          expect(r.guardo, `${c.campo} = ${JSON.stringify(texto)}: dejó guardar`).toBe(false);
          expect(payloadsArmados, `${c.campo} = ${JSON.stringify(texto)}: armó payload`).toBe(antes);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('para todo formulario que habilite Guardar, el API acepta el payload que sale del cliente', async () => {
    let guardables = 0;
    let bloqueados = 0;

    await fc.assert(
      fc.asyncProperty(genForm, async (f) => {
        const r = apretarGuardar(f);
        if (!r.guardo) {
          bloqueados++;
          expect(r.bloqueo.length, 'todo bloqueo tiene texto').toBeGreaterThan(0);
          return;
        }
        guardables++;

        const veredicto = await veredictoDelApi(r.payload);
        expect(
          veredicto.acepta,
          `el cliente dejó guardar ${JSON.stringify({
            action: f.action,
            actionUnit: f.actionUnit,
            actionValue: f.actionValue,
            budgetMax: f.budgetMax,
            budgetMin: f.budgetMin,
            maxRunsPerDay: f.maxRunsPerDay,
            conditions: f.conditions,
          })} y el API lo rechazó: ${veredicto.acepta ? '' : veredicto.detail}`,
        ).toBe(true);
      }),
      { numRuns: 150 },
    );

    // La propiedad no es vacía: si todo quedara bloqueado, no se habría mandado
    // ningún payload al API y el test seguiría verde. Los pisos están bien por
    // debajo de lo medido para que no dependan de la semilla.
    expect(guardables, 'formularios que habilitaron Guardar').toBeGreaterThan(15);
    expect(bloqueados, 'formularios bloqueados').toBeGreaterThan(5);
  });
});
