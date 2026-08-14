import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { q } from '../db';
import { armarAviso, avisar, enmascararToken } from './notificar';
import type { MensajeAviso } from './notificar';
import { calcularBackoff } from '../../scripts/run-ad-rules';
import type { ResultadoCorrida } from './reglas/ejecutor';

// La política de backoff vive en scripts/run-ad-rules.ts como función pura
// (calcularBackoff) y se testea acá sin una cuenta de Meta (§4 del task).

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

function corrida(overrides: Partial<ResultadoCorrida> = {}): ResultadoCorrida {
  return {
    ruleId: 1,
    ruleName: 'Regla de prueba',
    runId: 10,
    corrio: true,
    motivoNoCorrio: null,
    dryRun: false,
    objetosEvaluados: 1,
    objetosQueCumplen: 1,
    ejecutadas: 0,
    simuladas: 0,
    omitidas: 0,
    acciones: [],
    error: null,
    ...overrides,
  };
}

describe('armarAviso (puro)', () => {
  it('devuelve null cuando no hay nada que avisar', () => {
    expect(armarAviso([])).toBeNull();
    expect(armarAviso([corrida({ corrio: false, motivoNoCorrio: 'cooldown' })])).toBeNull();
    // corrio pero ningún objeto cumplió: sin acciones, sin aviso.
    expect(armarAviso([corrida({ objetosQueCumplen: 0, acciones: [] })])).toBeNull();
  });

  it('una acción real ejecutada se avisa con ✅ y no es urgente', () => {
    const m = armarAviso([
      corrida({
        dryRun: false,
        acciones: [{ objectId: 'o1', explicacion: 'Conjunto «X»: se pausó.', ok: true }],
      }),
    ]);
    expect(m).not.toBeNull();
    expect(m!.urgente).toBe(false);
    expect(m!.texto).toContain('✅ Regla de prueba');
    expect(m!.texto).toContain('Conjunto «X»: se pausó.');
    expect(m!.texto).toContain('Panel · reglas ·');
  });

  it('una acción que falló es urgente y va con ⚠️', () => {
    const m = armarAviso([
      corrida({
        dryRun: false,
        acciones: [{ objectId: 'o2', explicacion: 'no se pudo subir el presupuesto.', ok: false }],
      }),
    ]);
    expect(m!.urgente).toBe(true);
    expect(m!.texto).toContain('⚠️ Regla de prueba');
  });

  it('una acción simulada (sombra) se avisa sin emoji y sin urgente', () => {
    const m = armarAviso([
      corrida({
        dryRun: true,
        acciones: [{ objectId: 'o3', explicacion: '[SIMULACIÓN] se habría pausado.', ok: true }],
      }),
    ]);
    expect(m!.urgente).toBe(false);
    expect(m!.texto).toContain('Regla de prueba');
    expect(m!.texto).toContain('[SIMULACIÓN] se habría pausado.');
  });

  it('el encabezado usa el `ahora` que se le pasa (determinístico)', () => {
    const ahora = new Date('2026-08-12T14:32:00');
    const m = armarAviso(
      [corrida({ acciones: [{ objectId: 'o1', explicacion: 'x', ok: true }] })],
      ahora,
    );
    // horaLocal usa la zona del sistema, así que sólo se verifica que empiece
    // con el prefijo fijo y lleve algún "HH:MM" después del separador.
    expect(m!.texto).toMatch(/^Panel · reglas · \d{2}:\d{2}\n/);
  });
});

describe('enmascararToken', () => {
  it('nunca devuelve el token completo', () => {
    const t = '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const m = enmascararToken(t);
    expect(m).not.toContain(t);
    expect(m).toContain(t.slice(-4));
  });
  it('token vacío → string vacío', () => {
    expect(enmascararToken('')).toBe('');
  });
});

describe('calcularBackoff (política de §4)', () => {
  const ahora = new Date('2026-08-12T14:00:00Z');

  it('regainAccessAt frena hasta ese instante, sin discutir', () => {
    const regain = new Date('2026-08-12T15:30:00Z');
    const r = calcularBackoff(
      { peorPorcentaje: 10, regainAccessAt: regain, huboErrorCuota: false, cuentaPeor: 'act_1' },
      { failures: 0, cleanTicks: 0 },
      ahora,
    );
    expect(r.until?.toISOString()).toBe(regain.toISOString());
    expect(r.cleanTicks).toBe(0);
  });

  it('un error de cuota se duplica por reincidencia hasta 60 min', () => {
    const primero = calcularBackoff(
      { peorPorcentaje: 10, regainAccessAt: null, huboErrorCuota: true, cuentaPeor: 'act_1' },
      { failures: 0, cleanTicks: 0 },
      ahora,
    );
    expect(primero.failures).toBe(1);
    expect(primero.until?.getTime()).toBe(ahora.getTime() + 15 * 60_000);

    const tercero = calcularBackoff(
      { peorPorcentaje: 10, regainAccessAt: null, huboErrorCuota: true, cuentaPeor: 'act_1' },
      { failures: 2, cleanTicks: 0 },
      ahora,
    );
    expect(tercero.failures).toBe(3);
    expect(tercero.until?.getTime()).toBe(ahora.getTime() + 60 * 60_000); // min(15*2^3,60)=60
  });

  it('uso ≥ 95% frena 15 min sin tocar failures', () => {
    const r = calcularBackoff(
      { peorPorcentaje: 96, regainAccessAt: null, huboErrorCuota: false, cuentaPeor: 'act_1' },
      { failures: 1, cleanTicks: 0 },
      ahora,
    );
    expect(r.until?.getTime()).toBe(ahora.getTime() + 15 * 60_000);
    expect(r.failures).toBe(1);
  });

  it('uso ≥ 75% hace el frenado corto (intervalo ×5)', () => {
    const r = calcularBackoff(
      { peorPorcentaje: 80, regainAccessAt: null, huboErrorCuota: false, cuentaPeor: 'act_1' },
      { failures: 0, cleanTicks: 0 },
      ahora,
    );
    expect(r.until?.getTime()).toBe(ahora.getTime() + 5 * 60_000);
    expect(r.failures).toBe(0);
  });

  it('dos ticks limpios por debajo del 50% bajan failures', () => {
    const limpio = calcularBackoff(
      { peorPorcentaje: 40, regainAccessAt: null, huboErrorCuota: false, cuentaPeor: null },
      { failures: 2, cleanTicks: 1 },
      ahora,
    );
    expect(limpio.cleanTicks).toBe(0);
    expect(limpio.failures).toBe(1);
    expect(limpio.until).toBeNull();
  });

  it('un tick entre 50 y 74 no cuenta como limpio ni como saturado', () => {
    const r = calcularBackoff(
      { peorPorcentaje: 60, regainAccessAt: null, huboErrorCuota: false, cuentaPeor: null },
      { failures: 0, cleanTicks: 0 },
      ahora,
    );
    expect(r.until).toBeNull();
    expect(r.failures).toBe(0);
    expect(r.cleanTicks).toBe(0);
  });
});

describe.skipIf(!dbAvailable)('avisar (integración)', () => {
  afterAll(async () => {
    await q(`UPDATE settings SET value = 'false'::jsonb WHERE key = 'ads_telegram_enabled'`);
    await q(`UPDATE settings SET value = '""'::jsonb WHERE key = 'ads_telegram_bot_token'`);
    await q(`UPDATE settings SET value = '""'::jsonb WHERE key = 'ads_telegram_chat_id'`);
  });

  it('con ads_telegram_enabled=false devuelve enviado:false SIN llamar a nada', async () => {
    await q(`UPDATE settings SET value = 'false'::jsonb WHERE key = 'ads_telegram_enabled'`);
    const r = await avisar({ texto: 'prueba', urgente: false });
    expect(r).toEqual({ enviado: false, error: null });
  });

  it('con token roto devuelve enviado:false con error, SIN tirar', async () => {
    await q(`UPDATE settings SET value = '"token-roto"'::jsonb WHERE key = 'ads_telegram_bot_token'`);
    await q(`UPDATE settings SET value = '"12345"'::jsonb WHERE key = 'ads_telegram_chat_id'`);
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_telegram_enabled'`);
    const r = await avisar({ texto: 'prueba', urgente: true });
    expect(r.enviado).toBe(false);
    expect(r.error).not.toBeNull();
  });
});
