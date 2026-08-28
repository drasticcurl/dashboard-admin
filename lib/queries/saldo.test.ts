/**
 * Tests de Saldo por cuentas — lib/queries/saldo.ts (T01, sección 4).
 *
 * Corre contra Postgres real: el signo por tipo de cuenta, el CHECK de
 * no-negativo y la completitud de un día son garantías de la BASE y de SQL, no
 * de código que se pueda mockear. Sin DATABASE_URL se salta, igual que el resto
 * de los tests de integración.
 *
 * Aislamiento: las cuentas de prueba llevan el nombre con prefijo
 * 'test-saldo-' y los movimientos la nota con el mismo prefijo; el cleanup
 * borra por ese prefijo (y el ON DELETE CASCADE se lleva los saldos). Hace
 * falta ser estricto acá porque `serieMensual` y el "último día completo" leen
 * TODA la tabla, no un rango: una fila que sobrevive de un test anterior
 * cambia el resultado del siguiente.
 *
 * Las fechas son de junio y julio de 2026 a propósito: las 4 cuentas que
 * siembra la migración tienen `opened_on = CURRENT_DATE`, así que no están
 * vigentes en esos días y no ensucian ningún conteo de "esperadas".
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { q } from '../db';
import {
  SaldoInputError,
  createAccount,
  getSaldoOverview,
  guardarSaldosDelDia,
  patrimonioDe,
  serieDiaria,
  serieMensual,
  signoDe,
  updateAccount,
  type AccountKind,
} from './saldo';

// vitest no carga .env solo: sin esto la suite se saltea en silencio en vez de
// correr contra la base real.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

const PREFIX = 'test-saldo-';
const n = (s: string): string => `${PREFIX}${s}`;

async function cuenta(
  nombre: string,
  kind: AccountKind,
  openedOn = '2026-06-01',
): Promise<number> {
  const a = await createAccount({ name: n(nombre), kind, openedOn });
  return a.id;
}

async function cleanup(): Promise<void> {
  // El CASCADE de finance_account_balances se lleva los saldos solo.
  await q(`DELETE FROM finance_accounts WHERE name LIKE $1`, [`${PREFIX}%`]);
  await q(`DELETE FROM finance_movements WHERE note LIKE $1`, [`${PREFIX}%`]);
}

describe.skipIf(!dbAvailable)('patrimonioDe — el signo lo pone el tipo de cuenta', () => {
  afterEach(cleanup);

  it('1. un día completo suma dinero + retenido − deuda', async () => {
    const arq = await cuenta('arq', 'dinero');
    const mp = await cuenta('mp', 'dinero');
    const ret = await cuenta('retenido', 'retenido');
    const meta = await cuenta('meta', 'deuda');

    const pat = await guardarSaldosDelDia('2026-06-30', [
      { accountId: arq, amountEur: 8000 },
      { accountId: mp, amountEur: 1500 },
      { accountId: ret, amountEur: 700 },
      // Se tipea POSITIVO ("debemos 1200") y entra al patrimonio como −1200.
      { accountId: meta, amountEur: 1200 },
    ]);

    expect(pat.totalEur).toBe(9000); // 8000 + 1500 + 700 − 1200
    expect(pat.dineroEur).toBe(9500);
    expect(pat.retenidoEur).toBe(700);
    expect(pat.deudaEur).toBe(1200); // POSITIVO en el desglose (§4 regla 6)
    expect(pat.completo).toBe(true);
    expect(pat.esperadas).toBe(4);
    expect(pat.cargadas).toBe(4);
    expect(pat.faltan).toEqual([]);
  });

  it('2. un día al que le falta UNA cuenta devuelve totalEur null, no un parcial', async () => {
    const arq = await cuenta('arq', 'dinero');
    const mp = await cuenta('mp', 'dinero');
    await cuenta('meta', 'deuda'); // vigente y SIN cargar

    const pat = await guardarSaldosDelDia('2026-06-30', [
      { accountId: arq, amountEur: 8000 },
      { accountId: mp, amountEur: 1500 },
    ]);

    // Es EL test del módulo: 9500 sería un número creíble y equivocado.
    expect(pat.totalEur).toBeNull();
    expect(pat.completo).toBe(false);
    expect(pat.esperadas).toBe(3);
    expect(pat.cargadas).toBe(2);
    expect(pat.faltan).toEqual([n('meta')]);
  });

  it('3. un saldo de CERO es válido y deja el día completo', async () => {
    const arq = await cuenta('arq', 'dinero');
    const mp = await cuenta('mp', 'dinero');

    const pat = await guardarSaldosDelDia('2026-06-30', [
      { accountId: arq, amountEur: 0 },
      { accountId: mp, amountEur: 500 },
    ]);

    // Un patrimonio de 500 con una cuenta vacía NO es lo mismo que un día
    // incompleto, y la diferencia tiene que poder decirse.
    expect(pat.totalEur).toBe(500);
    expect(pat.completo).toBe(true);
    expect(pat.faltan).toEqual([]);
  });
});

describe.skipIf(!dbAvailable)('la vigencia de una cuenta (D6)', () => {
  afterEach(cleanup);

  it('4. abrir una cuenta nueva NO cambia el patrimonio de los días anteriores', async () => {
    const arq = await cuenta('arq', 'dinero');
    const meta = await cuenta('meta', 'deuda');

    await guardarSaldosDelDia('2026-06-30', [
      { accountId: arq, amountEur: 5000 },
      { accountId: meta, amountEur: 500 },
    ]);
    const antes = await patrimonioDe('2026-06-30');
    expect(antes.totalEur).toBe(4500);

    // Una cuenta que se abre DESPUÉS. Sin opened_on en la aritmética, esto
    // dejaría el 2026-06-30 con 3 esperadas y 2 cargadas → null, y el gráfico
    // entero desaparecería al crear una cuenta.
    await cuenta('nueva', 'dinero', '2026-08-10');

    const despues = await patrimonioDe('2026-06-30');
    expect(despues.totalEur).toBe(4500);
    expect(despues.esperadas).toBe(2);
    expect(despues.completo).toBe(true);
  });

  it('5. una cuenta cerrada deja de pedirse el día siguiente y conserva su historial', async () => {
    const arq = await cuenta('arq', 'dinero');
    const vieja = await cuenta('vieja', 'dinero');

    await guardarSaldosDelDia('2026-06-30', [
      { accountId: arq, amountEur: 1000 },
      { accountId: vieja, amountEur: 300 },
    ]);
    await updateAccount(vieja, { closedOn: '2026-06-30' });

    // El día del cierre TODAVÍA se le pide, y su saldo sigue estando.
    const elDia = await patrimonioDe('2026-06-30');
    expect(elDia.esperadas).toBe(2);
    expect(elDia.totalEur).toBe(1300);

    // Al día siguiente ya no.
    await guardarSaldosDelDia('2026-07-01', [{ accountId: arq, amountEur: 1100 }]);
    const siguiente = await patrimonioDe('2026-07-01');
    expect(siguiente.esperadas).toBe(1);
    expect(siguiente.completo).toBe(true);
    expect(siguiente.totalEur).toBe(1100);
  });
});

describe.skipIf(!dbAvailable)('serieMensual — la ganancia (D7, D8)', () => {
  afterEach(cleanup);

  it('6. la ganancia descuenta los retiros Y los aportes', async () => {
    const arq = await cuenta('arq', 'dinero');
    const meta = await cuenta('meta', 'deuda');

    // Cierre de junio: 10000 − 1000 = 9000
    await guardarSaldosDelDia('2026-06-30', [
      { accountId: arq, amountEur: 10000 },
      { accountId: meta, amountEur: 1000 },
    ]);
    // Cierre de julio: 13000 − 500 = 12500  →  Δ = 3500
    await guardarSaldosDelDia('2026-07-31', [
      { accountId: arq, amountEur: 13000 },
      { accountId: meta, amountEur: 500 },
    ]);

    await q(
      `INSERT INTO finance_movements (kind, category, amount_eur, note, day) VALUES
         ('retiro', NULL,  -200.00, $1, '2026-07-15'),
         ('aporte', NULL,  3000.00, $2, '2026-07-20')`,
      [n('retiro-julio'), n('aporte-julio')],
    );

    const serie = await serieMensual(12);
    const julio = serie.find((p) => p.month === '2026-07');
    const junio = serie.find((p) => p.month === '2026-06');

    expect(junio?.cierreEur).toBe(9000);
    expect(julio?.cierreEur).toBe(12500);
    expect(julio?.diaCierre).toBe('2026-07-31');
    expect(julio?.retirosEur).toBe(-200);
    expect(julio?.aportesEur).toBe(3000);

    // 3500 − (−200) − 3000 = 700. Sin el término de aportes daría 3700: el
    // gráfico diría que el negocio ganó cinco veces más de lo que ganó, justo
    // el mes en que el usuario metió plata de su bolsillo.
    expect(julio?.gananciaEur).toBe(700);
  });

  it('7. el mes más viejo con datos no tiene ganancia: sin cierre anterior no hay delta', async () => {
    const arq = await cuenta('arq', 'dinero');
    await guardarSaldosDelDia('2026-06-30', [{ accountId: arq, amountEur: 9000 }]);

    const serie = await serieMensual(12);
    const junio = serie.find((p) => p.month === '2026-06');

    expect(junio?.cierreEur).toBe(9000);
    // Tratar el saldo inicial como ganancia inventaría un +9000 que nunca se ganó.
    expect(junio?.gananciaEur).toBeNull();
  });

  it('8. el cierre es el último día COMPLETO del mes, no el último con datos', async () => {
    const arq = await cuenta('arq', 'dinero');
    const meta = await cuenta('meta', 'deuda');

    // El 25 está completo: 8000 − 1000 = 7000
    await guardarSaldosDelDia('2026-07-25', [
      { accountId: arq, amountEur: 8000 },
      { accountId: meta, amountEur: 1000 },
    ]);
    // El 28 es más nuevo pero le falta la deuda → incompleto.
    await guardarSaldosDelDia('2026-07-28', [{ accountId: arq, amountEur: 9999 }]);

    const serie = await serieMensual(12);
    const julio = serie.find((p) => p.month === '2026-07');

    expect(julio?.diaCierre).toBe('2026-07-25');
    expect(julio?.cierreEur).toBe(7000);
  });

  it('9. la serie es continua: devuelve los 12 meses pedidos', async () => {
    const serie = await serieMensual(12);
    expect(serie.length).toBe(12);
    // Y ordenados de más viejo a más nuevo.
    expect(serie[0]!.month < serie[11]!.month).toBe(true);
  });
});

describe.skipIf(!dbAvailable)('serieDiaria', () => {
  afterEach(cleanup);

  it('10. un mes sin ninguna carga devuelve todos sus días en null, no un array vacío', async () => {
    const serie = await serieDiaria('2026-06');
    expect(serie.length).toBe(30); // junio tiene 30 días
    expect(serie.every((p) => p.totalEur === null)).toBe(true);
    expect(serie[0]!.day).toBe('2026-06-01');
    expect(serie[29]!.day).toBe('2026-06-30');
  });

  it('11. los días cargados traen su total y los demás quedan en null', async () => {
    const arq = await cuenta('arq', 'dinero');
    await guardarSaldosDelDia('2026-06-10', [{ accountId: arq, amountEur: 4000 }]);

    const serie = await serieDiaria('2026-06');
    const conDato = serie.filter((p) => p.totalEur !== null);

    expect(conDato.length).toBe(1);
    expect(conDato[0]!.day).toBe('2026-06-10');
    expect(conDato[0]!.totalEur).toBe(4000);
    // Nunca 0: un patrimonio de 0 es un dato real y taparlo con 0 lo vuelve
    // indistinguible de "no cargué" (D12).
    expect(serie.find((p) => p.day === '2026-06-11')?.totalEur).toBeNull();
  });

  it('12. un mes mal escrito se rechaza con SaldoInputError', async () => {
    await expect(serieDiaria('2026-6')).rejects.toThrow(SaldoInputError);
  });
});

describe.skipIf(!dbAvailable)('guardarSaldosDelDia', () => {
  afterEach(cleanup);

  it('13. amountEur null BORRA el saldo y el día vuelve a estar incompleto', async () => {
    const arq = await cuenta('arq', 'dinero');
    const mp = await cuenta('mp', 'dinero');

    const lleno = await guardarSaldosDelDia('2026-06-30', [
      { accountId: arq, amountEur: 1000 },
      { accountId: mp, amountEur: 200 },
    ]);
    expect(lleno.totalEur).toBe(1200);

    const vacio = await guardarSaldosDelDia('2026-06-30', [{ accountId: mp, amountEur: null }]);
    expect(vacio.totalEur).toBeNull();
    expect(vacio.cargadas).toBe(1);
    expect(vacio.faltan).toEqual([n('mp')]);
  });

  it('14. cargar dos veces el mismo día es un UPDATE: gana el último', async () => {
    const arq = await cuenta('arq', 'dinero');

    await guardarSaldosDelDia('2026-06-30', [{ accountId: arq, amountEur: 111 }]);
    const segundo = await guardarSaldosDelDia('2026-06-30', [{ accountId: arq, amountEur: 12345 }]);

    expect(segundo.totalEur).toBe(12345);
    const filas = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM finance_account_balances WHERE account_id = $1`,
      [arq],
    );
    expect(Number(filas[0]!.n)).toBe(1);
  });

  it('15. un saldo negativo se rechaza con el mensaje de la cuenta de deuda', async () => {
    const arq = await cuenta('arq', 'dinero');
    await expect(
      guardarSaldosDelDia('2026-06-30', [{ accountId: arq, amountEur: -500 }]),
    ).rejects.toThrow(/tipo deuda/);
  });

  it('16. una cuenta que no estaba vigente ese día se rechaza', async () => {
    const nueva = await cuenta('nueva', 'dinero', '2026-08-10');
    await expect(
      guardarSaldosDelDia('2026-06-30', [{ accountId: nueva, amountEur: 100 }]),
    ).rejects.toThrow(/no estaban vigentes/);
  });

  it('17. una cuenta repetida en el mismo pedido se rechaza', async () => {
    const arq = await cuenta('arq', 'dinero');
    await expect(
      guardarSaldosDelDia('2026-06-30', [
        { accountId: arq, amountEur: 100 },
        { accountId: arq, amountEur: 200 },
      ]),
    ).rejects.toThrow(/repetida/);
  });
});

describe.skipIf(!dbAvailable)('getSaldoOverview', () => {
  afterEach(cleanup);

  it('18. `ultimo` es el último día COMPLETO, aunque haya uno más nuevo incompleto', async () => {
    const arq = await cuenta('arq', 'dinero');
    const mp = await cuenta('mp', 'dinero');

    await guardarSaldosDelDia('2026-06-20', [
      { accountId: arq, amountEur: 1000 },
      { accountId: mp, amountEur: 500 },
    ]);
    await guardarSaldosDelDia('2026-06-25', [{ accountId: arq, amountEur: 9999 }]);

    const ov = await getSaldoOverview();
    expect(ov.ultimo?.day).toBe('2026-06-20');
    expect(ov.ultimo?.totalEur).toBe(1500);
  });

  it('19. hoyStr es una fecha ISO y `hoy` reporta qué cuentas faltan cargar', async () => {
    // Cuenta propia con openedOn viejo, y NO las 4 del seed: el seed usa
    // `DEFAULT CURRENT_DATE` (la fecha del server de Postgres) y `hoy` sale de
    // DASHBOARD_TZ. En producción el server está en Europe/Berlin y el panel en
    // Buenos Aires, 5 horas atrás: entre las 00:00 y las 05:00 de Berlín el seed
    // queda con opened_on = mañana y las cuentas no están vigentes todavía.
    await cuenta('vigente-siempre', 'dinero', '2026-01-01');

    const ov = await getSaldoOverview();
    expect(ov.hoyStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ov.hoy.completo).toBe(false);
    expect(ov.hoy.faltan).toContain(n('vigente-siempre'));
    expect(ov.hoy.totalEur).toBeNull();
  });
});

describe('signoDe (pura, sin base)', () => {
  it('20. la deuda entra negativa; dinero y retenido, positivos', () => {
    expect(signoDe('deuda', 500)).toBe(-500);
    expect(signoDe('dinero', 500)).toBe(500);
    expect(signoDe('retenido', 500)).toBe(500);
  });

  it('21. el valor absoluto se respeta: nunca devuelve un signo que dependa de la entrada', () => {
    // La entrada siempre es >= 0 (lo garantiza el CHECK), pero si alguien pasa
    // un negativo el resultado tiene que seguir dependiendo SOLO del kind.
    expect(signoDe('deuda', -500)).toBe(-500);
    expect(signoDe('dinero', -500)).toBe(500);
  });
});
