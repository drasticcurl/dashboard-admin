/**
 * Tests de /api/finanzas/saldos y /api/finanzas/cuentas (T03 §6).
 *
 * Lo que más importa acá es que un día PARCIAL se guarde bien y devuelva
 * `totalEur: null`: guardar 3 de 4 cuentas está permitido, lo que no está
 * permitido es que el total mienta.
 *
 * Aislamiento por prefijo en el nombre de la cuenta; el ON DELETE CASCADE se
 * lleva los saldos. Es estricto a propósito: el patrimonio se calcula sobre toda
 * la tabla, así que una cuenta que sobrevive cambia el test siguiente.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { q } from '@/lib/db';
import { GET as GET_SALDOS, POST as POST_SALDOS } from './route';
import {
  DELETE as DELETE_CUENTA,
  GET as GET_CUENTAS,
  PATCH as PATCH_CUENTA,
  POST as POST_CUENTA,
} from '../cuentas/route';

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

const PREFIX = 'test-saldos-api-';
const n = (s: string): string => `${PREFIX}${s}`;
const DIA = '2026-06-20';

function jsonReq(url: string, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function crearCuenta(nombre: string, kind: string): Promise<number> {
  const res = await POST_CUENTA(
    jsonReq('http://x/api/finanzas/cuentas', {
      name: n(nombre),
      kind,
      openedOn: '2026-06-01',
    }),
  );
  const body = (await res.json()) as { ok: boolean; account?: { id: number }; detail?: string };
  if (!body.ok) throw new Error(`no se pudo crear la cuenta: ${body.detail}`);
  return body.account!.id;
}

async function cleanup(): Promise<void> {
  mockAuth.mockReturnValue(true);
  await q(`DELETE FROM finance_accounts WHERE name LIKE $1`, [`${PREFIX}%`]);
}

describe.skipIf(!dbAvailable)('POST /api/finanzas/saldos', () => {
  afterEach(cleanup);

  it('1. guarda todas las cuentas juntas y el día queda completo', async () => {
    const arq = await crearCuenta('arq', 'dinero');
    const meta = await crearCuenta('meta', 'deuda');

    const res = await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: DIA,
        saldos: [
          { accountId: arq, amountEur: 8000 },
          { accountId: meta, amountEur: 1200 },
        ],
      }),
    );
    const body = (await res.json()) as { ok: boolean; patrimonio: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.patrimonio.completo).toBe(true);
    expect(body.patrimonio.totalEur).toBe(6800); // 8000 − 1200
  });

  it('2. guardar 1 de 2 NO es un error, pero el total viene en null', async () => {
    const arq = await crearCuenta('arq', 'dinero');
    await crearCuenta('meta', 'deuda'); // vigente y sin cargar

    const res = await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: DIA,
        saldos: [{ accountId: arq, amountEur: 8000 }],
      }),
    );
    const body = (await res.json()) as {
      ok: boolean;
      patrimonio: { completo: boolean; totalEur: number | null; faltan: string[] };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.patrimonio.completo).toBe(false);
    // 8000 sería un número creíble y equivocado.
    expect(body.patrimonio.totalEur).toBeNull();
    expect(body.patrimonio.faltan).toEqual([n('meta')]);
  });

  it('3. un saldo de CERO se acepta (una cuenta vacía es un dato)', async () => {
    const arq = await crearCuenta('arq', 'dinero');

    const res = await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: DIA,
        saldos: [{ accountId: arq, amountEur: 0 }],
      }),
    );
    const body = (await res.json()) as { ok: boolean; patrimonio: { totalEur: number | null } };

    expect(res.status).toBe(200);
    expect(body.patrimonio.totalEur).toBe(0);
  });

  it('4. amountEur null borra el saldo y el día vuelve a incompleto', async () => {
    const arq = await crearCuenta('arq', 'dinero');

    await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: DIA,
        saldos: [{ accountId: arq, amountEur: 500 }],
      }),
    );
    const res = await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: DIA,
        saldos: [{ accountId: arq, amountEur: null }],
      }),
    );
    const body = (await res.json()) as { patrimonio: { totalEur: number | null; cargadas: number } };

    expect(body.patrimonio.totalEur).toBeNull();
    expect(body.patrimonio.cargadas).toBe(0);
  });

  it('5. un saldo negativo da 400 y el mensaje explica la salida', async () => {
    const arq = await crearCuenta('arq', 'dinero');

    const res = await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: DIA,
        saldos: [{ accountId: arq, amountEur: -500 }],
      }),
    );
    const body = (await res.json()) as { ok: boolean; detail?: string };

    expect(res.status).toBe(400);
    expect(body.detail).toMatch(/nonnegative|mayor|negativ|deuda/i);
  });

  it('6. una cuenta que no estaba vigente ese día da 400', async () => {
    const res0 = await POST_CUENTA(
      jsonReq('http://x/api/finanzas/cuentas', {
        name: n('futura'),
        kind: 'dinero',
        openedOn: '2026-08-10',
      }),
    );
    const { account } = (await res0.json()) as { account: { id: number } };

    const res = await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: DIA,
        saldos: [{ accountId: account.id, amountEur: 100 }],
      }),
    );
    const body = (await res.json()) as { detail?: string };

    expect(res.status).toBe(400);
    expect(body.detail).toMatch(/no estaban vigentes/);
  });

  it('7. GET devuelve el patrimonio de un día puntual', async () => {
    const arq = await crearCuenta('arq', 'dinero');
    await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: DIA,
        saldos: [{ accountId: arq, amountEur: 777 }],
      }),
    );

    const res = await GET_SALDOS(new NextRequest(`http://x/api/finanzas/saldos?day=${DIA}`));
    const body = (await res.json()) as { patrimonio: { totalEur: number | null } };

    expect(res.status).toBe(200);
    expect(body.patrimonio.totalEur).toBe(777);
  });

  it('8. sin auth: 401 en los dos métodos, sin tocar la base', async () => {
    mockAuth.mockReturnValue(false);
    for (const res of [
      await POST_SALDOS(jsonReq('http://x/api/finanzas/saldos', { day: DIA, saldos: [] })),
      await GET_SALDOS(new NextRequest(`http://x/api/finanzas/saldos?day=${DIA}`)),
    ]) {
      expect(res.status).toBe(401);
    }
  });
});

describe.skipIf(!dbAvailable)('/api/finanzas/cuentas', () => {
  afterEach(cleanup);

  it('9. un nombre duplicado en otra capitalización da 400, no 500', async () => {
    await crearCuenta('Mercado Pago', 'dinero');

    const res = await POST_CUENTA(
      jsonReq('http://x/api/finanzas/cuentas', {
        name: `  ${PREFIX}mercado pago `,
        kind: 'dinero',
      }),
    );
    const body = (await res.json()) as { ok: boolean; detail?: string };

    expect(res.status).toBe(400);
    expect(body.detail).toMatch(/ya existe una cuenta con ese nombre/);
  });

  it('10. PATCH con closedOn anterior a openedOn da 400', async () => {
    const id = await crearCuenta('arq', 'dinero'); // openedOn 2026-06-01

    const res = await PATCH_CUENTA(
      jsonReq('http://x/api/finanzas/cuentas', { id, closedOn: '2026-05-01' }, 'PATCH'),
    );
    expect(res.status).toBe(400);
  });

  it('11. PATCH que cambia el kind devuelve cuántos saldos reescribe', async () => {
    const id = await crearCuenta('arq', 'dinero');
    await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: DIA,
        saldos: [{ accountId: id, amountEur: 100 }],
      }),
    );

    const res = await PATCH_CUENTA(
      jsonReq('http://x/api/finanzas/cuentas', { id, kind: 'deuda' }, 'PATCH'),
    );
    const body = (await res.json()) as { ok: boolean; saldosAfectados: number };

    expect(res.status).toBe(200);
    // Cambiar el kind invierte el signo de esa cuenta en TODOS sus días: la UI
    // necesita el número para poder avisar.
    expect(body.saldosAfectados).toBe(1);
  });

  it('12. DELETE devuelve cuántos saldos se llevó en cascada', async () => {
    const id = await crearCuenta('arq', 'dinero');
    await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: DIA,
        saldos: [{ accountId: id, amountEur: 100 }],
      }),
    );
    await POST_SALDOS(
      jsonReq('http://x/api/finanzas/saldos', {
        day: '2026-06-21',
        saldos: [{ accountId: id, amountEur: 200 }],
      }),
    );

    const res = await DELETE_CUENTA(
      new NextRequest(`http://x/api/finanzas/cuentas?id=${id}`, { method: 'DELETE' }),
    );
    const body = (await res.json()) as { ok: boolean; saldosBorrados: number };

    expect(res.status).toBe(200);
    expect(body.saldosBorrados).toBe(2);
  });

  it('13. cerrar y reabrir: closedOn null vuelve a poner la cuenta vigente', async () => {
    const id = await crearCuenta('arq', 'dinero');

    await PATCH_CUENTA(
      jsonReq('http://x/api/finanzas/cuentas', { id, closedOn: '2026-06-30' }, 'PATCH'),
    );
    const cerrada = await PATCH_CUENTA(
      jsonReq('http://x/api/finanzas/cuentas', { id, closedOn: null }, 'PATCH'),
    );
    const body = (await cerrada.json()) as { account: { closedOn: string | null } };

    // `null` reabre y `undefined` no toca: con un COALESCE en SQL las dos cosas
    // serían la misma y reabrir sería imposible.
    expect(body.account.closedOn).toBeNull();
  });

  it('14. GET no trae las cerradas salvo que se pidan', async () => {
    const id = await crearCuenta('arq', 'dinero');
    await PATCH_CUENTA(
      jsonReq('http://x/api/finanzas/cuentas', { id, closedOn: '2026-06-30' }, 'PATCH'),
    );

    const sinCerradas = await GET_CUENTAS(new NextRequest('http://x/api/finanzas/cuentas'));
    const conCerradas = await GET_CUENTAS(
      new NextRequest('http://x/api/finanzas/cuentas?incluirCerradas=1'),
    );

    const a = (await sinCerradas.json()) as { accounts: { id: number }[] };
    const b = (await conCerradas.json()) as { accounts: { id: number }[] };

    expect(a.accounts.some((c) => c.id === id)).toBe(false);
    expect(b.accounts.some((c) => c.id === id)).toBe(true);
  });

  it('15. sin auth: 401 en los cuatro métodos', async () => {
    mockAuth.mockReturnValue(false);
    for (const res of [
      await GET_CUENTAS(new NextRequest('http://x/api/finanzas/cuentas')),
      await POST_CUENTA(jsonReq('http://x/api/finanzas/cuentas', { name: 'x', kind: 'dinero' })),
      await PATCH_CUENTA(jsonReq('http://x/api/finanzas/cuentas', { id: 1 }, 'PATCH')),
      await DELETE_CUENTA(
        new NextRequest('http://x/api/finanzas/cuentas?id=1', { method: 'DELETE' }),
      ),
    ]) {
      expect(res.status).toBe(401);
    }
  });
});
