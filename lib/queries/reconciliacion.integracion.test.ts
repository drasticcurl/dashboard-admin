/**
 * Tests de integración de la reconciliación — contra Postgres real.
 *
 * ─── POR QUE ESTE ARCHIVO EXISTE Y NO ALCANZA `reconciliacion.test.ts` ─────
 * El otro archivo prueba `calcularHueco`, que es la aritmética. Lo que NO puede
 * probar es la parte que de verdad podía estar mal: que la IDENTIDAD cierre.
 *
 *   ganancia medida (Δpatrimonio − retiros − aportes)  ≈  (neto − ads) − gastos
 *
 * El lado izquierdo lo calcula un CTE de `saldo.ts` sobre saldos tipeados; el
 * derecho, un GROUP BY sobre `daily_metrics` y `finance_movements`. La identidad
 * fue DERIVADA leyendo esos dos módulos, y una derivación en un comentario no es
 * una verificación: si tuviera un signo al revés, la columna "hueco" mostraría un
 * número perfectamente creíble y el análisis de arriba diría que falta plata que
 * no falta.
 *
 * Por eso el caso 1 arma un mes completo con números elegidos a mano y exige
 * hueco EXACTAMENTE 0.
 *
 * Aislamiento: cuentas con prefijo 'test-recon-', movimientos con la nota con el
 * mismo prefijo, y `daily_metrics` de un funnel de prueba. Es estricto porque
 * `serieMensual` lee TODA la tabla, no un rango: una fila que sobreviva cambia el
 * resultado del test siguiente. Mismo criterio que `saldo.test.ts`.
 *
 * Las fechas son de 2024 a propósito, y el año NO es arbitrario:
 *
 *  · Tiene que ser PASADO. `serieMensual` genera los meses hacia atrás desde hoy,
 *    así que un mes futuro nunca entra en la ventana: el `find` devolvería
 *    undefined, ninguna aserción correría y el test pasaría en verde sin verificar
 *    nada. (Primero escribí 2031 y era exactamente eso.)
 *  · Tiene que ser ANTERIOR a cualquier saldo real. `finance_accounts` y
 *    `finance_account_balances` nacen con la migración 028, de 2026-08, así que en
 *    2024 no puede haber ninguna fila real y las 4 cuentas que siembra esa
 *    migración (con `opened_on = CURRENT_DATE`) no están vigentes: no ensucian el
 *    conteo de "esperadas" ni la completitud de estos días.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { q } from '../db';
import { createAccount, guardarSaldosDelDia } from './saldo';
import { createMovement } from './finance';
import { reconciliarMeses } from './reconciliacion';

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}
const dbAvailable = Boolean(process.env.DATABASE_URL);

const PREFIX = 'test-recon-';
const n = (s: string): string => `${PREFIX}${s}`;

/** El funnel de prueba. Se crea con un id alto para no chocar con los reales. */
const FUNNEL_ID = 32001;

async function cleanup(): Promise<void> {
  await q(`DELETE FROM finance_accounts WHERE name LIKE $1`, [`${PREFIX}%`]);
  await q(`DELETE FROM finance_movements WHERE note LIKE $1`, [`${PREFIX}%`]);
  await q(`DELETE FROM daily_metrics WHERE funnel_id = $1`, [FUNNEL_ID]);
  await q(`DELETE FROM funnels WHERE id = $1`, [FUNNEL_ID]);
}

async function crearFunnel(): Promise<void> {
  // `ingest_key_hash` es NOT NULL: es la clave con la que el funnel se autentica
  // contra /api/ingest. Este funnel no ingesta nada, así que va un hash
  // cualquiera con el prefijo de los tests.
  await q(
    `INSERT INTO funnels (id, slug, name, ingest_key_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [FUNNEL_ID, n('funnel'), n('Funnel'), `${PREFIX}sin-ingest`],
  );
}

/** Una fila de daily_metrics. Sólo las columnas que la reconciliación lee. */
async function metrica(
  day: string,
  v: { bruto?: number; devuelto?: number; comisiones?: number; costos?: number; ads?: number },
): Promise<void> {
  await q(
    `INSERT INTO daily_metrics
       (funnel_id, day, variant, revenue_gross_eur, revenue_refunded_eur,
        commissions_eur, costs_eur, ad_spend_eur)
     VALUES ($1, $2::date, '*', $3, $4, $5, $6, $7)`,
    [FUNNEL_ID, day, v.bruto ?? 0, v.devuelto ?? 0, v.comisiones ?? 0, v.costos ?? 0, v.ads ?? 0],
  );
}

describe.skipIf(!dbAvailable)('reconciliarMeses — la identidad', () => {
  beforeEach(async () => {
    await cleanup();
    await crearFunnel();
  });
  afterEach(cleanup);

  it('1. un mes que cuadra perfecto da hueco EXACTAMENTE 0', async () => {
    // ── El escenario, con los números elegidos para que cierre a mano ──
    //
    // Operación de julio:  bruto 6000 − devuelto 500 − comisiones 300 − costos 200
    //                      = neto 5000 ;  ads 1000  →  resultado operativo 4000
    // Gastos de julio:     900  →  esperado 3100
    //
    // Patrimonio: cierra junio en 10000 y julio en 13100. Δ = 3100.
    // Sin retiros ni aportes, la ganancia medida es 3100 y el hueco es 0.
    const cuenta = await createAccount({
      name: n('banco'),
      kind: 'dinero',
      openedOn: '2024-06-01',
    });

    await guardarSaldosDelDia('2024-06-30', [{ accountId: cuenta.id, amountEur: 10000 }]);
    await guardarSaldosDelDia('2024-07-31', [{ accountId: cuenta.id, amountEur: 13100 }]);

    await metrica('2024-07-10', { bruto: 6000, devuelto: 500, comisiones: 300, costos: 200, ads: 1000 });
    await createMovement({ kind: 'gasto', category: 'sueldos', amountEur: -900, note: n('sueldos'), day: '2024-07-15' });

    const meses = await reconciliarMeses(mesesHasta('2024-07'));
    const julio = meses.find((m) => m.month === '2024-07');

    expect(julio).toBeDefined();
    expect(julio!.netoEur).toBe(5000);
    expect(julio!.adsEur).toBe(1000);
    expect(julio!.resultadoOperativoEur).toBe(4000);
    expect(julio!.gastosEur).toBe(900);
    expect(julio!.esperadoEur).toBe(3100);
    expect(julio!.gananciaMedidaEur).toBe(3100);
    // LA ASERCION QUE JUSTIFICA EL ARCHIVO.
    expect(julio!.huecoEur).toBe(0);
    expect(julio!.huecoPct).toBe(0);
  });

  it('2. un retiro NO abre hueco: sacar plata propia no es una pérdida del negocio', async () => {
    // Mismo mes que el caso 1, pero el dueño retiró 2000. El patrimonio cierra
    // 2000 más abajo (11100) y la ganancia medida tiene que seguir siendo 3100.
    //
    // Es el signo más fácil de equivocar de todo el módulo: los retiros están
    // guardados NEGATIVOS y `serieMensual` los RESTA, así que restarlos los suma
    // de vuelta. Si el signo estuviera al revés, este mes mostraría un hueco de
    // 4000 y parecería que falta el doble de lo que se retiró.
    const cuenta = await createAccount({ name: n('banco'), kind: 'dinero', openedOn: '2024-06-01' });

    await guardarSaldosDelDia('2024-06-30', [{ accountId: cuenta.id, amountEur: 10000 }]);
    await guardarSaldosDelDia('2024-07-31', [{ accountId: cuenta.id, amountEur: 11100 }]);

    await metrica('2024-07-10', { bruto: 6000, devuelto: 500, comisiones: 300, costos: 200, ads: 1000 });
    await createMovement({ kind: 'gasto', category: 'sueldos', amountEur: -900, note: n('sueldos'), day: '2024-07-15' });
    await createMovement({ kind: 'retiro', category: null, amountEur: -2000, note: n('retiro'), day: '2024-07-20' });

    const julio = (await reconciliarMeses(mesesHasta('2024-07'))).find((m) => m.month === '2024-07');

    expect(julio!.retirosEur).toBe(-2000);
    expect(julio!.gananciaMedidaEur).toBe(3100);
    expect(julio!.huecoEur).toBe(0);
  });

  it('3. un aporte tampoco: meter plata propia no es una ganancia', async () => {
    const cuenta = await createAccount({ name: n('banco'), kind: 'dinero', openedOn: '2024-06-01' });

    await guardarSaldosDelDia('2024-06-30', [{ accountId: cuenta.id, amountEur: 10000 }]);
    // 10000 + 3100 de ganancia + 1500 de aporte
    await guardarSaldosDelDia('2024-07-31', [{ accountId: cuenta.id, amountEur: 14600 }]);

    await metrica('2024-07-10', { bruto: 6000, devuelto: 500, comisiones: 300, costos: 200, ads: 1000 });
    await createMovement({ kind: 'gasto', category: 'sueldos', amountEur: -900, note: n('sueldos'), day: '2024-07-15' });
    await createMovement({ kind: 'aporte', category: null, amountEur: 1500, note: n('aporte'), day: '2024-07-05' });

    const julio = (await reconciliarMeses(mesesHasta('2024-07'))).find((m) => m.month === '2024-07');

    expect(julio!.aportesEur).toBe(1500);
    expect(julio!.gananciaMedidaEur).toBe(3100);
    expect(julio!.huecoEur).toBe(0);
  });

  it('4. una venta que nunca llegó al panel aparece como hueco POSITIVO', async () => {
    // El caso que hace útil toda la feature: entraron 800 más de lo que el panel
    // sabe. El patrimonio los ve; daily_metrics no.
    const cuenta = await createAccount({ name: n('banco'), kind: 'dinero', openedOn: '2024-06-01' });

    await guardarSaldosDelDia('2024-06-30', [{ accountId: cuenta.id, amountEur: 10000 }]);
    await guardarSaldosDelDia('2024-07-31', [{ accountId: cuenta.id, amountEur: 13900 }]);

    await metrica('2024-07-10', { bruto: 6000, devuelto: 500, comisiones: 300, costos: 200, ads: 1000 });
    await createMovement({ kind: 'gasto', category: 'sueldos', amountEur: -900, note: n('sueldos'), day: '2024-07-15' });

    const julio = (await reconciliarMeses(mesesHasta('2024-07'))).find((m) => m.month === '2024-07');

    expect(julio!.huecoEur).toBe(800);
  });

  it('5. una cuenta de deuda entra al patrimonio en NEGATIVO', async () => {
    // El gasto de ads se refleja como deuda con Meta hasta que se paga. Con la
    // deuda sumando en vez de restando, este mes mostraría un hueco de +2000.
    const banco = await createAccount({ name: n('banco'), kind: 'dinero', openedOn: '2024-06-01' });
    const meta = await createAccount({ name: n('deuda-meta'), kind: 'deuda', openedOn: '2024-06-01' });

    await guardarSaldosDelDia('2024-06-30', [
      { accountId: banco.id, amountEur: 10000 },
      { accountId: meta.id, amountEur: 0 },
    ]);
    // Cierra con 14100 en el banco y 1000 de deuda → patrimonio 13100.
    await guardarSaldosDelDia('2024-07-31', [
      { accountId: banco.id, amountEur: 14100 },
      { accountId: meta.id, amountEur: 1000 },
    ]);

    await metrica('2024-07-10', { bruto: 6000, devuelto: 500, comisiones: 300, costos: 200, ads: 1000 });
    await createMovement({ kind: 'gasto', category: 'sueldos', amountEur: -900, note: n('sueldos'), day: '2024-07-15' });

    const julio = (await reconciliarMeses(mesesHasta('2024-07'))).find((m) => m.month === '2024-07');

    expect(julio!.cierreEur).toBe(13100);
    expect(julio!.huecoEur).toBe(0);
  });

  it('6. un mes sin cierre completo da ganancia y hueco en null, nunca 0', async () => {
    // Dos cuentas vigentes y sólo una cargada en julio: por D5 ese día no tiene
    // patrimonio, así que el mes no tiene cierre y no se puede medir.
    const banco = await createAccount({ name: n('banco'), kind: 'dinero', openedOn: '2024-06-01' });
    const otra = await createAccount({ name: n('otra'), kind: 'dinero', openedOn: '2024-06-01' });

    await guardarSaldosDelDia('2024-06-30', [
      { accountId: banco.id, amountEur: 10000 },
      { accountId: otra.id, amountEur: 0 },
    ]);
    await guardarSaldosDelDia('2024-07-31', [{ accountId: banco.id, amountEur: 13100 }]);

    await metrica('2024-07-10', { bruto: 6000, devuelto: 500, comisiones: 300, costos: 200, ads: 1000 });

    const julio = (await reconciliarMeses(mesesHasta('2024-07'))).find((m) => m.month === '2024-07');

    expect(julio!.gananciaMedidaEur).toBeNull();
    expect(julio!.huecoEur).toBeNull();
    expect(julio!.huecoPct).toBeNull();
    // El lado operativo SÍ se calcula: no depende de los saldos.
    expect(julio!.esperadoEur).toBe(4000);
  });

  it('7. los ajustes se reportan pero NO entran al hueco', async () => {
    // Un ajuste no mueve plata real, así que no cambia el patrimonio medido.
    // Si entrara al lado esperado, este mes mostraría un hueco de 400 inventado.
    const cuenta = await createAccount({ name: n('banco'), kind: 'dinero', openedOn: '2024-06-01' });

    await guardarSaldosDelDia('2024-06-30', [{ accountId: cuenta.id, amountEur: 10000 }]);
    await guardarSaldosDelDia('2024-07-31', [{ accountId: cuenta.id, amountEur: 13100 }]);

    await metrica('2024-07-10', { bruto: 6000, devuelto: 500, comisiones: 300, costos: 200, ads: 1000 });
    await createMovement({ kind: 'gasto', category: 'sueldos', amountEur: -900, note: n('sueldos'), day: '2024-07-15' });
    await createMovement({ kind: 'ajuste', category: null, amountEur: -400, note: n('ajuste'), day: '2024-07-18' });

    const julio = (await reconciliarMeses(mesesHasta('2024-07'))).find((m) => m.month === '2024-07');

    expect(julio!.ajustesEur).toBe(-400);
    expect(julio!.huecoEur).toBe(0);
  });

  it('8. suma varios días del mes y NO cuenta los de otros meses', async () => {
    const cuenta = await createAccount({ name: n('banco'), kind: 'dinero', openedOn: '2024-06-01' });

    await guardarSaldosDelDia('2024-06-30', [{ accountId: cuenta.id, amountEur: 10000 }]);
    await guardarSaldosDelDia('2024-07-31', [{ accountId: cuenta.id, amountEur: 13100 }]);

    // El neto de julio se reparte en tres días; agosto tiene una venta que no
    // tiene que aparecer en julio.
    await metrica('2024-07-05', { bruto: 2000, devuelto: 200, comisiones: 100, costos: 100, ads: 400 });
    await metrica('2024-07-15', { bruto: 2000, devuelto: 200, comisiones: 100, costos: 50, ads: 300 });
    await metrica('2024-07-25', { bruto: 2000, devuelto: 100, comisiones: 100, costos: 50, ads: 300 });
    await metrica('2024-08-05', { bruto: 9999, ads: 9999 });

    await createMovement({ kind: 'gasto', category: 'sueldos', amountEur: -500, note: n('s1'), day: '2024-07-10' });
    await createMovement({ kind: 'gasto', category: 'otros', amountEur: -400, note: n('s2'), day: '2024-07-20' });
    await createMovement({ kind: 'gasto', category: 'otros', amountEur: -9999, note: n('agosto'), day: '2024-08-02' });

    const julio = (await reconciliarMeses(mesesHasta('2024-07'))).find((m) => m.month === '2024-07');

    expect(julio!.netoEur).toBe(5000);
    expect(julio!.adsEur).toBe(1000);
    expect(julio!.gastosEur).toBe(900);
    expect(julio!.huecoEur).toBe(0);
  });
});

/**
 * Cuántos meses hay que pedirle a `reconciliarMeses` para que la ventana llegue
 * hasta `mes`.
 *
 * `serieMensual` cuenta hacia atrás desde HOY, así que un número fijo dejaría los
 * meses de 2031 fuera de la ventana y el test pasaría en verde sin verificar nada
 * (el `find` devolvería undefined y la aserción nunca correría). Se calcula.
 */
function mesesHasta(mes: string): number {
  const hoy = new Date();
  const [y, m] = mes.split('-').map(Number);
  const diff = (hoy.getFullYear() - y!) * 12 + (hoy.getMonth() + 1 - m!);
  if (diff < 0) {
    // Un mes futuro no puede entrar en la ventana. Tirar es la única opción
    // aceptable: devolver un número igual haría que el test pase sin verificar.
    throw new Error(`mesesHasta("${mes}"): el mes está en el futuro, el test no verificaría nada`);
  }
  // +2 para incluir el mes anterior, que es el que aporta el cierre previo.
  return diff + 2;
}
