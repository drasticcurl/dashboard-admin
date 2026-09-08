import { describe, expect, it, vi } from 'vitest';
import { POST } from './route';

/**
 * Los mensajes del esquema cerrado del Endpoint_Acciones (task 3.3 de
 * frescura-y-acciones-anuncios, R1 c6).
 *
 * Vive en un archivo aparte de `route.test.ts` a propósito: el rechazo del
 * esquema ocurre ANTES del preflight, así que no necesita Postgres ni siembra.
 * Que estos casos corran sin base es parte de lo que verifican — `lib/db` está
 * mockeado para que tirar, y un mensaje de validación que llegara a consultar la
 * base rompería el test en lugar de pasar en silencio.
 *
 * Lo que se fija es el contrato de `detail`: un string que nombra el campo y la
 * regla incumplida. Es el texto que el cliente muestra tal cual (regla 5 de
 * `lib/ads/mensajes.ts`), y antes de esta task era el `Required` de zod.
 */

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true), getClientIp: () => 'test-ip' };
});

// `guard()` (app/api/config/_lib.ts) delega en `guardSeccion` de lib/permisos
// (T03), que ya no lee `isAuthenticated`: consulta la base a través de una
// sesión real. Este test es anterior a ese módulo y no ejercita el 401 (sólo
// necesita "hay sesión" para llegar al esquema), así que el mock siempre
// deja pasar con una sesión admin.
vi.mock('@/lib/permisos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/permisos')>();
  return {
    ...actual,
    guardSeccion: vi.fn(async () => ({
      sesion: {
        usuarioId: 1,
        usuario: 'test',
        nombre: 'Test',
        esAdmin: true,
        debeCambiarClave: false,
        secciones: actual.SECCIONES,
        esFallback: false,
      },
    })),
  };
});

const CUENTA = 'act_1234567890';
const CONJUNTO = '23851234567890123';

async function rechazo(body: unknown): Promise<{ status: number; error?: string; detail?: string }> {
  const res = await POST(
    new Request('http://localhost/api/ads/acciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }) as never,
  );
  const cuerpo = (await res.json()) as { ok: boolean; error?: string; detail?: string };
  expect(cuerpo.ok).toBe(false);
  return { status: res.status, error: cuerpo.error, detail: cuerpo.detail };
}

const presupuesto = (over: Record<string, unknown>): Record<string, unknown> => ({
  level: 'adset',
  accountId: CUENTA,
  action: 'budget_set',
  objectIds: [CONJUNTO],
  ...over,
});

describe('el schema de budget_set nombra el campo y la regla (R1 c6)', () => {
  it('sin budgetEur: el detail nombra el campo que falta y no es el "Required" de zod', async () => {
    // El pedido exacto que producía el bug reportado: `JSON.stringify` borra las
    // claves con `undefined`, así que el importe no viajaba.
    const r = await rechazo(presupuesto({ budgetEur: undefined }));
    expect(r.status).toBe(400);
    expect(r.error).toBe('invalid_payload'); // el contrato de la respuesta no cambia
    expect(r.detail).toBe('budgetEur: falta el importe del presupuesto diario en euros');
  });

  it('con tres decimales: el detail nombra la regla de los dos decimales', async () => {
    const r = await rechazo(presupuesto({ budgetEur: 10.999 }));
    expect(r.detail).toBe(
      'budgetEur: el importe del presupuesto diario admite como máximo dos decimales',
    );
  });

  it('cero y negativo: el detail nombra la regla del importe positivo', async () => {
    for (const budgetEur of [0, -5]) {
      const r = await rechazo(presupuesto({ budgetEur }));
      expect(r.detail, `budgetEur ${budgetEur}`).toBe(
        'budgetEur: el importe del presupuesto diario tiene que ser mayor que cero',
      );
    }
  });

  it('un texto en lugar de un número: el detail nombra el tipo esperado', async () => {
    const r = await rechazo(presupuesto({ budgetEur: '10,50' }));
    expect(r.detail).toBe(
      'budgetEur: el importe del presupuesto diario tiene que ser un número en euros',
    );
  });
});

describe('el schema nombra el campo y la regla en las otras ramas (R1 c6)', () => {
  it('un lote de 101 objetos nombra objectIds y el tope de 100', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i).padStart(20, '0'));
    const r = await rechazo({
      level: 'campaign',
      accountId: CUENTA,
      action: 'pause',
      objectIds: ids,
    });
    expect(r.detail).toBe('objectIds: el lote admite como máximo 100 objetos por corrida');
  });

  it('un id que no es de Meta nombra su posición en la lista', async () => {
    const r = await rechazo({
      level: 'campaign',
      accountId: CUENTA,
      action: 'pause',
      objectIds: ['11111111111111111111', 'abc'],
    });
    expect(r.detail).toBe(
      'objectIds.1: cada id de objeto tiene que ser una secuencia de 1 a 20 dígitos',
    );
  });

  it('sin cuenta: el detail nombra la cuenta de anuncios', async () => {
    const r = await rechazo({
      level: 'campaign',
      accountId: '',
      action: 'pause',
      objectIds: [CONJUNTO],
    });
    expect(r.detail).toBe('accountId: falta la cuenta de anuncios');
  });

  it('una acción fuera del vocabulario nombra action y enumera las aceptadas', async () => {
    const r = await rechazo({
      level: 'campaign',
      accountId: CUENTA,
      action: 'archive',
      objectIds: [CONJUNTO],
    });
    expect(r.detail).toContain('action: ');
    expect(r.detail).toContain('budget_set'); // la lista de acciones aceptadas
    expect(r.detail).not.toContain('discriminator');
  });

  it('un campo no declarado se nombra en castellano', async () => {
    const r = await rechazo({
      level: 'campaign',
      accountId: CUENTA,
      action: 'pause',
      objectIds: [CONJUNTO],
      forzar: true,
    });
    expect(r.detail).toBe('el pedido trae campos que el endpoint no acepta: forzar');
  });

  it('un cuerpo que no es JSON no muestra el default de zod', async () => {
    const r = await rechazo('esto no es json');
    expect(r.status).toBe(400);
    expect(r.detail).toBe('el cuerpo del pedido tiene que ser un objeto JSON');
  });

  it('un inicio sin zona horaria nombra inicio y la regla del offset', async () => {
    const r = await rechazo({
      level: 'adset',
      accountId: CUENTA,
      action: 'schedule',
      objectIds: [CONJUNTO],
      inicio: '2025-03-01T09:00:00',
    });
    expect(r.detail).toContain('inicio: ');
    expect(r.detail).toContain('zona horaria');
  });

  it('un nombre de sólo espacios nombra el nombre: la cota corre DESPUÉS del recorte', async () => {
    const r = await rechazo({
      level: 'adset',
      accountId: CUENTA,
      action: 'rename',
      objectIds: [CONJUNTO],
      modo: { tipo: 'exacto', nombre: '   ' },
    });
    expect(r.detail).toBe('modo.nombre: el nombre es obligatorio');
  });

  it('con más de una regla incumplida se informa cuántas quedan', async () => {
    const r = await rechazo(presupuesto({ budgetEur: 10.999, objectIds: [] }));
    expect(r.detail).toMatch(/\(y 1 regla más sin cumplir\)$/);
  });
});

describe('ningún rechazo del esquema vuelve al default de la librería', () => {
  const invalidos: Array<[string, unknown]> = [
    ['sin budgetEur', presupuesto({})],
    ['budgetEur nulo', presupuesto({ budgetEur: null })],
    ['budgetEur NaN', presupuesto({ budgetEur: Number.NaN })],
    ['budgetEur infinito', presupuesto({ budgetEur: Number.POSITIVE_INFINITY })],
    ['sin nivel', { accountId: CUENTA, action: 'pause', objectIds: [CONJUNTO] }],
    ['nivel inventado', { level: 'cuenta', accountId: CUENTA, action: 'pause', objectIds: [CONJUNTO] }],
    ['sin objectIds', { level: 'campaign', accountId: CUENTA, action: 'pause' }],
    ['objectIds vacío', { level: 'campaign', accountId: CUENTA, action: 'pause', objectIds: [] }],
    ['sin action', { level: 'campaign', accountId: CUENTA, objectIds: [CONJUNTO] }],
    ['cuerpo nulo', null],
    ['cuerpo lista', [1, 2, 3]],
    [
      'duplicar un anuncio',
      { level: 'ad', accountId: CUENTA, action: 'duplicate', objectIds: [CONJUNTO], copias: 1 },
    ],
    [
      'seis copias',
      { level: 'campaign', accountId: CUENTA, action: 'duplicate', objectIds: [CONJUNTO], copias: 6 },
    ],
    [
      'programar una campaña',
      {
        level: 'campaign',
        accountId: CUENTA,
        action: 'schedule',
        objectIds: [CONJUNTO],
        inicio: '2030-01-01T09:00:00+01:00',
      },
    ],
    [
      'renombre con modo inventado',
      {
        level: 'adset',
        accountId: CUENTA,
        action: 'rename',
        objectIds: [CONJUNTO],
        modo: { tipo: 'mayusculas' },
      },
    ],
    [
      'prefijo vacío',
      {
        level: 'adset',
        accountId: CUENTA,
        action: 'rename',
        objectIds: [CONJUNTO],
        modo: { tipo: 'prefijo', texto: '' },
      },
    ],
  ];

  // Los defaults de zod que se veían en pantalla. `Invalid` cubre de una vez
  // `Invalid enum value`, `Invalid discriminator value` y `Invalid datetime`.
  const DEFAULTS_DE_ZOD = ['Required', 'Expected', 'Invalid', 'Unrecognized', 'Array must contain'];

  it.each(invalidos)('%s: el detail existe, está en castellano y nombra una regla', async (_caso, body) => {
    const r = await rechazo(body);
    expect(r.status).toBe(400);
    expect(r.error).toBe('invalid_payload');
    expect(typeof r.detail).toBe('string');
    expect(r.detail!.length).toBeGreaterThan(0);
    for (const default_ of DEFAULTS_DE_ZOD) {
      expect(r.detail, `default de zod «${default_}»`).not.toContain(default_);
    }
  });
});
