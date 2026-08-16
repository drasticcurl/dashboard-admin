/**
 * Tests de /api/finanzas/movimientos (T02 §5).
 *
 * Mismo patrón que app/api/config/steps/route.test.ts: se mockea lib/auth
 * para simular sesión (default autenticado, false para probar el 401), y el
 * bloque de integración se salta sin DATABASE_URL.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { q } from '@/lib/db';
import { GET, POST, PATCH, DELETE } from './route';

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true) };
});

const { isAuthenticated } = await import('@/lib/auth');
const mockAuth = vi.mocked(isAuthenticated);

const PREFIX = 'test-finanzas-api-';

function jsonReq(url: string, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function rowsMovs(): Promise<number> {
  const r = await q<{ n: number }>('SELECT count(*)::int AS n FROM finance_movements');
  return r[0]!.n;
}

describe.skipIf(!dbAvailable)('/api/finanzas/movimientos', () => {
  afterEach(async () => {
    mockAuth.mockReturnValue(true);
    await q(`DELETE FROM finance_movements WHERE note LIKE '${PREFIX}%'`);
    await q(`DELETE FROM finance_scheduled_payments WHERE name LIKE '${PREFIX}%'`);
  });

  it('1. sin cookie, los 4 métodos devuelven 401 y no tocan la base', async () => {
    mockAuth.mockReturnValue(false);
    const antes = await rowsMovs();

    const getRes = await GET(new NextRequest('http://localhost/api/finanzas/movimientos'));
    expect(getRes.status).toBe(401);

    const postRes = await POST(jsonReq('http://localhost/api/finanzas/movimientos', {
      kind: 'gasto', category: 'otros', amountEur: 10, note: `${PREFIX}401`, day: '2026-08-16',
    }));
    expect(postRes.status).toBe(401);

    const patchRes = await PATCH(jsonReq('http://localhost/api/finanzas/movimientos', { id: 1, amountEur: 10 }));
    expect(patchRes.status).toBe(401);

    const delRes = await DELETE(new NextRequest('http://localhost/api/finanzas/movimientos?id=1'));
    expect(delRes.status).toBe(401);

    expect(await rowsMovs()).toBe(antes);
  });

  it('2. POST de un gasto sin category → 400 con mensaje que menciona "categoría"', async () => {
    const res = await POST(jsonReq('http://localhost/api/finanzas/movimientos', {
      kind: 'gasto', category: null, amountEur: 500, note: `${PREFIX}2`, day: '2026-08-16',
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toContain('categoría');
    expect(body.detail).not.toContain('check_violation');
  });

  it('3. POST de un retiro con amountEur: -50 → 400 (el monto va en absoluto)', async () => {
    const res = await POST(jsonReq('http://localhost/api/finanzas/movimientos', {
      kind: 'retiro', category: null, amountEur: -50, note: `${PREFIX}3`, day: '2026-08-16',
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toContain('positivo');
  });

  it('4. POST de un ajuste con amountEur: 0 → 400 "un ajuste tiene que mover algo"', async () => {
    const res = await POST(jsonReq('http://localhost/api/finanzas/movimientos', {
      kind: 'ajuste', category: null, amountEur: 0, note: `${PREFIX}4`, day: '2026-08-16',
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toBe('un ajuste tiene que mover algo');
  });

  it('5. POST de un gasto válido → 200, con amountEur negativo en la respuesta', async () => {
    const res = await POST(jsonReq('http://localhost/api/finanzas/movimientos', {
      kind: 'gasto', category: 'herramientas', amountEur: 29.99, note: `${PREFIX}5`, day: '2026-08-16',
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; movement: { amountEur: number; note: string } };
    expect(body.ok).toBe(true);
    expect(body.movement.amountEur).toBe(-29.99);
    expect(body.movement.note).toBe(`${PREFIX}5`);
  });

  it('5b. POST de un retiro con category → 400 (la categoría es exclusiva del gasto)', async () => {
    const res = await POST(jsonReq('http://localhost/api/finanzas/movimientos', {
      kind: 'retiro', category: 'otros', amountEur: 100, note: `${PREFIX}5b`, day: '2026-08-16',
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toBe('un retiro o ajuste no lleva categoría');
  });

  it('6. PATCH del monto de un gasto mantiene el signo (el route llama a updateMovement)', async () => {
    const creado = await POST(jsonReq('http://localhost/api/finanzas/movimientos', {
      kind: 'gasto', category: 'sueldos', amountEur: 500, note: `${PREFIX}6`, day: '2026-08-01',
    }));
    const { movement } = (await creado.json()) as { movement: { id: number; amountEur: number } };
    expect(movement.amountEur).toBe(-500);

    const res = await PATCH(jsonReq('http://localhost/api/finanzas/movimientos', {
      id: movement.id, amountEur: 600,
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; movement: { amountEur: number } };
    expect(body.movement.amountEur).toBe(-600);
  });

  it('7. DELETE de un id inexistente → 404', async () => {
    const res = await DELETE(new NextRequest('http://localhost/api/finanzas/movimientos?id=999999999'));
    expect(res.status).toBe(404);
  });

  it('7b. DELETE de un movimiento existente → 200 y desaparece', async () => {
    const creado = await POST(jsonReq('http://localhost/api/finanzas/movimientos', {
      kind: 'retiro', category: null, amountEur: 200, note: `${PREFIX}7b`, day: '2026-08-16',
    }));
    const { movement } = (await creado.json()) as { movement: { id: number } };

    const res = await DELETE(new NextRequest(`http://localhost/api/finanzas/movimientos?id=${movement.id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const filas = await q<{ n: number }>(
      'SELECT count(*)::int AS n FROM finance_movements WHERE id = $1',
      [movement.id],
    );
    expect(filas[0]!.n).toBe(0);
  });

  it('8. GET filtra por kind', async () => {
    await POST(jsonReq('http://localhost/api/finanzas/movimientos', {
      kind: 'ajuste', category: null, amountEur: -20, note: `${PREFIX}8`, day: '2026-08-16',
    }));
    const res = await GET(new NextRequest('http://localhost/api/finanzas/movimientos?kind=ajuste'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { movements: { kind: string }[] };
    expect(body.movements.length).toBeGreaterThanOrEqual(1);
    expect(body.movements.every((m) => m.kind === 'ajuste')).toBe(true);
  });
});