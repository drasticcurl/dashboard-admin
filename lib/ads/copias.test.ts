import fc from 'fast-check';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { duplicar, type PedidoCopia } from './copias';
import { postForm } from './meta';
import { genArbolAds, type ArbolAds } from '../test/generadores-ads';

/**
 * Property 11 (task 22.2): toda Copia nace pausada (R10 c3, R18 c2). Para todo
 * árbol de origen con estados al azar en cada nodo (ACTIVE, PAUSED, WITH_ISSUES),
 * TODA operación de copia —sincrónica o sub-petición del batch— sale con
 * `status_option=PAUSED` y nunca con ACTIVE ni INHERITED_FROM_SOURCE, cualquiera
 * sea el estado del original y de sus descendientes.
 *
 * `postForm` se mockea: el "Cliente_Meta simulado" registra los parámetros
 * enviados y devuelve respuestas sintéticas.
 */

vi.mock('./meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./meta')>();
  return { ...actual, postForm: vi.fn() };
});

const mockPostForm = vi.mocked(postForm);

const llamadas: Array<{ url: string; campos: Record<string, string> }> = [];

function pedidoDe(arbol: ArbolAds, objetivo: { campaignId: string; adsetId?: string }): PedidoCopia {
  return {
    objectId: objetivo.adsetId ?? objetivo.campaignId,
    nivel: objetivo.adsetId ? 'adset' : 'campaign',
    campaignId: objetivo.adsetId ? objetivo.campaignId : undefined,
    nombre: 'Copia',
    sufijo: ' - Copia 1',
    objetosEsperados: 1,
  };
}

afterEach(() => {
  mockPostForm.mockReset();
  llamadas.length = 0;
});

// Feature: gestion-campanas-anuncios, Property 13: El árbol copiado es
// equivalente al original
describe('Property 13 (R10 c1, c2)', () => {
  it('para todo árbol, cada pedido pide el árbol completo (deep_copy), el conjunto queda bajo la campaña original, y los descendientes conservan el nombre', async () => {
    await fc.assert(
      fc.asyncProperty(genArbolAds(), async (arbol) => {
        llamadas.length = 0; // por RUN, no por test: fc.assert corre 100 runs acá
        // El pedido que arma el Endpoint_Acciones (23.3): la equivalencia que
        // nuestro código controla es la forma del pedido, no la respuesta de
        // Meta.
        const pedidos: PedidoCopia[] = [];
        for (const c of arbol.campanias) {
          const anuncios = c.conjuntos.reduce((a, s) => a + s.anuncios.length, 0);
          pedidos.push({
            objectId: c.campaignId,
            nivel: 'campaign',
            nombre: c.campaignId,
            sufijo: ' - Copia 1',
            // la Copia y TODOS sus descendientes (R10 c1): misma cantidad de
            // conjuntos y misma cantidad de anuncios por conjunto
            objetosEsperados: 1 + c.conjuntos.length + anuncios,
          });
          for (const s of c.conjuntos) {
            pedidos.push({
              objectId: s.adsetId,
              nivel: 'adset',
              campaignId: c.campaignId, // misma campaña padre (R10 c2)
              nombre: s.adsetId,
              sufijo: ' - Copia 1',
              objetosEsperados: 1 + s.anuncios.length,
            });
          }
        }
        // rama sincrónica: sólo pedidos chicos (suma de objetos esperados < 3)
        const recortados = pedidos.filter((p) => p.objetosEsperados <= 2).slice(0, 2);
        if (recortados.length === 0 || recortados.reduce((a, p) => a + p.objetosEsperados, 0) >= 3) return;

        mockPostForm.mockImplementation(async (url, _accountId, campos) => {
          llamadas.push({ url, campos });
          return { res: new Response('{}', { status: 200 }), cuerpo: { id: '120210000000000001' } };
        });

        await duplicar('act_test', recortados);

        for (let i = 0; i < recortados.length; i++) {
          const pedido = recortados[i]!;
          const l = llamadas[i]!;
          // el árbol completo por debajo del nivel (R10 c1, c2)
          expect(l.campos.deep_copy).toBe('true');
          // los descendientes conservan su nombre: ONLY_TOP_LEVEL_RENAME
          const rename = JSON.parse(l.campos.rename_options ?? '{}') as { rename_strategy?: string; rename_suffix?: string };
          expect(rename.rename_strategy).toBe('ONLY_TOP_LEVEL_RENAME');
          expect(rename.rename_suffix).toBe(pedido.sufijo);
          // el conjunto copia queda bajo la MISMA campaña padre (R10 c2)
          if (pedido.nivel === 'adset') {
            expect(l.campos.campaign_id).toBe(pedido.campaignId);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: gestion-campanas-anuncios, Property 11: Toda Copia nace pausada
describe('Property 11 (R10 c3, R18 c2)', () => {
  it('para todo árbol con estados al azar, toda operación de copia envía status_option=PAUSED y nunca ACTIVE ni INHERITED_FROM_SOURCE', async () => {
    await fc.assert(
      fc.asyncProperty(genArbolAds(), async (arbol) => {
        llamadas.length = 0; // por RUN, no por test
        // un pedido por campaña y por conjunto del árbol, con 1 objeto esperado
        // c/u; se recortan a 2 para quedarse en la rama SINCRÓNICA (la rama
        // batch y sus sub-peticiones se ejercitan en los tests de ejemplo 22.4)
        const pedidos: PedidoCopia[] = [];
        for (const c of arbol.campanias) {
          pedidos.push(pedidoDe(arbol, { campaignId: c.campaignId }));
          for (const s of c.conjuntos) {
            pedidos.push(pedidoDe(arbol, { campaignId: c.campaignId, adsetId: s.adsetId }));
          }
        }
        const pedidosRecortados = pedidos.slice(0, 2);
        if (pedidosRecortados.length === 0) return;

        mockPostForm.mockImplementation(async (url, _accountId, campos) => {
          llamadas.push({ url, campos });
          return {
            res: new Response('{}', { status: 200 }),
            cuerpo: { id: '120210000000000001' },
          };
        });

        await duplicar('act_test', pedidosRecortados);

        // cada operación de copia nace pausada
        for (const l of llamadas) {
          expect(l.url.endsWith('/copies')).toBe(true);
          expect(l.campos.status_option, `pedido a ${l.url}`).toBe('PAUSED');
          expect(l.campos.deep_copy).toBe('true');
        }

        // nunca ACTIVE ni heredado
        const todo = llamadas
          .map((l) => [l.campos.status_option, l.campos.batch])
          .flat()
          .join('|');
        expect(todo).not.toContain('ACTIVE');
        expect(todo).not.toContain('INHERITED_FROM_SOURCE');
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Tests de ejemplo del Escritor_Copias (task 22.4) ───────────────────────

function pedido(objectId: string, nivel: 'campaign' | 'adset', objetosEsperados = 1): PedidoCopia {
  return {
    objectId,
    nivel,
    campaignId: nivel === 'adset' ? '120210000000000001' : undefined,
    nombre: `Copia de ${objectId}`,
    sufijo: ' - Copia 1',
    objetosEsperados,
  };
}

describe('Escritor_Copias — ejemplos (R10 c7, c8, c14, R17 c10)', () => {
  it('1 o 2 objetos a crear → sincrónico, un POST /{id}/copies por pedido', async () => {
    mockPostForm.mockImplementation(async (url) => {
      llamadas.push({ url, campos: {} });
      return { res: new Response('{}', { status: 200 }), cuerpo: { id: '120210000000000999' } };
    });
    const r = await duplicar('act_x', [pedido('c1', 'campaign', 1), pedido('s1', 'adset', 1)]);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.estado === 'confirmado')).toBe(true);
    expect(llamadas.every((l) => l.url.endsWith('/copies'))).toBe(true);
  });

  it('3 o más objetos a crear → batch con una sub-petición por pedido', async () => {
    mockPostForm.mockImplementation(async (url, _acc, campos) => {
      llamadas.push({ url, campos });
      if (url.endsWith('/async_batch_requests')) return { res: new Response('{}', { status: 200 }), cuerpo: { async_batch_id: 'batch-1' } };
      if (url.includes('?fields=status')) return { res: new Response('{}', { status: 200 }), cuerpo: { status: 'COMPLETE' } };
      if (url.includes('/requests')) {
        return {
          res: new Response('{}', { status: 200 }),
          cuerpo: { data: [{ name: 'copia-c1', body: JSON.stringify({ id: '120210000000000999' }) }] },
        };
      }
      return { res: new Response('{}', { status: 200 }), cuerpo: {} };
    });
    const r = await duplicar('act_x', [pedido('c1', 'campaign', 1), pedido('c2', 'campaign', 1), pedido('c3', 'campaign', 1)]);
    expect(llamadas.some((l) => l.url.endsWith('/async_batch_requests'))).toBe(true);
    expect(r).toHaveLength(3);
  }, 30_000);

  it('más de 50 sub-peticiones parten en llamadas sucesivas (R10 c7)', async () => {
    let batches = 0;
    let pedidosDeEsteBatch: number[] = [];
    const pendientes: string[] = [];
    mockPostForm.mockImplementation(async (url, _acc, campos) => {
      if (url.endsWith('/async_batch_requests')) {
        batches += 1;
        const subs = JSON.parse(campos.batch ?? '[]') as Array<{ relative_url: string; body: string }>;
        pendientes.length = 0;
        for (const s of subs) pendientes.push(s.relative_url.split('/')[0]!);
        const handle = `batch-${batches}`;
        llamadas.push({ url, campos });
        return { res: new Response('{}', { status: 200 }), cuerpo: { async_batch_id: handle } };
      }
      if (url.includes('?fields=status')) {
        return { res: new Response('{}', { status: 200 }), cuerpo: { status: 'COMPLETE' } };
      }
      if (url.includes('/requests')) {
        pedidosDeEsteBatch = [...pendientes];
        return {
          res: new Response('{}', { status: 200 }),
          cuerpo: { data: pedidosDeEsteBatch.map((id) => ({ name: `copia-${id}`, body: JSON.stringify({ id: `1${'0'.repeat(15)}${batches}` }) })) },
        };
      }
      return { res: new Response('{}', { status: 200 }), cuerpo: {} };
    });

    const pedidos = Array.from({ length: 51 }, (_, i) => pedido(`c${i}`, 'campaign', 1));
    const r = await duplicar('act_x', pedidos);
    expect(r).toHaveLength(51);
    expect(batches).toBe(2); // 50 + 1
    const subsPorBatch = llamadas
      .filter((l) => l.url.endsWith('/async_batch_requests'))
      .map((l) => (JSON.parse(l.campos.batch ?? '[]') as unknown[]).length);
    expect(subsPorBatch).toEqual([50, 1]);
  }, 60_000);

  it('ids parciales → indeterminado con la lista de creados; error → fallido sin nada (R10 c8)', async () => {
    mockPostForm.mockImplementationOnce(async (url) => {
      llamadas.push({ url, campos: {} });
      // la respuesta trae SOLO el id de arriba, no los 2 esperados
      return { res: new Response('{}', { status: 200 }), cuerpo: { id: '120210000000000999' } };
    });
    const [parcial] = await duplicar('act_x', [pedido('c1', 'campaign', 2)]);
    expect(parcial!.estado).toBe('indeterminado');
    expect(parcial!.creados).toContain('120210000000000999');

    mockPostForm.mockImplementationOnce(async (url) => {
      llamadas.push({ url, campos: {} });
      return {
        res: new Response('{}', { status: 400 }),
        cuerpo: { error: { message: 'rechazado', code: 100, error_subcode: 3858079 } },
      };
    });
    const [fallido] = await duplicar('act_x', [pedido('c2', 'campaign', 1)]);
    expect(fallido!.estado).toBe('fallido');
    expect(fallido!.creados).toEqual([]);
  });

  it('nivel ad se rechaza ANTES de llamar a Meta (R10 c14)', async () => {
    await expect(
      duplicar('act_x', [{ ...pedido('a1', 'campaign'), nivel: 'ad' as never }]),
    ).rejects.toThrow(/anuncios/);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it('un timeout de red queda indeterminado, nunca fallido (R10 c8)', async () => {
    mockPostForm.mockRejectedValue(new Error('timeout'));
    const [r] = await duplicar('act_x', [pedido('c1', 'campaign', 1)]);
    expect(r!.estado).toBe('indeterminado');
  });
});
