import { existsSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { q, q1 } from '../db';
import {
  abrirAccion,
  armarExplicacion,
  cerrarAccion,
  decidioConMeta,
  explicacionDeRelectura,
  metricsDeRelectura,
  textoAntiguedad,
  type RelecturaPreflight,
  type ResultadoRelectura,
} from './acciones';

/**
 * La Discrepancia en la auditoría (task 14.2 de frescura-y-acciones-anuncios,
 * R6.3 y R6.5).
 *
 * QUÉ DEFIENDE ESTE ARCHIVO. La relectura selectiva (task 14.1) ya decide con el
 * estado real de Meta, pero una decisión que no queda escrita no se puede
 * auditar: dos meses después, la fila de un objeto omitido y la de uno omitido
 * contra un dato de cinco días son idénticas, y la pregunta que originó todo el
 * spec —«¿el botón está roto o el dato estaba viejo?»— vuelve a no tener
 * respuesta. Acá se fija que el rastro exista, que diga lo mismo en el jsonb y
 * en el renglón en castellano, y que la clase de Discrepancia que el `status`
 * solo no sabe contar (la del `effective_status`) también se vea.
 *
 * Los tres primeros bloques son funciones puras: sin base, sin red, nada que
 * mockear. El último hace el viaje completo `abrirAccion` → `ad_actions.metrics`
 * → lectura, porque el fragmento se escribe como jsonb y la propiedad que
 * importa —que el cierre de la Omisión NO se lo lleve puesto— sólo se puede
 * verificar en Postgres. Ese bloque se saltea sin `DATABASE_URL`, como el resto
 * de la suite, y borra las filas que siembra.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

const SYNC_VIEJO = '2025-01-01T00:00:00.000Z';
const DOS_DIAS = 2 * 86_400;

/** Una relectura con lo mínimo puesto y el resto sobreescribible por caso. */
function rel(over: Partial<RelecturaPreflight> = {}): RelecturaPreflight {
  return {
    objectId: '120210000000000001',
    causa: 'vieja',
    syncedAt: SYNC_VIEJO,
    edadSegundos: DOS_DIAS,
    local: 'PAUSED',
    real: null,
    localEffective: 'PAUSED',
    realEffective: null,
    resultado: 'no_intentada',
    detalle: null,
    ...over,
  };
}

/** El caso que arregla el bug reportado: la base decía PAUSED, Meta ACTIVE. */
const DISCREPA_STATUS = rel({
  resultado: 'discrepa',
  local: 'PAUSED',
  localEffective: 'PAUSED',
  real: 'ACTIVE',
  realEffective: 'ACTIVE',
});

/** El caso que la task 14.1 dejó marcado: `status` igual en los dos lados y la
 *  Discrepancia entera en el `effective_status`. Es un objeto que figura activo
 *  y NO entrega. */
const DISCREPA_EFECTIVO = rel({
  resultado: 'discrepa',
  local: 'ACTIVE',
  localEffective: 'ACTIVE',
  real: 'ACTIVE',
  realEffective: 'WITH_ISSUES',
});

const COINCIDE = rel({
  resultado: 'coincide',
  real: 'PAUSED',
  realEffective: 'PAUSED',
});

describe('metricsDeRelectura: qué queda escrito en ad_actions.metrics (R6.3, R6.5)', () => {
  it('sin relectura no escribe nada: el caso normal no paga el rastro', () => {
    // El objeto cuyo dato estaba dentro del umbral no necesita bloque: la
    // ausencia de la clave ES el dato de que la copia local alcanzaba.
    expect(metricsDeRelectura(undefined)).toBeNull();
  });

  it('una Discrepancia de status deja los cuatro estados y el synced_at', () => {
    const m = metricsDeRelectura(DISCREPA_STATUS)!;

    expect(m.discrepancia).toEqual({
      local: 'PAUSED',
      real: 'ACTIVE',
      localEffective: 'PAUSED',
      realEffective: 'ACTIVE',
      syncedAt: SYNC_VIEJO,
    });
    expect(m.revalidacion.resultado).toBe('discrepa');
    expect(m.revalidacion.causa).toBe('vieja');
    expect(m.revalidacion.decidioConMeta).toBe(true);
    expect(m.revalidacion.edadSegundos).toBe(DOS_DIAS);
  });

  it('una Discrepancia de effective_status no queda como dos estados iguales', () => {
    const m = metricsDeRelectura(DISCREPA_EFECTIVO)!;

    // Con sólo `local` y `real` esta fila diría ACTIVE y ACTIVE: una
    // Discrepancia invisible. El par que cambió es el otro.
    expect(m.discrepancia!.local).toBe(m.discrepancia!.real);
    expect(m.discrepancia!.localEffective).toBe('ACTIVE');
    expect(m.discrepancia!.realEffective).toBe('WITH_ISSUES');
  });

  it('cuando Meta confirma el dato local queda el rastro, sin bloque de discrepancia', () => {
    const m = metricsDeRelectura(COINCIDE)!;

    // Lo que esta fila prueba es que la Omisión se decidió contra Meta y no
    // contra una fila de dos días. Sin el bloque, esa fila y la de un objeto
    // omitido a ciegas son iguales.
    expect(m.discrepancia).toBeUndefined();
    expect(m.revalidacion.resultado).toBe('coincide');
    expect(m.revalidacion.decidioConMeta).toBe(true);
  });

  it('las tres salidas que no llegaron a Meta quedan distinguibles y con su motivo (R6.5)', () => {
    const casos: { resultado: ResultadoRelectura; detalle: string }[] = [
      { resultado: 'error', detalle: '(#17) User request limit reached' },
      { resultado: 'no_encontrado', detalle: 'Meta no devolvió el objeto en la relectura' },
      { resultado: 'no_intentada', detalle: 'hay un backoff por cuota activo' },
    ];
    for (const c of casos) {
      const m = metricsDeRelectura(rel({ resultado: c.resultado, detalle: c.detalle }))!;
      expect(m.discrepancia, c.resultado).toBeUndefined();
      expect(m.revalidacion.decidioConMeta, c.resultado).toBe(false);
      expect(m.revalidacion.detalle, c.resultado).toBe(c.detalle);
      // La antigüedad del dato con el que se decidió igual: es lo único que
      // permite juzgar después si la decisión era razonable.
      expect(m.revalidacion.syncedAt, c.resultado).toBe(SYNC_VIEJO);
      expect(m.revalidacion.edadSegundos, c.resultado).toBe(DOS_DIAS);
    }
  });

  it('la causa distingue el objeto viejo del marcado como desaparecido', () => {
    const marcado = metricsDeRelectura(rel({ causa: 'desaparecida', edadSegundos: 60 }))!;
    expect(marcado.revalidacion.causa).toBe('desaparecida');
    // Un objeto marcado puede tener el dato fresco: se releyó por la marca.
    expect(marcado.revalidacion.edadSegundos).toBe(60);
  });
});

describe('explicacionDeRelectura y el renglón en castellano (R6.3)', () => {
  it('sin relectura no agrega texto', () => {
    expect(explicacionDeRelectura(undefined)).toBeUndefined();
  });

  it('la Discrepancia de status nombra los dos estados y la antigüedad', () => {
    const t = explicacionDeRelectura(DISCREPA_STATUS)!;
    expect(t).toContain('discrepancia');
    expect(t).toContain('ACTIVE');
    expect(t).toContain('PAUSED');
    expect(t).toContain('de hace 2 d');
  });

  it('la Discrepancia de effective_status NO se lee como dos estados iguales', () => {
    const t = explicacionDeRelectura(DISCREPA_EFECTIVO)!;
    // El texto que este caso no puede producir: «Meta decía ACTIVE y la base
    // ACTIVE», que informa una Discrepancia y a la vez la esconde.
    expect(t).toContain('WITH_ISSUES');
    expect(t).toMatch(/ACTIVE\/WITH_ISSUES/);
  });

  it('el efectivo se calla cuando el status ya distingue los dos lados', () => {
    // La Discrepancia normal, la del bug reportado: cuatro valores consistentes
    // en dos pares. Nombrarlos todos no agrega nada y compite con el nombre del
    // objeto por los 300 caracteres.
    expect(explicacionDeRelectura(DISCREPA_STATUS)!).toContain('Meta decía ACTIVE y la base PAUSED');

    // Tampoco aporta un «desconocido/desconocido» cuando ningún lado informó el
    // efectivo.
    const sinEfectivos = rel({
      resultado: 'discrepa',
      local: 'PAUSED',
      localEffective: null,
      real: 'ACTIVE',
      realEffective: null,
    });
    expect(explicacionDeRelectura(sinEfectivos)!).toContain('Meta decía ACTIVE y la base PAUSED');
  });

  it('cuando Meta dice que no entrega, el efectivo se nombra aunque el status también cambie', () => {
    // Sin esto la frase diría que el objeto pasó a ACTIVE y se callaría que
    // sigue sin entregar, que es el síntoma reportado como «parece que lo
    // habilita pero realmente no lo hace».
    const t = explicacionDeRelectura(
      rel({
        resultado: 'discrepa',
        local: 'PAUSED',
        localEffective: 'PAUSED',
        real: 'ACTIVE',
        realEffective: 'CAMPAIGN_PAUSED',
      }),
    )!;
    expect(t).toContain('Meta decía ACTIVE/CAMPAIGN_PAUSED');
    expect(t).toContain('la base PAUSED/PAUSED');
  });

  it('un efectivo que Meta no informó se dice desconocido, no se omite', () => {
    // El contraejemplo que encontró la Property 10: los `status` coinciden y lo
    // único que cambió es que Meta no devolvió el efectivo. Omitirlo dejaba el
    // renglón diciendo «Meta decía PAUSED y la base PAUSED».
    const t = explicacionDeRelectura(
      rel({
        resultado: 'discrepa',
        local: 'PAUSED',
        localEffective: 'PAUSED',
        real: 'PAUSED',
        realEffective: null,
      }),
    )!;
    expect(t).toContain('Meta decía PAUSED/desconocido');
    expect(t).toContain('la base PAUSED/PAUSED');
  });

  it('coincide dice que se revalidó; las otras tres dicen que no se pudo', () => {
    expect(explicacionDeRelectura(COINCIDE)!).toContain('revalidado contra Meta');

    for (const resultado of ['error', 'no_encontrado', 'no_intentada'] as const) {
      const t = explicacionDeRelectura(rel({ resultado }))!;
      expect(t, resultado).toContain('sin revalidar');
      expect(t, resultado).toContain('de hace 2 d');
    }
  });

  it('un dato sin synced_at no se dice como recién sincronizado', () => {
    const t = explicacionDeRelectura(rel({ resultado: 'error', syncedAt: null, edadSegundos: null }))!;
    expect(t).toContain('sin fecha de sincronización');
    expect(t).not.toContain('hace');
  });

  it('los escalones de textoAntiguedad son los de la barra de frescura', () => {
    expect(textoAntiguedad(null)).toBe('sin fecha de sincronización');
    expect(textoAntiguedad(0)).toBe('de hace menos de un minuto');
    expect(textoAntiguedad(59)).toBe('de hace menos de un minuto');
    expect(textoAntiguedad(60)).toBe('de hace 1 min');
    expect(textoAntiguedad(3_599)).toBe('de hace 60 min');
    expect(textoAntiguedad(3_600)).toBe('de hace 1 h');
    expect(textoAntiguedad(86_399)).toBe('de hace 24 h');
    expect(textoAntiguedad(86_400)).toBe('de hace 1 d');
    expect(textoAntiguedad(494_224)).toBe('de hace 6 d'); // los 5 d 17 h de producción
  });

  it('la explicación de pause y activate incorpora el extra, con el tope de 300 intacto', () => {
    const conDiscrepancia = armarExplicacion({
      accion: 'activate',
      nivel: 'adset',
      objectName: 'Conjunto – frío – LAL 1 %',
      objectId: '120210000000000001',
      accountId: 'act_123',
      extra: explicacionDeRelectura(DISCREPA_STATUS),
    });
    expect(conDiscrepancia).toContain('se activó el conjunto');
    expect(conDiscrepancia).toContain('discrepancia');
    expect(conDiscrepancia.length).toBeLessThanOrEqual(300);

    // Sin relectura la frase queda igual que antes de esta task: `extra` es
    // `undefined` y no aparece ningún separador colgado.
    const sinNada = armarExplicacion({
      accion: 'pause',
      nivel: 'adset',
      objectName: 'Conjunto',
      objectId: '120210000000000001',
      accountId: 'act_123',
      extra: explicacionDeRelectura(undefined),
    });
    expect(sinNada).toBe('Manual: se pausó el conjunto «Conjunto» (act_123).');
  });

  it('con un nombre desmedido el corte de 300 se respeta y la Discrepancia sobrevive en metrics', () => {
    const largo = armarExplicacion({
      accion: 'pause',
      nivel: 'campaign',
      objectName: 'N'.repeat(400),
      objectId: '120210000000000001',
      accountId: 'act_123',
      extra: explicacionDeRelectura(DISCREPA_STATUS),
    });
    expect(largo.length).toBe(300);
    // El renglón se lo comió el nombre; el jsonb no se trunca nunca, y es la
    // razón por la que la Discrepancia se guarda en los dos lugares.
    expect(metricsDeRelectura(DISCREPA_STATUS)!.discrepancia!.real).toBe('ACTIVE');
  });
});

// ─── Generadores ─────────────────────────────────────────────────────────────
// Locales a este archivo: son rastros de relectura, no objetos del dominio que
// comparta otra suite. Constrained a lo que `relecturaSelectiva` puede producir:
// `coincide` implica que los dos pares son iguales, `discrepa` que al menos uno
// difiere, y las tres salidas sin lectura implican `real` y `realEffective` en
// null. Generar combinaciones imposibles probaría una función que nadie llama
// así.

const estado: fc.Arbitrary<string | null> = fc.constantFrom(
  'ACTIVE',
  'PAUSED',
  'WITH_ISSUES',
  'CAMPAIGN_PAUSED',
  'ADSET_PAUSED',
  'ARCHIVED',
  null,
);

const genRelectura: fc.Arbitrary<RelecturaPreflight> = fc
  .record({
    resultado: fc.constantFrom<ResultadoRelectura>(
      'coincide',
      'discrepa',
      'no_encontrado',
      'error',
      'no_intentada',
    ),
    causa: fc.constantFrom<'vieja' | 'desaparecida'>('vieja', 'desaparecida'),
    local: estado,
    localEffective: estado,
    real: estado,
    realEffective: estado,
    edadSegundos: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 30 * 86_400 })),
    detalle: fc.oneof(fc.constant(null), fc.string({ maxLength: 40 })),
  })
  .map((r) => {
    const base: RelecturaPreflight = {
      objectId: '120210000000000001',
      causa: r.causa,
      syncedAt: r.edadSegundos === null ? null : SYNC_VIEJO,
      edadSegundos: r.edadSegundos,
      local: r.local,
      localEffective: r.localEffective,
      real: r.real,
      realEffective: r.realEffective,
      resultado: r.resultado,
      detalle: r.detalle,
    };
    if (r.resultado === 'coincide') {
      return { ...base, real: r.local, realEffective: r.localEffective, detalle: null };
    }
    if (r.resultado === 'discrepa') {
      // Al menos un par distinto, que es lo que `relecturaSelectiva` exige para
      // marcar `discrepa`. Si el sorteo dio los cuatro valores iguales se mueve
      // el efectivo, que es el caso interesante; el valor nuevo se elige CONTRA
      // el que ya está, no fijo: con `WITH_ISSUES` fijo, un sorteo que ya había
      // puesto `WITH_ISSUES` dejaba los dos pares iguales y el generador armaba
      // una entrada que la función real nunca produce.
      const igual = r.real === r.local && r.realEffective === r.localEffective;
      if (!igual) return { ...base, detalle: null };
      const otroEfectivo = r.localEffective === 'WITH_ISSUES' ? 'ACTIVE' : 'WITH_ISSUES';
      return { ...base, realEffective: otroEfectivo, detalle: null };
    }
    return { ...base, real: null, realEffective: null };
  });

// Feature: frescura-y-acciones-anuncios, Property 10: Toda escritura queda
// auditada y clasificada
//
// **Validates: Requirements 6.5**
//
// La mitad de la propiedad que vive en este módulo. Que exista exactamente una
// fila por llamada la sostienen `abrirAccion`/`cerrarAccion` y el orden del
// route; lo que se verifica acá es la CLASIFICACIÓN: para todo rastro de
// relectura, el jsonb y el renglón en castellano coinciden en si la decisión se
// tomó contra Meta o contra la copia local, y una Discrepancia nunca se escribe
// como un par de estados iguales. Dos textos que se contradicen sobre la misma
// fila son peor que ninguno: es la forma en que la auditoría empieza a mentir.
describe('Property 10 (R6.5)', () => {
  it('para todo rastro de relectura, metrics y explicacion clasifican igual', () => {
    fc.assert(
      fc.property(genRelectura, (r) => {
        const m = metricsDeRelectura(r)!;
        const t = explicacionDeRelectura(r)!;

        // 1. Siempre hay rastro cuando hubo relectura, y siempre hay texto.
        expect(m.revalidacion.resultado).toBe(r.resultado);
        expect(t.length).toBeGreaterThan(0);

        // 2. Las dos caras dicen lo mismo sobre lo único que R6.5 pide
        //    distinguir: si esto llegó a Meta o se decidió a ciegas.
        expect(m.revalidacion.decidioConMeta).toBe(decidioConMeta(r));
        expect(t.includes('sin revalidar')).toBe(!decidioConMeta(r));

        // 3. El bloque `discrepancia` existe exactamente cuando hubo una.
        expect('discrepancia' in m).toBe(r.resultado === 'discrepa');

        // 4. Y cuando existe, el texto NUNCA muestra lo mismo en los dos lados.
        //    Es la invariante que la primera versión de esta función no cumplía:
        //    con el efectivo de Meta en null y el `status` igual al de la base, el
        //    renglón decía «Meta decía PAUSED y la base PAUSED», informando una
        //    Discrepancia y escondiéndola en la misma frase. Los lados se leen
        //    del texto y no se recalculan, para que el test no repita la regla
        //    que está verificando.
        if (m.discrepancia) {
          const cambioElStatus = m.discrepancia.local !== m.discrepancia.real;
          const cambioElEfectivo = m.discrepancia.localEffective !== m.discrepancia.realEffective;
          expect(cambioElStatus || cambioElEfectivo).toBe(true);

          const lados = /Meta decía (.+?) y la base (.+?) \(dato /.exec(t);
          expect(lados, t).not.toBeNull();
          expect(lados![1], t).not.toBe(lados![2]);
        }

        // 5. La antigüedad viaja siempre: es el dato que R6.1 pide nombrar y el
        //    que permite juzgar la decisión meses después.
        expect(m.revalidacion.edadSegundos).toBe(r.edadSegundos);
        expect(t).toContain(textoAntiguedad(r.edadSegundos).replace('de hace', 'hace'));
      }),
      { numRuns: 500 },
    );
  });
});

// ─── El viaje a la base ──────────────────────────────────────────────────────

const CUENTA = `T142-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OBJETO = '120210000000000001';

type FilaAuditoria = {
  estado: string;
  explicacion: string;
  tipo: string | null;
  metrics: Record<string, unknown>;
};

async function leerFila(id: number): Promise<FilaAuditoria> {
  const f = await q1<FilaAuditoria>(
    `SELECT estado, explicacion, jsonb_typeof(metrics) AS tipo, metrics FROM ad_actions WHERE id = $1`,
    [id],
  );
  if (!f) throw new Error(`no quedó fila de auditoría ${id}`);
  return f;
}

/** La fila de una Omisión, como la abre el route: métricas en `abrirAccion` —el
 *  dato con el que se decidió existe ANTES de decidir— y cierre sin métricas. */
async function abrirOmision(r: RelecturaPreflight | undefined): Promise<number> {
  return await abrirAccion({
    accountId: CUENTA,
    nivel: 'adset',
    objectId: OBJETO,
    objectName: 'Conjunto de la task 14.2',
    accion: 'pause',
    before: 'PAUSED',
    after: 'PAUSED',
    explicacion: armarExplicacion({
      accion: 'pause',
      nivel: 'adset',
      objectName: 'Conjunto de la task 14.2',
      objectId: OBJETO,
      accountId: CUENTA,
      extra: explicacionDeRelectura(r),
    }),
    actorHint: 'ip=test ua=vitest',
    metrics: metricsDeRelectura(r) ?? undefined,
  });
}

describe.skipIf(!dbAvailable)('el viaje a ad_actions.metrics (R6.3, R6.5)', () => {
  afterAll(async () => {
    await q(`DELETE FROM ad_actions WHERE account_id = $1`, [CUENTA]);
  });

  it('la Discrepancia sobrevive al cierre de la Omisión, que no le pasa métricas', async () => {
    const id = await abrirOmision(DISCREPA_STATUS);
    await cerrarAccion(id, 'omitido');

    const f = await leerFila(id);
    // El cierre sin métricas no puede convertir el objeto en un array: era el
    // bug que dejaba `metrics = [{}, null]` en las filas manuales de la base.
    expect(f.tipo).toBe('object');
    expect(f.estado).toBe('omitido');
    expect(f.metrics.discrepancia).toEqual({
      local: 'PAUSED',
      real: 'ACTIVE',
      localEffective: 'PAUSED',
      realEffective: 'ACTIVE',
      syncedAt: SYNC_VIEJO,
    });
    expect(f.explicacion).toContain('discrepancia');
  });

  it('se puede consultar por su nombre: las filas donde la copia local mintió', async () => {
    const conDiscrepancia = await abrirOmision(DISCREPA_EFECTIVO);
    await cerrarAccion(conDiscrepancia, 'confirmado');
    const revalidada = await abrirOmision(COINCIDE);
    await cerrarAccion(revalidada, 'omitido');
    const aCiegas = await abrirOmision(rel({ resultado: 'error', detalle: 'timeout' }));
    await cerrarAccion(aCiegas, 'omitido', { error: 'timeout' });
    const sinRelectura = await abrirOmision(undefined);
    await cerrarAccion(sinRelectura, 'omitido');

    // La pregunta de R6.3 en SQL, sin leer el texto de nadie.
    const conDiscrepanciaIds = await q<{ id: string }>(
      `SELECT id FROM ad_actions WHERE account_id = $1 AND metrics ? 'discrepancia' ORDER BY id`,
      [CUENTA],
    );
    expect(conDiscrepanciaIds.map((f) => Number(f.id))).toContain(conDiscrepancia);
    expect(conDiscrepanciaIds.map((f) => Number(f.id))).not.toContain(revalidada);

    // La de R6.5: lo que no llegó a Meta, distinguible de lo que sí.
    const aCiegasIds = await q<{ id: string }>(
      `SELECT id FROM ad_actions
        WHERE account_id = $1 AND metrics -> 'revalidacion' ->> 'decidioConMeta' = 'false'
        ORDER BY id`,
      [CUENTA],
    );
    expect(aCiegasIds.map((f) => Number(f.id))).toEqual([aCiegas]);

    // Y la fila del caso normal no gana ninguna clave: sin relectura, sin ruido.
    const limpia = await leerFila(sinRelectura);
    expect(limpia.metrics).toEqual({});
    expect(limpia.explicacion).not.toContain('revalid');
  });

  it('un cierre que sí trae métricas las suma sin borrar la Discrepancia', async () => {
    const id = await abrirOmision(DISCREPA_STATUS);
    await cerrarAccion(id, 'fallido', { error: 'Meta rechazó', metrics: { pendiente_verificacion: true } });

    const f = await leerFila(id);
    expect(f.metrics.pendiente_verificacion).toBe(true);
    expect((f.metrics.discrepancia as Record<string, unknown>).real).toBe('ACTIVE');
  });
});
