import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { q } from '../db';
import { getFunnelBySlug, type Funnel } from '../funnels';
import {
  SIN_EXPERIMENTO,
  buildEmbudoPorEtapas,
  getFunnelData,
  type FunnelFilters,
  type FunnelStageRow,
  type FunnelStepRow,
  type PasoConConteo,
} from './funnel';

// vitest no carga .env solo (mismo patrón que lib/queries/overview.test.ts):
// cargarlo acá hace que la suite corra contra la base real en vez de
// saltarse en silencio.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

/**
 * Integración con Postgres real: la matemática del embudo (suma acumulada
 * inversa, porcentajes, filtros) no se puede testear sin datos de verdad.
 * Sin DATABASE_URL se salta, igual que los otros tests de integración.
 *
 * Aislamiento por día, no por sid: los días de prueba viven lejos de los
 * datos reales (que caen en días recientes), así que el cleanup es un
 * DELETE por día y un run anterior muerto a mitad de camino no deja filas
 * fantasma que ensucien las aserciones.
 *
 * El día se elige AL AZAR dentro de un rango histórico vacío: con días
 * fijos, dos suites corriendo en paralelo contra la misma base (agentes de
 * olas distintas verificando a la vez) se pisan los conteos. Con 119 días
 * posibles el choque es improbable, y un run que muere a mitad de camino
 * sólo deja basura en un día que nadie vuelve a tocar.
 */
const dbAvailable = Boolean(process.env.DATABASE_URL);

// Guarda de schema-probe (spec ab-test-popup-descuento): la query del
// desglose y el FUNNEL_SELECT ahora referencian `sessions.experiment` y
// `funnels.experiments`, que solo existen con la migración 020 aplicada (paso
// 0 manual del usuario). Sin las columnas, el describe de integración se salta
// con un mensaje claro en vez de fallar con "column does not exist". Es la
// misma filosofía que skipIf(!dbAvailable), pero el resultado se conoce recién
// después de consultar la base. El describe PURO (buildEmbudoPorEtapas) no
// necesita base y sigue corriendo siempre.
//
// El probe es SOLO LECTURA de information_schema y corre en un subproceso
// síncrono a propósito: top-level await acá rompería `next build`, cuyo
// typecheck usa el target por defecto (ES5, sin top-level await).
const schemaReady = dbAvailable && probeEsquema('[funnel.test.ts]');
if (dbAvailable && !schemaReady) {
  console.warn(
    '[funnel.test.ts] schema-probe: falta sessions.experiment o funnels.experiments ' +
      '(migración 020 sin aplicar en esta base): se salta el describe de integración',
  );
}

/**
 * ¿Las columnas de la migración 020 existen en la base de DATABASE_URL?
 * Fallo de conexión ⇒ false ⇒ el describe de integración se salta. Duplicada
 * a propósito en los archivos de test que la necesitan (self-contained).
 */
function probeEsquema(tag: string): boolean {
  try {
    const out = execFileSync(
      'node',
      [
        '-e',
        `const {Client}=require('pg');
const c=new Client({connectionString:process.argv[1]});
c.connect()
  .then(()=>c.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE (table_name='sessions' AND column_name='experiment') OR (table_name='funnels' AND column_name='experiments')"))
  .then((r)=>c.end().then(()=>process.stdout.write(r.rows[0].n===2?'1':'0')))
  .catch(()=>{try{c.end()}catch(_){};process.stdout.write('0');});`,
        process.env.DATABASE_URL!,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    );
    return out.toString().trim() === '1';
  } catch (err) {
    console.warn(`${tag} schema-probe falló, se salta la suite:`, err instanceof Error ? err.message : err);
    return false;
  }
}

const RUN_OFFSET = 1 + Math.floor(Math.random() * 119); // día 2..120 de 2026
function testDay(offset: number): string {
  return new Date(Date.UTC(2026, 0, offset)).toISOString().slice(0, 10);
}
const DAY = testDay(RUN_OFFSET);
const DAY_EMPTY = testDay(RUN_OFFSET + 1);

// ─── buildEmbudoPorEtapas: función pura, sin base ───────────────────────────
//
// Acá viven los casos de T04 §6, incluido EL caso 820 → 821 (D-R09): es el
// test que impide que alguien "arregle" la no monotonía recortando el número.

function etapaPaso(stageOrder: number, label: string, startsAtSlug: string): FunnelStageRow {
  return { stageOrder, label, startsAtSlug, milestone: null };
}

function etapaHito(stageOrder: number, label: string, milestone: FunnelStageRow['milestone']): FunnelStageRow {
  return { stageOrder, label, startsAtSlug: null, milestone };
}

/** El seed de la 017 (D-R08): 5 fronteras de paso y los 3 hitos, en orden. */
const SEED_CONFIG: FunnelStageRow[] = [
  etapaPaso(0, 'Landing', 'landing_hook'),
  etapaPaso(1, 'Preguntas', 'edad'),
  etapaPaso(2, 'Puente al experto', 'expert_bridge'),
  etapaPaso(3, 'Diagnóstico', 'diagnosis_result'),
  etapaPaso(4, 'Página de venta', 'sales_page'),
  etapaHito(5, 'Vio la venta', 'sales_view'),
  etapaHito(6, 'Clickeó comprar', 'checkout_click'),
  etapaHito(7, 'Compró', 'purchase'),
];

const HITOS_8_NUMEROS = { salesViews: 821, checkoutClicks: 199, purchases: 56 };

/** Los pasos con los 5 conteos del §2 de T04 (medidos en producción). */
const PASOS_8_NUMEROS: PasoConConteo[] = [
  { stepIndex: 0, slug: 'landing_hook', sessions: 4011 },
  { stepIndex: 1, slug: 'edad', sessions: 1086 },
  { stepIndex: 2, slug: 'expert_bridge', sessions: 1027 },
  { stepIndex: 3, slug: 'diagnosis_result', sessions: 880 },
  { stepIndex: 4, slug: 'sales_page', sessions: 820 },
];

describe('buildEmbudoPorEtapas (pura)', () => {
  it('EL CASO 820 → 821 (D-R09): el número real viaja, el ancho se recorta y sólo esa etapa queda marcada', () => {
    const { etapas, huerfanas } = buildEmbudoPorEtapas(SEED_CONFIG, PASOS_8_NUMEROS, HITOS_8_NUMEROS, 0);
    expect(huerfanas).toEqual([]);
    expect(etapas).toHaveLength(8);

    const sessions = etapas.map((e) => e.sessions);
    expect(sessions).toEqual([4011, 1086, 1027, 880, 820, 821, 199, 56]);

    const vie = etapas.find((e) => e.label === 'Vio la venta')!;
    const pagina = etapas.find((e) => e.label === 'Página de venta')!;
    // El número es el real: 821, no el 820 del paso anterior (T04 §8: si acá
    // se ve 820, se recortó el NÚMERO y eso es lo que D-R09 prohíbe).
    expect(vie.sessions).toBe(821);
    expect(vie.pctOfBase).toBeGreaterThan(pagina.pctOfBase);
    // El ANCHO es el recortado: igual al de la etapa anterior, no mayor.
    expect(vie.anchoDibujo).toBeCloseTo(pagina.anchoDibujo, 10);
    expect(vie.anchoDibujo).toBeLessThan(vie.pctOfBase);
    // Sólo esa etapa es inconsistente.
    expect(vie.inconsistente).toBe(true);
    expect(etapas.filter((e) => e.inconsistente)).toHaveLength(1);
    // La primera es el 100% y el resto del embudo cae monótonamente en dibujo.
    expect(etapas[0]!.pctOfBase).toBe(100);
    expect(etapas[0]!.anchoDibujo).toBe(100);
    for (let i = 1; i < etapas.length; i++) {
      expect(etapas[i]!.anchoDibujo).toBeLessThanOrEqual(etapas[i - 1]!.anchoDibujo);
    }
    // Unidades 0-100 (§3): un pct de ~0,2047 acá es la señal de tanto por uno.
    expect(vie.pctOfBase).toBeCloseTo((821 / 4011) * 100, 6);
  });

  it('el recorte es ACUMULATIVO: 100 → 50 → 60 da anchos 100 → 50 → 50', () => {
    const config: FunnelStageRow[] = [
      etapaPaso(0, 'A', 'a'),
      etapaPaso(1, 'B', 'b'),
      etapaHito(2, 'C', 'purchase'),
    ];
    const pasos: PasoConConteo[] = [
      { stepIndex: 0, slug: 'a', sessions: 100 },
      { stepIndex: 1, slug: 'b', sessions: 50 },
    ];
    const { etapas } = buildEmbudoPorEtapas(config, pasos, { salesViews: 0, checkoutClicks: 0, purchases: 60 }, 0);
    expect(etapas.map((e) => e.sessions)).toEqual([100, 50, 60]);
    expect(etapas.map((e) => e.anchoDibujo)).toEqual([100, 50, 50]);
    expect(etapas[2]!.inconsistente).toBe(true);
    expect(etapas[1]!.inconsistente).toBe(false);
  });

  it('el conteo de una etapa es el de su PRIMER paso ("entraron"), no el último ni la suma', () => {
    const config: FunnelStageRow[] = [etapaPaso(0, 'Etapa de 3 pasos', 'a'), etapaPaso(1, 'Siguiente', 'd')];
    const pasos: PasoConConteo[] = [
      { stepIndex: 0, slug: 'a', sessions: 100 },
      { stepIndex: 1, slug: 'b', sessions: 90 },
      { stepIndex: 2, slug: 'c', sessions: 80 },
      { stepIndex: 3, slug: 'd', sessions: 70 },
    ];
    const { etapas } = buildEmbudoPorEtapas(config, pasos, { salesViews: 0, checkoutClicks: 0, purchases: 0 }, 0);
    expect(etapas).toHaveLength(2);
    // 100 = el primer paso. Con el último daría 80 y con la suma 270.
    expect(etapas[0]!.sessions).toBe(100);
    expect(etapas[0]!.slugs).toEqual(['a', 'b', 'c']);
    expect(etapas[1]!.sessions).toBe(70);
  });

  it('EL REBOTE DE LA LANDING QUEDA VISIBLE: es la razón de contar el primer paso', () => {
    // Los números son los reales de chauhinchazon: 4023 sesiones, de las cuales
    // 1661 nunca salieron de la landing, así que 2362 entraron a las preguntas.
    // Contando el ÚLTIMO paso, "Preguntas" valía 1087 (el paso 17) y esa barra
    // mezclaba el rebote de la landing con el abandono del quiz: no se podía
    // saber cuál de los dos era el problema.
    const config: FunnelStageRow[] = [
      etapaPaso(0, 'Landing', 'landing_hook'),
      etapaPaso(1, 'Preguntas', 'edad'),
      etapaPaso(2, 'Puente', 'expert_bridge'),
    ];
    const pasos: PasoConConteo[] = [
      { stepIndex: 0, slug: 'landing_hook', sessions: 4023 },
      { stepIndex: 1, slug: 'edad', sessions: 2362 },
      { stepIndex: 17, slug: 'ultima_pregunta', sessions: 1087 },
      { stepIndex: 18, slug: 'expert_bridge', sessions: 1028 },
    ];
    const { etapas } = buildEmbudoPorEtapas(config, pasos, { salesViews: 0, checkoutClicks: 0, purchases: 0 }, 0);
    expect(etapas.map((e) => e.sessions)).toEqual([4023, 2362, 1028]);
    // El rebote de la landing: 4023 → 2362 es una caída del 41%, y ahora se ve.
    expect(Math.round(etapas[1]!.dropFromPrevious)).toBe(41);
    // Y el abandono del quiz queda en su propia frontera, 2362 → 1028.
    expect(Math.round(etapas[2]!.dropFromPrevious)).toBe(56);
  });

  it("con base='start' una etapa que arranca en el paso 0 no cuenta el paso 0", () => {
    // Si contara el paso 0, su conteo sería el total de sesiones y el 100%
    // dejaría de ser la base elegida.
    const config: FunnelStageRow[] = [etapaPaso(0, 'Landing + preguntas', 'a'), etapaPaso(1, 'Puente', 'c')];
    const pasos: PasoConConteo[] = [
      { stepIndex: 0, slug: 'a', sessions: 1000 },
      { stepIndex: 1, slug: 'b', sessions: 600 },
      { stepIndex: 2, slug: 'c', sessions: 300 },
    ];
    const { etapas } = buildEmbudoPorEtapas(config, pasos, { salesViews: 0, checkoutClicks: 0, purchases: 0 }, 1);
    expect(etapas[0]!.sessions).toBe(600);
    expect(etapas[0]!.pctOfBase).toBe(100);
  });

  it('una etapa huérfana va a huerfanas y las demás se calculan igual', () => {
    const config: FunnelStageRow[] = [
      etapaPaso(0, 'Landing', 'landing_hook'),
      etapaPaso(1, 'Preguntas', 'no_existe'),
      etapaPaso(2, 'Puente al experto', 'expert_bridge'),
    ];
    const pasos: PasoConConteo[] = [
      { stepIndex: 0, slug: 'landing_hook', sessions: 100 },
      { stepIndex: 1, slug: 'expert_bridge', sessions: 50 },
    ];
    const { etapas, huerfanas } = buildEmbudoPorEtapas(config, pasos, { salesViews: 0, checkoutClicks: 0, purchases: 0 }, 0);
    expect(huerfanas).toEqual([{ stageOrder: 1, label: 'Preguntas', slugFaltante: 'no_existe' }]);
    expect(etapas.map((e) => e.label)).toEqual(['Landing', 'Puente al experto']);
    expect(etapas[0]!.sessions).toBe(100);
    expect(etapas[1]!.sessions).toBe(50);
  });

  it('sin etapas configuradas devuelve etapas: [] y no tira', () => {
    const { etapas, huerfanas } = buildEmbudoPorEtapas(
      [],
      PASOS_8_NUMEROS,
      HITOS_8_NUMEROS,
      0,
    );
    expect(etapas).toEqual([]);
    expect(huerfanas).toEqual([]);
  });

  it('los hitos leen el campo correcto, con tres valores distintos para que un mapeo cruzado se vea', () => {
    const config: FunnelStageRow[] = [
      etapaHito(0, 'Vio la venta', 'sales_view'),
      etapaHito(1, 'Clickeó comprar', 'checkout_click'),
      etapaHito(2, 'Compró', 'purchase'),
    ];
    const { etapas } = buildEmbudoPorEtapas(
      config,
      PASOS_8_NUMEROS,
      { salesViews: 111, checkoutClicks: 222, purchases: 333 },
      0,
    );
    expect(etapas.map((e) => e.sessions)).toEqual([111, 222, 333]);
    expect(etapas.every((e) => e.fuente === 'hito' && e.slugs.length === 0)).toBe(true);
  });

  it('la primera etapa devuelve pctOfPrevious 100 y dropFromPrevious 0, no NaN ni Infinity', () => {
    const { etapas } = buildEmbudoPorEtapas(SEED_CONFIG, PASOS_8_NUMEROS, HITOS_8_NUMEROS, 0);
    expect(etapas[0]!.pctOfPrevious).toBe(100);
    expect(etapas[0]!.dropFromPrevious).toBe(0);
    expect(etapas[1]!.pctOfPrevious).toBeCloseTo((1086 / 4011) * 100, 6);
    expect(etapas[1]!.dropFromPrevious).toBeCloseTo(100 - (1086 / 4011) * 100, 6);
  });

  it('base en 0: un funnel sin sesiones no produce NaN ni Infinity en ningún campo', () => {
    const pasosCero: PasoConConteo[] = PASOS_8_NUMEROS.map((p) => ({ ...p, sessions: 0 }));
    const { etapas, huerfanas } = buildEmbudoPorEtapas(
      SEED_CONFIG,
      pasosCero,
      { salesViews: 0, checkoutClicks: 0, purchases: 0 },
      0,
    );
    expect(huerfanas).toEqual([]);
    expect(etapas).toHaveLength(8);
    const json = JSON.stringify({ etapas, huerfanas });
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
    for (const e of etapas) {
      expect(Number.isFinite(e.sessions)).toBe(true);
      expect(Number.isFinite(e.pctOfBase)).toBe(true);
      expect(Number.isFinite(e.pctOfPrevious)).toBe(true);
      expect(Number.isFinite(e.dropFromPrevious)).toBe(true);
      expect(Number.isFinite(e.anchoDibujo)).toBe(true);
      expect(e.sessions).toBe(0);
    }
  });

  it('las unidades son 0-100 (§3): pctOfBase, pctOfPrevious, dropFromPrevious y anchoDibujo ya multiplicados', () => {
    const { etapas } = buildEmbudoPorEtapas(SEED_CONFIG, PASOS_8_NUMEROS, HITOS_8_NUMEROS, 0);
    for (const e of etapas) {
      expect(e.pctOfBase).toBeGreaterThanOrEqual(0);
      expect(e.pctOfBase).toBeLessThanOrEqual(100);
      expect(e.anchoDibujo).toBeGreaterThanOrEqual(0);
      expect(e.anchoDibujo).toBeLessThanOrEqual(100);
      if (e.inconsistente) {
        // Es la única etapa donde pctOfPrevious se pasa de 100: 821/820.
        expect(e.pctOfPrevious).toBeGreaterThan(100);
      } else {
        expect(e.pctOfPrevious).toBeGreaterThanOrEqual(0);
        expect(e.pctOfPrevious).toBeLessThanOrEqual(100);
      }
    }
    // Un conteo de 1.088 sobre 4.011 es ~27,1 %, nunca 0,271.
    expect(etapas[1]!.pctOfBase).toBeGreaterThan(1);
  });

  it("base='start' (baseIndex 1) saca la etapa que termina antes del paso 1 y el 100% pasa a la siguiente", () => {
    const { etapas } = buildEmbudoPorEtapas(SEED_CONFIG, PASOS_8_NUMEROS, HITOS_8_NUMEROS, 1);
    expect(etapas).toHaveLength(7);
    expect(etapas[0]!.label).toBe('Preguntas');
    expect(etapas[0]!.pctOfBase).toBe(100);
    expect(etapas[0]!.pctOfPrevious).toBe(100);
    expect(etapas[0]!.inconsistente).toBe(false);
  });
});

describe.skipIf(!(dbAvailable && schemaReady))('getFunnelData (integración)', () => {
  let chau: Funnel;
  let reset: Funnel;

  beforeAll(async () => {
    chau = (await getFunnelBySlug('chauhinchazon'))!;
    reset = (await getFunnelBySlug('reset'))!;
    if (!chau || !reset) {
      throw new Error('faltan los funnels del seed: corré npm run db:migrate');
    }
  });

  afterEach(async () => {
    await limpiarDiasDePrueba();
  });

  /**
   * Una sesión con el max_step_index dado y opciones de contexto/hitos.
   * `hitos` marca cuántos hitos de venta tiene (1 = sales_view, 2 = +
   * checkout, 3 = + purchase): los tests del peor paso dependen de eso.
   * `experiment` es la dimensión del A/B (null/undefined = NULL).
   *
   * `upsell` / `downsell` son los hitos de la cola del funnel, independientes de
   * `hitos` a propósito: la SQL del desglose los cuenta por columna no nula, así
   * que el test tiene que poder sembrar combinaciones que la vida real no daría
   * (un upsell sin compra) y comprobar que la query no los inventa ni los pierde.
   *
   * `revenue` siembra una orden aprobada atada a la sesión. Es la única forma de
   * verificar la subconsulta de plata: `sessions` no tiene monto.
   */
  async function seedSession(
    funnelId: number,
    maxStepIndex: number,
    opts: {
      campaign?: string;
      country?: string;
      variant?: string;
      hitos?: number;
      day?: string;
      experiment?: string | null;
      upsellView?: boolean;
      upsellClick?: boolean;
      downsellView?: boolean;
      revenue?: number;
      /** Órdenes NO aprobadas (reembolsos): tienen que quedar afuera del total. */
      revenueRechazado?: number;
    } = {},
  ): Promise<void> {
    const day = opts.day ?? DAY;
    const hitos = opts.hitos ?? 0;
    const sessionId = randomUUID();
    await q(
      `INSERT INTO sessions (id, funnel_id, visitor_id, variant, day, started_at, last_seen_at,
         max_step_index, sales_view_at, checkout_click_at, purchased_at, utm_campaign, country, experiment,
         upsell_view_at, upsell_click_at, downsell_view_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5::date, $6::timestamptz, $6::timestamptz, $7,
               $8::timestamptz, $9::timestamptz, $10::timestamptz, $11, $12, $13,
               $14::timestamptz, $15::timestamptz, $16::timestamptz)`,
      [
        sessionId,
        funnelId,
        randomUUID(),
        opts.variant ?? 'default',
        day,
        `${day}T12:00:00Z`,
        maxStepIndex,
        hitos >= 1 ? `${day}T12:00:00Z` : null,
        hitos >= 2 ? `${day}T12:00:00Z` : null,
        hitos >= 3 ? `${day}T12:00:00Z` : null,
        opts.campaign ?? '(directo)',
        opts.country ?? null,
        opts.experiment ?? null,
        opts.upsellView ? `${day}T12:05:00Z` : null,
        opts.upsellClick ? `${day}T12:06:00Z` : null,
        opts.downsellView ? `${day}T12:07:00Z` : null,
      ],
    );

    // Las órdenes se siembran DESPUÉS y apuntando a la sesión: así el test
    // ejercita el mismo camino que la subconsulta de la query (session_id +
    // status), sin depender de orders.funnel_id, que en producción puede ser NULL.
    const ordenes: Array<[monto: number, status: string]> = [];
    if (opts.revenue) ordenes.push([opts.revenue, 'approved']);
    if (opts.revenueRechazado) ordenes.push([opts.revenueRechazado, 'refunded']);
    for (const [monto, status] of ordenes) {
      await q(
        `INSERT INTO orders (funnel_id, source, external_id, status, amount, currency,
                             session_id, purchased_at, day)
         VALUES ($1, 'test', $2, $3, $4, 'ARS', $5::uuid, $6::timestamptz, $7::date)`,
        [funnelId, `abtest-${randomUUID()}`, status, monto, sessionId, `${day}T12:30:00Z`, day],
      );
    }
  }

  async function seedHistogram(
    funnelId: number,
    hist: Array<[step: number, n: number]>,
    opts: Parameters<typeof seedSession>[2] = {},
  ): Promise<void> {
    for (const [step, n] of hist) {
      for (let i = 0; i < n; i++) await seedSession(funnelId, step, opts);
    }
  }

  /**
   * Vacía los días de prueba. Es el MISMO mecanismo que el `afterEach` de la
   * suite (aislamiento por día), pero llamable desde adentro de una property:
   * `afterEach` corre una vez por `it`, y una property hace 100 iteraciones
   * DENTRO de un `it`. Sin esto la iteración N ve las sesiones que sembraron las
   * N-1 anteriores —y el residuo que un run muerto a mitad de camino dejó en el
   * día—, así que la query cuenta filas ajenas y la property no prueba lo que
   * dice probar.
   */
  async function limpiarDiasDePrueba(): Promise<void> {
    // Las órdenes van PRIMERO y filtradas por `source = 'test'`: son las que
    // siembra este archivo y nada más. Un DELETE por día borraría ventas reales
    // si el día al azar cayera sobre uno con facturación, que es exactamente el
    // tipo de accidente que no se nota hasta el cierre del mes.
    await q("DELETE FROM orders WHERE source = 'test' AND day IN ($1::date, $2::date)", [DAY, DAY_EMPTY]);
    await q('DELETE FROM sessions WHERE day IN ($1::date, $2::date)', [DAY, DAY_EMPTY]);
  }

  function row(steps: FunnelStepRow[], stepIndex: number): FunnelStepRow {
    const r = steps.find((s) => s.stepIndex === stepIndex);
    if (!r) throw new Error(`no hay fila para stepIndex ${stepIndex}`);
    return r;
  }

  function baseFilters(over: Partial<FunnelFilters> = {}): FunnelFilters {
    return { funnelId: chau.id, from: DAY, to: DAY, base: 'landing', ...over };
  }

  it('la suma acumulada inversa es exacta en el paso 0, en uno del medio y en el último', async () => {
    await seedHistogram(chau.id, [
      [0, 40],
      [1, 30],
      [5, 20],
      [21, 10],
    ]);
    const data = await getFunnelData(baseFilters());
    expect(data.totalSessions).toBe(100);
    expect(row(data.steps, 0).sessions).toBe(100);
    expect(row(data.steps, 1).sessions).toBe(60);
    expect(row(data.steps, 5).sessions).toBe(30);
    expect(row(data.steps, 21).sessions).toBe(10); // el último paso del catálogo
  });

  it("pctOfBase con base='landing' da 100% en el paso 0", async () => {
    await seedHistogram(chau.id, [
      [0, 40],
      [1, 30],
      [5, 20],
      [21, 10],
    ]);
    const data = await getFunnelData(baseFilters());
    expect(row(data.steps, 0).pctOfBase).toBe(100);
  });

  it("pctOfBase con base='start' da 100% en el paso 1 y el paso 0 no se lista", async () => {
    await seedHistogram(chau.id, [
      [0, 40],
      [1, 30],
      [5, 20],
      [21, 10],
    ]);
    const data = await getFunnelData(baseFilters({ base: 'start' }));
    expect(data.steps.some((s) => s.stepIndex === 0)).toBe(false);
    expect(data.steps[0]!.stepIndex).toBe(1);
    expect(data.steps[0]!.pctOfBase).toBe(100);
    expect(row(data.steps, 21).pctOfBase).toBeCloseTo((10 / 60) * 100, 5);
  });

  it('cero sesiones → todo en 0 y no hay NaN ni Infinity en el JSON', async () => {
    const data = await getFunnelData({
      funnelId: chau.id,
      from: DAY_EMPTY,
      to: DAY_EMPTY,
      base: 'landing',
    });
    expect(data.totalSessions).toBe(0);
    expect(data.quizStarted).toBe(0);
    expect(data.salesViews).toBe(0);
    expect(data.checkoutClicks).toBe(0);
    expect(data.purchases).toBe(0);
    // 22 pasos del catálogo de chauhinchazon + los 3 hitos.
    expect(data.steps).toHaveLength(25);
    expect(
      data.steps.every(
        (s) =>
          s.sessions === 0 &&
          Number.isFinite(s.pctOfBase) &&
          Number.isFinite(s.pctOfPrevious) &&
          Number.isFinite(s.dropFromPrevious),
      ),
    ).toBe(true);
    const json = JSON.stringify(data);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
  });

  it('filtro por campaña → los totales bajan y ningún paso supera al anterior', async () => {
    await seedHistogram(chau.id, [
      [0, 30],
      [5, 30],
    ], { campaign: 'campaña-a' });
    await seedHistogram(chau.id, [[0, 40]], { campaign: 'campaña-b' });
    const data = await getFunnelData(baseFilters({ utmCampaign: 'campaña-a' }));
    expect(data.totalSessions).toBe(60);
    expect(row(data.steps, 0).sessions).toBe(60);
    expect(row(data.steps, 5).sessions).toBe(30);
    let prev = Infinity;
    for (const s of data.steps) {
      expect(s.sessions).toBeLessThanOrEqual(prev);
      prev = s.sessions;
    }
  });

  it('el peor paso es el de mayor caída (histograma armado a mano)', async () => {
    // Histograma: 100@0, 90@1, 10@2, 9@3 y 8@21 (el paso de venta). Las
    // sesiones @3 llevan los hitos (5 con sales_view, 4 con checkout, 3 con
    // purchase). Un paso con 0 sesiones da una caída del 100 % contra el
    // anterior, así que el histograma tiene que llegar hasta el final del
    // quiz para que la mayor caída no sea la del primer hueco. Caídas
    // relativas contra el paso anterior:
    //   paso 1: 100 - 117/217 = 46,1 %
    //   paso 2: 100 - 27/117  = 76,9 %  ← la mayor
    //   paso 3: 100 - 17/27   = 37,0 %
    //   paso 4: 100 - 8/17    = 52,9 %
    // Los hitos no la superan (37,5 / 20 / 25 %).
    await seedHistogram(chau.id, [
      [0, 100],
      [1, 90],
      [2, 10],
      [21, 8],
    ]);
    for (let i = 0; i < 4; i++) await seedSession(chau.id, 3);
    await seedSession(chau.id, 3, { hitos: 1 });
    await seedSession(chau.id, 3, { hitos: 2 });
    for (let i = 0; i < 3; i++) await seedSession(chau.id, 3, { hitos: 3 });

    const data = await getFunnelData(baseFilters());
    // La misma regla que usa el client: mayor dropFromPrevious entre filas
    // consecutivas, excluyendo la base (la primera fila de la lista).
    let worst = -1;
    let maxDrop = 0;
    data.steps.forEach((s, i) => {
      if (i === 0) return;
      if (s.dropFromPrevious > maxDrop) {
        maxDrop = s.dropFromPrevious;
        worst = i;
      }
    });
    expect(data.steps[worst]!.stepIndex).toBe(2);
  });

  it('una sesión con max_step_index = 5 cuenta en los pasos 0 a 5 y no en el 6', async () => {
    await seedSession(chau.id, 5);
    const data = await getFunnelData(baseFilters());
    for (let i = 0; i <= 5; i++) expect(row(data.steps, i).sessions).toBe(1);
    expect(row(data.steps, 6).sessions).toBe(0);
  });

  it('sesiones de otro funnel en el mismo rango no contaminan el resultado', async () => {
    await seedHistogram(chau.id, [[0, 10]]);
    await seedHistogram(reset.id, [
      [0, 20],
      [3, 5],
    ]);
    const data = await getFunnelData(baseFilters());
    expect(data.totalSessions).toBe(10);
    expect(row(data.steps, 0).sessions).toBe(10);
    expect(row(data.steps, 3).sessions).toBe(0);
  });

  it('porEtapas con el seed de la 017: 8 etapas, sin huérfanas y todo finito con 0 sesiones', async () => {
    const data = await getFunnelData({
      funnelId: chau.id,
      from: DAY_EMPTY,
      to: DAY_EMPTY,
      base: 'landing',
    });
    expect(data.porEtapas.huerfanas).toEqual([]);
    expect(data.porEtapas.etapas).toHaveLength(8);
    expect(data.porEtapas.etapas.map((e) => e.label)).toEqual([
      'Landing',
      'Preguntas',
      'Puente al experto',
      'Diagnóstico',
      'Página de venta',
      'Vio la venta',
      'Clickeó comprar',
      'Compró',
    ]);
    const json = JSON.stringify(data.porEtapas);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
    for (const e of data.porEtapas.etapas) {
      expect(e.sessions).toBe(0);
      expect(Number.isFinite(e.anchoDibujo)).toBe(true);
      expect(e.inconsistente).toBe(false);
    }
  });

  it('porEtapas lee los hitos de las columnas correctas y no toca los pasos', async () => {
    // 10 sesiones completan el quiz: 6 vieron la venta, 5 clickearon, 4 compraron.
    for (let i = 0; i < 2; i++) await seedSession(chau.id, 21, { hitos: 0 });
    await seedSession(chau.id, 21, { hitos: 1 });
    await seedSession(chau.id, 21, { hitos: 1 });
    await seedSession(chau.id, 21, { hitos: 2 });
    for (let i = 0; i < 5; i++) await seedSession(chau.id, 21, { hitos: 3 });

    const data = await getFunnelData(baseFilters());
    const porEtapas = data.porEtapas;
    expect(porEtapas.huerfanas).toEqual([]);
    expect(porEtapas.etapas).toHaveLength(8);

    const hito = (label: string) => porEtapas.etapas.find((e) => e.label === label)!;
    expect(hito('Vio la venta').sessions).toBe(data.salesViews);
    expect(hito('Clickeó comprar').sessions).toBe(data.checkoutClicks);
    expect(hito('Compró').sessions).toBe(data.purchases);
    expect(hito('Compró').fuente).toBe('hito');
    expect(hito('Compró').slugs).toEqual([]);

    // La lista de pasos es intocable: sigue con 22 pasos + 3 hitos (T04 §1).
    expect(data.steps).toHaveLength(25);
    // Los pasos no cambiaron por existir porEtapas: la primera etapa cuenta
    // el paso base y el último paso del catálogo cierra en la última de paso.
    const landing = porEtapas.etapas[0]!;
    expect(landing.fuente).toBe('paso');
    expect(landing.sessions).toBe(row(data.steps, 0).sessions);
    expect(landing.pctOfBase).toBe(100);
  });

  it("base='start' saca Landing del embudo por etapas y el 100% pasa a Preguntas", async () => {
    await seedHistogram(chau.id, [
      [0, 40],
      [21, 30],
    ]);
    const data = await getFunnelData(baseFilters({ base: 'start' }));
    expect(data.porEtapas.etapas).toHaveLength(7);
    expect(data.porEtapas.etapas[0]!.label).toBe('Preguntas');
    expect(data.porEtapas.etapas[0]!.sessions).toBe(30);
    expect(data.porEtapas.etapas[0]!.pctOfBase).toBe(100);
    expect(data.porEtapas.etapas[0]!.pctOfPrevious).toBe(100);
  });

  it('porEtapas respeta los filtros: la etapa base cae con el filtro de campaña', async () => {
    await seedHistogram(chau.id, [[0, 30]], { campaign: 'campaña-a' });
    await seedHistogram(chau.id, [[0, 40]], { campaign: 'campaña-b' });
    const data = await getFunnelData(baseFilters({ utmCampaign: 'campaña-a' }));
    const landing = data.porEtapas.etapas[0]!;
    expect(landing.label).toBe('Landing');
    expect(landing.sessions).toBe(30);
    expect(landing.pctOfBase).toBe(100);
  });

  // Feature: ab-test-popup-descuento, Property 31: El desglose conserva el total y respeta los filtros
  it('Property 31: la suma de filas del desglose iguala el total con los mismos filtros, y cada hito cuenta las sesiones de su fila', async () => {
    const specSesion = fc.record({
      exp: fc.constantFrom('A', 'B', null),
      variante: fc.constantFrom('ar', 'latam'),
      campana: fc.constantFrom('campaña-a', 'campaña-b'),
      pais: fc.constantFrom('AR', 'BR', null),
      hitos: fc.integer({ min: 0, max: 3 }),
      upsellView: fc.boolean(),
      upsellClick: fc.boolean(),
      downsellView: fc.boolean(),
      // Sin decimales: `amount` es numeric(14,2) y el driver devuelve string, así
      // que comparar enteros evita que el test hable de coma flotante en vez de
      // hablar del desglose.
      revenue: fc.integer({ min: 0, max: 50_000 }),
    });
    const filtroVariant = fc.constantFrom(undefined, 'ar', 'latam');
    const filtroCampana = fc.constantFrom(undefined, 'campaña-a', 'campaña-b');
    const filtroPais = fc.constantFrom(undefined, 'AR', 'BR');
    await fc.assert(
      fc.asyncProperty(
        fc.array(specSesion, { minLength: 1, maxLength: 12 }),
        filtroVariant,
        filtroCampana,
        filtroPais,
        async (sesiones, fv, fc2, fp) => {
          // La iteración tiene que ver SÓLO sus propias sesiones: el total y la
          // suma del desglose se comparan contra `filtradas.length`.
          await limpiarDiasDePrueba();
          for (const s of sesiones) {
            await seedSession(chau.id, 21, {
              variant: s.variante,
              campaign: s.campana,
              country: s.pais ?? undefined,
              hitos: s.hitos,
              experiment: s.exp,
              upsellView: s.upsellView,
              upsellClick: s.upsellClick,
              downsellView: s.downsellView,
              revenue: s.revenue,
            });
          }

          const data = await getFunnelData(
            baseFilters({ variant: fv, utmCampaign: fc2, country: fp }),
          );

          // La simulación en JS de los mismos filtros: el oráculo del test.
          const pasa = (s: (typeof sesiones)[number]) =>
            (!fv || s.variante === fv) && (!fc2 || s.campana === fc2) && (!fp || s.pais === fp);
          const filtradas = sesiones.filter(pasa);

          // R9.1 + R9.5: el desglose conserva el total con los mismos filtros.
          expect(data.totalSessions).toBe(filtradas.length);
          const suma = data.experiments.reduce((a, r) => a + r.sessions, 0);
          expect(suma).toBe(filtradas.length);

          // R9.2: cada contador de hito es la cantidad de sesiones de esa
          // fila con la columna correspondiente no nula.
          const filas = data.experiments;
          const grupos = new Map<string, typeof filtradas>();
          for (const s of filtradas) {
            const clave = s.exp ?? SIN_EXPERIMENTO;
            grupos.set(clave, [...(grupos.get(clave) ?? []), s]);
          }
          expect(filas).toHaveLength(grupos.size);
          for (const r of filas) {
            const m = grupos.get(r.experiment) ?? [];
            expect(r.sessions).toBe(m.length);
            expect(r.salesViews).toBe(m.filter((s) => s.hitos >= 1).length);
            expect(r.checkoutClicks).toBe(m.filter((s) => s.hitos >= 2).length);
            expect(r.purchases).toBe(m.filter((s) => s.hitos >= 3).length);
            // La cola del funnel: los tres hitos de upsell/downsell salen de su
            // propia columna, no de la escalera de `hitos`.
            expect(r.upsellViews).toBe(m.filter((s) => s.upsellView).length);
            expect(r.upsellClicks).toBe(m.filter((s) => s.upsellClick).length);
            expect(r.downsellViews).toBe(m.filter((s) => s.downsellView).length);
            // La plata: la subconsulta suma las órdenes aprobadas de las sesiones
            // de ESTA fila y de ninguna otra. Sin duplicar (el bug del join
            // plano) y sin perder (el bug del INNER).
            expect(r.revenue).toBe(m.reduce((a, s) => a + s.revenue, 0));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: ab-test-popup-descuento, Property 33: Las sesiones sin dimensión tienen una fila propia
  it('Property 33: hay exactamente una fila (sin asignar) si y solo si hay sesiones con la dimensión en NULL', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('A', 'B', null), { minLength: 1, maxLength: 12 }),
        async (exps) => {
          // La iteración tiene que ver SÓLO sus propias sesiones: la fila del
          // centinela existe si y sólo si ESTA iteración sembró algún NULL.
          await limpiarDiasDePrueba();
          for (const e of exps) {
            await seedSession(chau.id, 21, { experiment: e });
          }
          const data = await getFunnelData(baseFilters());
          const nulos = exps.filter((e) => e === null).length;
          const sin = data.experiments.filter((r) => r.experiment === SIN_EXPERIMENTO);
          // R9.6: las sesiones NULL caen en UNA fila propia con el centinela.
          expect(sin).toHaveLength(nulos > 0 ? 1 : 0);
          if (nulos > 0) {
            expect(sin[0]!.sessions).toBe(nulos);
            // Sin hitos sembrados, la fila del centinela no inventa compras.
            expect(sin[0]!.salesViews).toBe(0);
            expect(sin[0]!.purchases).toBe(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // ─── El experimento como dimensión de ENTRADA (filtro del embudo) ──────────
  //
  // Es el cambio que convierte la card en un test de verdad: hasta acá el
  // experimento solo agrupaba a la salida, así que se podía ver que B convertía
  // peor pero no en qué paso lo perdía.

  it('el filtro por variante recorta el embudo COMPLETO, no solo el desglose', async () => {
    // A muere en la landing, B llega hasta el final: si el filtro no recortara el
    // histograma, los dos verían las mismas 12 sesiones en el paso 0.
    await seedHistogram(chau.id, [[0, 8]], { experiment: 'A' });
    await seedHistogram(chau.id, [[21, 4]], { experiment: 'B', hitos: 3 });

    const soloA = await getFunnelData(baseFilters({ experiment: 'A' }));
    expect(soloA.totalSessions).toBe(8);
    expect(row(soloA.steps, 0).sessions).toBe(8);
    expect(soloA.purchases).toBe(0);
    // Las etapas también: es la vista que contesta "¿dónde se cae la entrada?".
    expect(soloA.porEtapas.etapas[0]!.sessions).toBe(8);

    const soloB = await getFunnelData(baseFilters({ experiment: 'B' }));
    expect(soloB.totalSessions).toBe(4);
    expect(soloB.purchases).toBe(4);

    // Sin filtro, las dos juntas: el filtro recorta, no reescribe.
    const juntas = await getFunnelData(baseFilters());
    expect(juntas.totalSessions).toBe(12);
  });

  it('filtrar por el centinela trae las sesiones que NO participaron del test', async () => {
    // El caso que un `experiment = $8` pelado devolvería vacío: en SQL nada es
    // igual a NULL, así que el filtro necesita su rama IS NULL.
    await seedHistogram(chau.id, [[5, 7]], { experiment: null });
    await seedHistogram(chau.id, [[5, 3]], { experiment: 'B' });

    const sinAsignar = await getFunnelData(baseFilters({ experiment: SIN_EXPERIMENTO }));
    expect(sinAsignar.totalSessions).toBe(7);
    expect(sinAsignar.experiments).toHaveLength(1);
    expect(sinAsignar.experiments[0]!.experiment).toBe(SIN_EXPERIMENTO);
  });

  it('una variante inexistente devuelve un embudo vacío, no un error', async () => {
    await seedHistogram(chau.id, [[5, 5]], { experiment: 'A' });
    const nada = await getFunnelData(baseFilters({ experiment: 'Z' }));
    expect(nada.totalSessions).toBe(0);
    expect(nada.experiments).toEqual([]);
  });

  it('el filtro del experimento se combina con los otros filtros', async () => {
    await seedHistogram(chau.id, [[5, 6]], { experiment: 'B', campaign: 'campaña-a' });
    await seedHistogram(chau.id, [[5, 9]], { experiment: 'B', campaign: 'campaña-b' });
    await seedHistogram(chau.id, [[5, 4]], { experiment: 'A', campaign: 'campaña-a' });

    const data = await getFunnelData(baseFilters({ experiment: 'B', utmCampaign: 'campaña-a' }));
    expect(data.totalSessions).toBe(6);
  });

  // ─── La plata por variante ─────────────────────────────────────────────────

  it('la plata suma las órdenes aprobadas y descarta los reembolsos', async () => {
    await seedSession(chau.id, 21, { experiment: 'A', hitos: 3, revenue: 10_000 });
    await seedSession(chau.id, 21, { experiment: 'A', hitos: 3, revenue: 10_000, revenueRechazado: 7_000 });
    await seedSession(chau.id, 21, { experiment: 'B', hitos: 3, revenue: 30_000 });

    const data = await getFunnelData(baseFilters());
    const a = data.experiments.find((r) => r.experiment === 'A')!;
    const b = data.experiments.find((r) => r.experiment === 'B')!;
    expect(a.revenue).toBe(20_000); // los 7.000 reembolsados NO entran
    expect(b.revenue).toBe(30_000);
    expect(a.revenuePerSession).toBe(20_000 / 2);
    expect(b.revenuePerSession).toBe(30_000);
  });

  it('una sesión con DOS órdenes (front + upsell) suma las dos y sigue contando como UNA sesión', async () => {
    // La trampa del join plano: duplicaría la sesión en cada count(*) y esta
    // variante mostraría 2 sesiones y 2 compras con una sola persona.
    const day = DAY;
    const sessionId = randomUUID();
    await q(
      `INSERT INTO sessions (id, funnel_id, visitor_id, variant, day, started_at, last_seen_at,
         max_step_index, sales_view_at, checkout_click_at, purchased_at, utm_campaign, experiment,
         upsell_view_at, upsell_click_at)
       VALUES ($1::uuid, $2, $3::uuid, 'ar', $4::date, $5::timestamptz, $5::timestamptz, 21,
               $5::timestamptz, $5::timestamptz, $5::timestamptz, '(directo)', 'B',
               $5::timestamptz, $5::timestamptz)`,
      [sessionId, chau.id, randomUUID(), day, `${day}T12:00:00Z`],
    );
    for (const monto of [8_790, 16_900]) {
      await q(
        `INSERT INTO orders (funnel_id, source, external_id, status, amount, currency,
                             session_id, purchased_at, day)
         VALUES ($1, 'test', $2, 'approved', $3, 'ARS', $4::uuid, $5::timestamptz, $6::date)`,
        [chau.id, `abtest-${randomUUID()}`, monto, sessionId, `${day}T12:30:00Z`, day],
      );
    }

    const data = await getFunnelData(baseFilters());
    const b = data.experiments.find((r) => r.experiment === 'B')!;
    expect(b.sessions).toBe(1);
    expect(b.purchases).toBe(1);
    expect(b.upsellClicks).toBe(1);
    expect(b.revenue).toBe(8_790 + 16_900);
    expect(b.revenuePerSession).toBe(8_790 + 16_900);
  });

  it('la sesión sin órdenes aporta 0 y sigue en el denominador', async () => {
    // La trampa del INNER JOIN: se comería las sesiones que no compraron y la
    // conversión de toda variante daría 100%.
    await seedSession(chau.id, 21, { experiment: 'A', hitos: 3, revenue: 9_000 });
    await seedHistogram(chau.id, [[3, 9]], { experiment: 'A' }); // nueve que no compraron

    const data = await getFunnelData(baseFilters());
    const a = data.experiments.find((r) => r.experiment === 'A')!;
    expect(a.sessions).toBe(10);
    expect(a.revenue).toBe(9_000);
    expect(a.revenuePerSession).toBe(900);
    expect(a.pctSessionToPurchase).toBe(10);
  });

  it('el take rate del upsell se mide sobre las compras del front', async () => {
    // 4 compras, 2 clics de upsell ⇒ 50%. El denominador NO son las 3 vistas.
    await seedSession(chau.id, 21, { experiment: 'B', hitos: 3, upsellView: true, upsellClick: true });
    await seedSession(chau.id, 21, { experiment: 'B', hitos: 3, upsellView: true, upsellClick: true });
    await seedSession(chau.id, 21, { experiment: 'B', hitos: 3, upsellView: true });
    await seedSession(chau.id, 21, { experiment: 'B', hitos: 3 });

    const data = await getFunnelData(baseFilters());
    const b = data.experiments.find((r) => r.experiment === 'B')!;
    expect(b.purchases).toBe(4);
    expect(b.upsellViews).toBe(3);
    expect(b.upsellClicks).toBe(2);
    expect(b.pctUpsellTake).toBe(50);
  });
});
