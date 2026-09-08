/**
 * Tests de /api/finanzas/pagos-programados y /ejecutar-ahora (T02 §5).
 *
 * La idempotencia del "Ejecutar ahora" es la prueba más importante del
 * módulo: correrlo dos veces el mismo día para el mismo mes genera el gasto
 * UNA sola vez.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { q } from '@/lib/db';
import { GET, POST, PATCH, DELETE } from './route';
import { POST as POST_EJECUTAR } from './ejecutar-ahora/route';

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

// `guard()` (app/api/config/_lib.ts) delega en `guardSeccion` de lib/permisos
// (T03), que ya no lee `isAuthenticated`: consulta la base a través de una
// sesión real. Este test es anterior a ese módulo y sólo necesita "hay
// sesión" / "no hay sesión", así que el mock de `guardSeccion` se ata al
// mismo `isAuthenticated` de arriba en vez de vivir desincronizado: cuando el
// test hace `mockAuth.mockReturnValue(false)` para probar el 401, este mock
// tiene que devolver lo mismo, o el 401 esperado nunca se ve.
vi.mock('@/lib/permisos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/permisos')>();
  return {
    ...actual,
    guardSeccion: vi.fn(async () => {
      if (!isAuthenticated({ get: () => undefined })) {
        return {
          respuesta: (await import('next/server')).NextResponse.json(
            { ok: false, error: 'unauthorized' },
            { status: 401 },
          ),
        };
      }
      return {
        sesion: {
          usuarioId: 1,
          usuario: 'test',
          nombre: 'Test',
          esAdmin: true,
          debeCambiarClave: false,
          secciones: actual.SECCIONES,
          esFallback: false,
        },
      };
    }),
  };
});

const PREFIX = 'test-finanzas-api-';

function jsonReq(url: string, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function countPagos(): Promise<number> {
  const r = await q<{ n: number }>('SELECT count(*)::int AS n FROM finance_scheduled_payments');
  return r[0]!.n;
}

describe.skipIf(!dbAvailable)('/api/finanzas/pagos-programados', () => {
  afterEach(async () => {
    mockAuth.mockReturnValue(true);
    // Los runs se van con el pago (ON DELETE CASCADE); los movimientos que
    // generó quedan con scheduled_payment_id NULL (D9) y se borran por note.
    await q(`DELETE FROM finance_scheduled_payments WHERE name LIKE '${PREFIX}%'`);
    await q(`DELETE FROM finance_movements WHERE note LIKE '${PREFIX}%'`);
  });

  it('1. sin cookie, los métodos devuelven 401 (incluido ejecutar-ahora)', async () => {
    mockAuth.mockReturnValue(false);
    const antes = await countPagos();

    expect((await GET(new NextRequest('http://localhost/api/finanzas/pagos-programados'))).status).toBe(401);
    expect(
      (await POST(jsonReq('http://localhost/api/finanzas/pagos-programados', {
        name: `${PREFIX}x`, category: 'otros', amountEur: 10, dayOfMonth: 5,
      }))).status,
    ).toBe(401);
    expect(
      (await PATCH(jsonReq('http://localhost/api/finanzas/pagos-programados', { id: 1, active: false }))).status,
    ).toBe(401);
    expect(
      (await DELETE(new NextRequest('http://localhost/api/finanzas/pagos-programados?id=1'))).status,
    ).toBe(401);
    expect(
      (await POST_EJECUTAR(new NextRequest('http://localhost/api/finanzas/pagos-programados/ejecutar-ahora'))).status,
    ).toBe(401);

    expect(await countPagos()).toBe(antes);
  });

  it('2. POST válido → 200 con el pago creado', async () => {
    const res = await POST(jsonReq('http://localhost/api/finanzas/pagos-programados', {
      name: `${PREFIX}alquiler`, category: 'alquiler', amountEur: 400, dayOfMonth: 5,
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; scheduledPayment: { name: string; amountEur: number } };
    expect(body.ok).toBe(true);
    expect(body.scheduledPayment.amountEur).toBe(400);
  });

  it('3. POST con dayOfMonth 31 → 400 (zod min/max + CHECK como red de seguridad)', async () => {
    const res = await POST(jsonReq('http://localhost/api/finanzas/pagos-programados', {
      name: `${PREFIX}31`, category: 'otros', amountEur: 10, dayOfMonth: 31,
    }));
    expect(res.status).toBe(400);
  });

  it('4. PATCH activa/desactiva un pago', async () => {
    const creado = await POST(jsonReq('http://localhost/api/finanzas/pagos-programados', {
      name: `${PREFIX}pausa`, category: 'otros', amountEur: 15, dayOfMonth: 1,
    }));
    const { scheduledPayment } = (await creado.json()) as { scheduledPayment: { id: number; active: boolean } };
    expect(scheduledPayment.active).toBe(true);

    const res = await PATCH(jsonReq('http://localhost/api/finanzas/pagos-programados', {
      id: scheduledPayment.id, active: false,
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scheduledPayment: { active: boolean } };
    expect(body.scheduledPayment.active).toBe(false);
  });

  it('5. DELETE de un id inexistente → 404', async () => {
    const res = await DELETE(new NextRequest('http://localhost/api/finanzas/pagos-programados?id=999999999'));
    expect(res.status).toBe(404);
  });

  it('6. POST /ejecutar-ahora genera el gasto del atrasado UNA vez (idempotente)', async () => {
    // day_of_month = 1: siempre pasado el día 1 de cualquier mes → atrasado.
    const creado = await POST(jsonReq('http://localhost/api/finanzas/pagos-programados', {
      name: `${PREFIX}hosting`, category: 'herramientas', amountEur: 50, dayOfMonth: 1,
    }));
    const { scheduledPayment } = (await creado.json()) as { scheduledPayment: { id: number } };

    const primera = await POST_EJECUTAR(new NextRequest('http://localhost/api/finanzas/pagos-programados/ejecutar-ahora'));
    expect(primera.status).toBe(200);
    const body1 = (await primera.json()) as { ok: boolean; ejecutados: string[] };
    expect(body1.ok).toBe(true);
    expect(body1.ejecutados).toContain(`${PREFIX}hosting`);

    const segunda = await POST_EJECUTAR(new NextRequest('http://localhost/api/finanzas/pagos-programados/ejecutar-ahora'));
    const body2 = (await segunda.json()) as { ejecutados: string[] };
    expect(body2.ejecutados).not.toContain(`${PREFIX}hosting`);
    expect(body2.ejecutados).toHaveLength(0);

    const filas = await q<{ n: string }>(
      'SELECT count(*)::text AS n FROM finance_movements WHERE scheduled_payment_id = $1',
      [scheduledPayment.id],
    );
    expect(filas[0]!.n).toBe('1');
  });

  it('7. un pago que falla se REPORTA y no bloquea a los demás', async () => {
    // Antes había un `catch {}` vacío: el gasto no se generaba, el pago seguía
    // atrasado y la respuesta era idéntica a "no había nada que hacer", así que
    // la pantalla mostraba un cartel verde. Un gasto que falta en el patrimonio
    // y nadie ve es el peor resultado posible de este módulo.
    await POST(jsonReq('http://localhost/api/finanzas/pagos-programados', {
      name: `${PREFIX}anda`, category: 'herramientas', amountEur: 50, dayOfMonth: 1,
    }));
    await POST(jsonReq('http://localhost/api/finanzas/pagos-programados', {
      name: `${PREFIX}roto`, category: 'sueldos', amountEur: 90, dayOfMonth: 1,
    }));

    // Una falla a nivel base que sólo alcanza al segundo pago.
    await q(`ALTER TABLE finance_movements ADD CONSTRAINT tmp_falla_pago CHECK (note NOT LIKE '%roto%')`);
    try {
      const res = await POST_EJECUTAR(new NextRequest('http://localhost/api/finanzas/pagos-programados/ejecutar-ahora'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ejecutados: string[];
        fallidos: { name: string; error: string }[];
      };

      expect(body.ejecutados).toContain(`${PREFIX}anda`);
      expect(body.fallidos.map((f) => f.name)).toContain(`${PREFIX}roto`);
      expect(body.fallidos.find((f) => f.name === `${PREFIX}roto`)!.error.length).toBeGreaterThan(0);
    } finally {
      await q('ALTER TABLE finance_movements DROP CONSTRAINT tmp_falla_pago');
    }
  });
});