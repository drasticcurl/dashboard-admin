import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MetaAdsError,
  contadorLlamadas,
  enviar,
  fetchAlcance,
  fetchCampaigns,
  fetchDsaConjuntos,
  fetchObjeto,
  postForm,
  reiniciarContador,
  setDailyBudget,
  setStatus,
} from './meta';

// meta.ts lee META_ADS_TOKEN en cada llamada (token()), así que alcanza con
// fijarlo una vez para toda la suite. El valor nunca sale a la red: fetch está
// mockeado en todos los tests.
const TOKEN_ORIGINAL = process.env.META_ADS_TOKEN;
beforeAll(() => {
  process.env.META_ADS_TOKEN = 'test-token';
});
afterAll(() => {
  if (TOKEN_ORIGINAL === undefined) delete process.env.META_ADS_TOKEN;
  else process.env.META_ADS_TOKEN = TOKEN_ORIGINAL;
});

// La red se mockea con vi.stubGlobal('fetch', …). Los payloads son los que
// devuelve la Marketing API de Meta (ver el §2 del task T13).
function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const CAMPAIGN_PAGE_1 = {
  data: [
    {
      id: '120248641680500617',
      name: 'anuncio bidcap 1',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      daily_budget: '1000',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      created_time: '2026-07-30T00:00:00+0000',
    },
  ],
  paging: {
    // La respuesta REAL de Meta trae el access_token adentro del cursor.
    next: 'https://graph.facebook.com/v21.0/act_x/campaigns?fields=id&limit=200&after=AAA&access_token=TOKEN_SECRETO',
  },
};

const CAMPAIGN_PAGE_2 = {
  data: [{ id: '120248641680510617', name: 'anuncio bidcap 2', status: 'PAUSED', effective_status: 'PAUSED' }],
};

describe('meta: el token nunca viaja en la URL (D-A3)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    reiniciarContador();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('nunca pone el token en la URL, ni siguiendo la paginación', async () => {
    const urls: string[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        const url = String(input);
        if (url.includes('after=AAA')) return jsonResponse(CAMPAIGN_PAGE_2);
        return jsonResponse(CAMPAIGN_PAGE_1);
      });
    vi.stubGlobal('fetch', fetchMock);

    const cs = await fetchCampaigns('act_x');
    expect(cs).toHaveLength(2);
    expect(urls.some((u) => u.includes('access_token'))).toBe(false);
    expect(urls.length).toBeGreaterThan(1); // que de verdad paginó
  });

  it('todas las llamadas salen con Authorization: Bearer y sin token en la query', async () => {
    // mockImplementation y no mockResolvedValue: un Response solo se puede leer
    // una vez, y devolver el mismo objeto en cada llamada rompe la paginación.
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(CAMPAIGN_PAGE_2));
    vi.stubGlobal('fetch', fetchMock);
    await fetchCampaigns('act_x');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('access_token');
    expect(url).not.toContain('META_ADS_TOKEN');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });
});

describe('meta: el sobre de error conserva lo que el backoff necesita (§6b)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('un error de Meta queda con subcode, transient, traceId y httpStatus', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              message: '(#17) User request limit reached',
              code: 17,
              type: 'OAuthException',
              error_subcode: 2446079,
              is_transient: true,
              fbtrace_id: 'AbCdEf123',
            },
          },
          400,
        ),
      ),
    );
    const r = await enviar('120248641680500617', { status: 'PAUSED' });
    expect(r.estado).toBe('fallido');
    if (r.estado === 'fallido') {
      expect(r.error).toBeInstanceOf(MetaAdsError);
      expect(r.error.code).toBe(17);
      expect(r.error.subcode).toBe(2446079);
      expect(r.error.transient).toBe(true);
      expect(r.error.traceId).toBe('AbCdEf123');
      expect(r.error.httpStatus).toBe(400);
    }
  });
});

describe('meta: escritura distingue confirmado / fallido / indeterminado (§6)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('{"success":true} → confirmado', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true })));
    const r = await enviar('x', { status: 'PAUSED' });
    expect(r.estado).toBe('confirmado');
  });

  it('200 con error en el body → fallido (Meta procesó y rechazó)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'permiso', code: 200 } }, 200)),
    );
    const r = await enviar('x', { status: 'PAUSED' });
    expect(r.estado).toBe('fallido');
  });

  it('timeout o error de red → indeterminado, no fallido', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('This operation was aborted', 'AbortError')),
    );
    const r = await enviar('x', { status: 'PAUSED' });
    expect(r.estado).toBe('indeterminado');
  });

  it('5xx sin body → indeterminado (el server pudo haber aplicado el cambio)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    const r = await enviar('x', { status: 'PAUSED' });
    expect(r.estado).toBe('indeterminado');
  });
});

describe('meta: validaciones de escritura que no deben salir a la red', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('setDailyBudget con decimales tira sin tocar la red', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(setDailyBudget('x', 2500.5)).rejects.toThrow(/entero/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('setDailyBudget con cero o negativo tira sin tocar la red', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(setDailyBudget('x', 0)).rejects.toThrow(/mayor que cero/);
    await expect(setDailyBudget('x', -100)).rejects.toThrow(/mayor que cero/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('setStatus solo acepta ACTIVE y PAUSED', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // @ts-expect-error — probar el caso inválido es el punto del test
    await expect(setStatus('x', 'ARCHIVED')).rejects.toThrow(/no escribible/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('meta: contador de llamadas (§9.7)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('cuenta las llamadas salientes y se reinicia', async () => {
    reiniciarContador();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => jsonResponse({ data: [] })));
    await fetchCampaigns('act_x');
    expect(contadorLlamadas().total).toBe(1);
    reiniciarContador();
    expect(contadorLlamadas().total).toBe(0);
  });
});

describe('meta: fetchObjeto lee un objeto suelto para reconciliar', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('devuelve el estado y el presupuesto en unidades mínimas', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: '120248641680500617',
          status: 'ACTIVE',
          effective_status: 'ACTIVE',
          daily_budget: '2500',
          lifetime_budget: null,
        }),
      ),
    );
    const o = await fetchObjeto('120248641680500617', 'campaign');
    expect(o).toEqual({
      objectId: '120248641680500617',
      name: null,
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      dailyBudget: 2500,
      lifetimeBudget: null,
    });
  });
});

// ─── Las llamadas nuevas de gestion-campanas-anuncios (task 22.4) ───────────

describe('meta: las llamadas nuevas (alcance, DSA, postForm) respetan D-A3 y la contabilidad', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    reiniciarContador();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetchAlcance sale con Bearer y sin token, también siguiendo la paginación', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const url = String(input);
      if (url.includes('after=AAA')) {
        return jsonResponse({ data: [{ campaign_id: '2', reach: '20' }] });
      }
      return jsonResponse({
        data: [{ campaign_id: '1', reach: '10', frequency: '1.5', impressions: '15' }],
        paging: { next: 'https://graph.facebook.com/v21.0/act_x/insights?fields=x&after=AAA&access_token=TOKEN_SECRETO' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const filas = await fetchAlcance('act_x', 'campaign', '2026-01-01', '2026-01-07');
    expect(filas).toHaveLength(2);
    expect(filas[0]!.reach).toBe(10);
    expect(filas[0]!.frequency).toBe(1.5);
    expect(urls.every((u) => !u.includes('access_token'))).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('fetchDsaConjuntos trae pagador y beneficiario en llamada aparte', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({ data: [{ id: 's1', dsa_payor: 'Payor', dsa_beneficiary: 'Beneficiary' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const dsa = await fetchDsaConjuntos('act_x');
    expect(dsa).toHaveLength(1);
    expect(dsa[0]).toEqual({ adsetId: 's1', dsaPayor: 'Payor', dsaBeneficiary: 'Beneficiary' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('access_token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('postForm manda el token SOLO en el header, nunca en la URL ni en el body', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ id: '1' }));
    vi.stubGlobal('fetch', fetchMock);

    await postForm('https://graph.facebook.com/v21.0/1/copies', 'act_x', { status_option: 'PAUSED' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('access_token');
    expect(url).not.toContain('test-token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(String(init.body)).not.toContain('test-token');
  });

  it('el contador cuenta las llamadas nuevas también cuando fallan por red (R17 c10)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postForm('https://graph.facebook.com/v21.0/1/copies', 'act_x', {})).rejects.toThrow();
    const contador = contadorLlamadas();
    expect(contador.total).toBe(1);
    expect(contador.porCuenta['act_x']).toBe(1);
  });

  it('postForm con un error de Meta NO tira: devuelve el cuerpo para que el llamador lo interprete', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({ error: { message: 'no permitido', code: 100, error_subcode: 3858079 } }, 400),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { res, cuerpo } = await postForm('https://graph.facebook.com/v21.0/1/copies', 'act_x', {});
    expect(res.status).toBe(400);
    expect(cuerpo?.error?.code).toBe(100);
    expect(cuerpo?.error?.error_subcode).toBe(3858079);
    expect(contadorLlamadas().total).toBe(1);
  });
});
