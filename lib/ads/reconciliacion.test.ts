import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { q } from '../db';
import { reconciliarDuplicaciones } from './reconciliacion';
import { sincronizarJerarquia } from './jerarquia';

/**
 * Tests de la reconciliación (task 24.3): una fila `indeterminado` de
 * `duplicate` cuyo nombre planificado aparece entre los hermanos se cierra
 * `confirmado` con el id encontrado; si no aparece y pasaron 15 minutos,
 * `fallido`; si el Sync_Jerarquia falla, queda sin resolver y se reintenta.
 *
 * `sincronizarJerarquia` se mockea para que el buscado por nombre ocurra contra
 * la jerarquía local que el test siembra — que es exactamente el mecanismo de
 * la reconciliación real (sync de la cuenta + búsqueda por nombre).
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('./jerarquia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jerarquia')>();
  return { ...actual, sincronizarJerarquia: vi.fn().mockResolvedValue({ cuentas: [], corridaAt: '' }) };
});

const mockSync = vi.mocked(sincronizarJerarquia);

const CUENTA = `REC-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ORIGINAL = '22222222222222222220';
const COPIA = '22222222222222222221';

async function abrirFila(over: Record<string, unknown> = {}): Promise<number> {
  const row = await q<{ id: string }>(
    `INSERT INTO ad_actions
       (source, account_id, level, object_id, object_name, action, before_value, after_value,
        dry_run, ok, estado, explicacion, metrics, created_at)
     VALUES ('manual', $1, 'campaign', $2, 'Original', 'duplicate', $2, $3,
             false, false, 'indeterminado', 'explicación de reconciliación', $4::jsonb, $5::timestamptz)
     RETURNING id`,
    [
      CUENTA,
      ORIGINAL,
      'Original - Copia 1',
      JSON.stringify(over.metrics ?? {}),
      (over.created_at as string) ?? new Date().toISOString(),
    ],
  );
  return Number(row[0]!.id);
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test', 'EUR', true, 'Europe/Lisbon')
     ON CONFLICT (account_id) DO UPDATE SET active = true`,
    [CUENTA],
  );
  await q(
    `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                               budget_level, currency, synced_at)
     VALUES ($1, $2, 'Original', 'ACTIVE', 'ACTIVE', 'campaign', 'EUR', now())
     ON CONFLICT (campaign_id) DO UPDATE SET synced_at = now()`,
    [ORIGINAL, CUENTA],
  );
});

afterEach(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1 AND campaign_id <> $2', [CUENTA, ORIGINAL]);
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
});

describe.skipIf(!dbAvailable)('reconciliarDuplicaciones (R10 c8, R15 c3, R16 c8)', () => {
  it('el nombre planificado que aparece entre los hermanos cierra confirmado con el id encontrado', async () => {
    mockSync.mockResolvedValue({ cuentas: [], corridaAt: '' });
    // la "sincronización" ya trajo la copia: la sembramos acá, como haría el
    // Sync_Jerarquia real
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, currency, synced_at)
       VALUES ($1, $2, 'Original - Copia 1', 'PAUSED', 'PAUSED', 'campaign', 'EUR', now())
       ON CONFLICT (campaign_id) DO UPDATE SET synced_at = now()`,
      [COPIA, CUENTA],
    );
    const id = await abrirFila();

    const r = await reconciliarDuplicaciones(CUENTA, 20);
    expect(r.resueltas).toBe(1);

    const fila = await q<{ estado: string; ok: boolean; metrics: Record<string, unknown> }>(
      `SELECT estado, ok, metrics FROM ad_actions WHERE id = $1`,
      [id],
    );
    expect(fila[0]!.estado).toBe('confirmado');
    expect(fila[0]!.ok).toBe(true);
    const creados = fila[0]!.metrics.creados as unknown[];
    expect(creados).toContain(COPIA);
  });

  it('si no aparece y pasaron 15 minutos → fallido; si está fresco → queda pendiente', async () => {
    mockSync.mockResolvedValue({ cuentas: [], corridaAt: '' });

    const vieja = await abrirFila({
      created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      metrics: { creados: ['120210000000000001'] }, // ids parciales se conservan
    });
    const fresca = await abrirFila();

    const r = await reconciliarDuplicaciones(CUENTA, 20);
    expect(r.pendientes).toBe(1);
    expect(r.resueltas).toBe(1);

    const filaVieja = await q<{ estado: string; metrics: Record<string, unknown> }>(
      `SELECT estado, metrics FROM ad_actions WHERE id = $1`,
      [vieja],
    );
    expect(filaVieja[0]!.estado).toBe('fallido');
    expect(filaVieja[0]!.metrics.creados).toContain('120210000000000001'); // no se pierden
    const filaFresca = await q<{ estado: string }>(
      `SELECT estado FROM ad_actions WHERE id = $1`,
      [fresca],
    );
    expect(filaFresca[0]!.estado).toBe('indeterminado'); // se reintenta
  });

  it('si el Sync_Jerarquia falla, queda sin resolver y se reintenta', async () => {
    mockSync.mockRejectedValue(new Error('Meta no responde'));
    const id = await abrirFila({ created_at: new Date(Date.now() - 30 * 60_000).toISOString() });

    const r = await reconciliarDuplicaciones(CUENTA, 20);
    expect(r.resueltas).toBe(0);
    expect(r.pendientes).toBe(1);
    const fila = await q<{ estado: string }>(
      `SELECT estado FROM ad_actions WHERE id = $1`,
      [id],
    );
    expect(fila[0]!.estado).toBe('indeterminado');
  });
});
