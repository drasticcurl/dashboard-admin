import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { q, q1 } from '../../../../lib/db';
import { GET, POST } from './route';
import { isAuthenticated } from '../../../../lib/auth';

/**
 * Tests del Endpoint_Vistas (task 16.5): 401 sin cookie en GET y POST sin
 * devolver ninguna Vista, escritura inválida deja el repo intacto, tope de 50
 * Vistas, y marcar por defecto desmarca la anterior en la misma escritura.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('../../../../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true) };
});

const mockAuth = vi.mocked(isAuthenticated);

const CLAVE = 'ads_vistas';

function request(method: 'GET' | 'POST', body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/config/vistas-ads', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function vista(id: string, nombre: string) {
  return {
    id,
    nombre,
    columnas: [
      { clave: 'seleccion', ancho: 48 },
      { clave: 'nombre', ancho: 280 },
      { clave: 'gastos', ancho: 110 },
    ],
    orden: { clave: 'gastos', dir: 'desc' as const },
  };
}

async function repoGuardado(): Promise<unknown> {
  const r = await q1<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [CLAVE]);
  return r?.value ?? null;
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, 'null'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [CLAVE],
  );
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q(`UPDATE settings SET value = 'null'::jsonb WHERE key = $1`, [CLAVE]);
});

describe.skipIf(!dbAvailable)('Endpoint_Vistas (R3 c2, c3, c14, c15, R17 c14)', () => {
  it('GET sin cookie → 401 y no devuelve ninguna Vista ni parte del repo (R3 c2, c14)', async () => {
    mockAuth.mockImplementation(() => false);
    const resp = await GET(request('GET'));
    expect(resp.status).toBe(401);
    const cuerpo = (await resp.json()) as Record<string, unknown>;
    expect(cuerpo.ok).toBe(false);
    expect(cuerpo).not.toHaveProperty('repo');
    expect(JSON.stringify(cuerpo)).not.toContain('vistas');
  });

  it('POST sin cookie → 401 y el repo queda intacto (R17 c14)', async () => {
    mockAuth.mockImplementation(() => false);
    const antes = await repoGuardado();
    const resp = await POST(
      request('POST', { v: 1, vistas: [vista('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'X')], porDefecto: null }),
    );
    expect(resp.status).toBe(401);
    expect(await repoGuardado()).toEqual(antes);
  });

  it('una escritura inválida se rechaza completa y el repo queda como estaba (R3 c15)', async () => {
    mockAuth.mockImplementation(() => true);
    await POST(
      request('POST', { v: 1, vistas: [vista('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'Base')], porDefecto: null }),
    );
    const antes = await repoGuardado();

    const invalidos = [
      // nombre repetido sin distinguir mayúsculas
      { v: 1, vistas: [vista('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'BASE'), vista('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'base')], porDefecto: null },
      // porDefecto que no referencia ninguna Vista
      { v: 1, vistas: [vista('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'Base')], porDefecto: '99999999-9999-4999-8999-999999999999' },
      // ancho fuera del rango
      {
        v: 1,
        vistas: [
          {
            ...vista('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'Base'),
            columnas: [
              { clave: 'seleccion', ancho: 47 },
              { clave: 'nombre', ancho: 280 },
            ],
          },
        ],
        porDefecto: null,
      },
      // 51 Vistas
      {
        v: 1,
        vistas: Array.from({ length: 51 }, (_, i) =>
          vista(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `Vista ${i}`),
        ),
        porDefecto: null,
      },
    ];

    for (const invalido of invalidos) {
      const resp = await POST(request('POST', { repo: invalido }));
      expect(resp.status).toBe(400);
      expect(await repoGuardado()).toEqual(antes);
    }
  });

  it('marcar por defecto desmarca la anterior EN LA MISMA escritura (R3 c7)', async () => {
    mockAuth.mockImplementation(() => true);
    const a = vista('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'A');
    const b = vista('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'B');
    const resp = await POST(request('POST', { repo: { v: 1, vistas: [a, b], porDefecto: b.id } }));
    expect(resp.status).toBe(200);

    const leido = await GET(request('GET'));
    expect(leido.status).toBe(200);
    const cuerpo = (await leido.json()) as { repo: { porDefecto: string | null; vistas: Array<{ id: string }> } };
    expect(cuerpo.repo.porDefecto).toBe(b.id);
    expect(cuerpo.repo.vistas).toHaveLength(2);
    // un solo campo porDefecto: no hay forma de que dos Vistas queden marcadas
  });
});
