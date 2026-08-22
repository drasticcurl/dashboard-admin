import { describe, expect, it } from 'vitest';
import { textoQuePasa } from './Previsualizacion';
import { MOTIVO_TEXTO } from '@/lib/ads/mensajes';
import { calcularPrevisualizacion } from '@/lib/ads/previsualizacion';
import type { MetricasObjeto } from '@/lib/ads/tipos';

/**
 * La columna «Qué pasa» del Dialogo_Confirmacion (task 15: R3.4, R6.4).
 *
 * El bug que este archivo fija no es de cálculo: `calcularPrevisualizacion` ya
 * ponía la advertencia. Era de presentación. La celda hacía
 * `motivo ? … : advertencia ? … : …`, y con esa exclusión el caso mayoritario de
 * la cuenta real —conjuntos ACTIVE bajo una campaña pausada, 92 de 169— mostraba
 * «ya está en el estado que la acción pediría» y escondía lo único que explicaba
 * el síntoma: que el objeto no entrega. El motivo tapaba a la advertencia
 * justamente en las filas donde la advertencia importaba.
 *
 * Los casos entran por `calcularPrevisualizacion` y no por objetos literales:
 * lo que se verifica es que la pantalla muestre lo que el cálculo produce, así
 * que fabricar la fila a mano permitiría una combinación que el cálculo no emite.
 *
 * `textoQuePasa` y no el componente renderizado: vitest corre en node, sin jsdom
 * (`vitest.config.ts`), y el JSX de la celda usa esta función como su único
 * contenido de texto. La lista de omitidos usa la misma.
 */

const TOPES = { techoEur: 200, topeLoteEur: 500, minimoDiarioEur: null };

/** Una fila de conjunto con los campos que la Previsualizacion mira; el resto en
 *  valores neutros, como el helper de `previsualizacion.test.ts`. */
function conjunto(over: Partial<MetricasObjeto> = {}): MetricasObjeto {
  return {
    level: 'adset',
    objectId: 's1',
    objectName: 'Conjunto frío EUR',
    accountId: 'act_1',
    campaignId: 'c1',
    adsetId: 's1',
    adId: '',
    funnelId: null,
    status: 'PAUSED',
    effectiveStatus: 'PAUSED',
    budgetLevel: 'adset',
    budgetMode: 'daily',
    dailyBudgetEur: 10,
    spendEur: 5,
    impressions: 100,
    clicks: 5,
    sales: 1,
    revenueEur: 50,
    refundedEur: 0,
    commissionsEur: 0,
    costsEur: 0,
    netEur: 50,
    profitEur: 45,
    roas: 10,
    roi: 10,
    cpaEur: 5,
    ctr: 0.05,
    cpcEur: 1,
    ultimaAccionAt: null,
    cpmEur: 50,
    hookRate: 0.5,
    videoReproducciones: 50,
    videoThruplay: 10,
    videoP25: 20,
    videoP50: 15,
    videoP75: 10,
    videoP100: 5,
    alcance: null,
    frecuencia: null,
    inicioProgramado: null,
    syncedAt: '2026-08-12T10:00:00.000Z',
    desaparecidoAt: null,
    ...over,
  };
}

/** El mapa de padres con la campaña en el estado que se pida (R6.4). */
const padres = (campania: string) => ({
  padres: new Map([['s1', { campania, conjunto: null }]]),
});

const previaDe = (
  accion: 'activate' | 'pause',
  fila: MetricasObjeto,
  params: Record<string, unknown> = {},
) => calcularPrevisualizacion(accion, 'adset', [fila], ['s1'], params, TOPES).filas[0]!;

describe('textoQuePasa: el motivo y la advertencia no se tapan (R3.4, R6.4)', () => {
  it('con los dos, muestra los dos: es el caso de 92 de los 169 conjuntos reales', () => {
    const f = previaDe(
      'activate',
      conjunto({ status: 'ACTIVE', effectiveStatus: 'CAMPAIGN_PAUSED' }),
      padres('PAUSED'),
    );
    expect(f.motivo).toBe('ya_esta_en_ese_estado');

    const texto = textoQuePasa(f);
    expect(texto).toContain(MOTIVO_TEXTO.ya_esta_en_ese_estado);
    expect(texto).toContain('no entrega hasta que se active la campaña');
    // El mismo separador con el que el servidor junta dos advertencias entre sí.
    expect(texto).toContain(' · ');
  });

  it('con la advertencia sola, la muestra sola', () => {
    const f = previaDe('activate', conjunto(), padres('PAUSED'));
    expect(f.motivo).toBeNull();
    expect(textoQuePasa(f)).toBe(f.advertencia);
  });

  it('con el motivo solo, muestra el motivo del catálogo y nada más', () => {
    const f = previaDe('pause', conjunto(), padres('ACTIVE'));
    expect(f.motivo).toBe('ya_esta_en_ese_estado');
    expect(f.advertencia).toBeNull();
    expect(textoQuePasa(f)).toBe(MOTIVO_TEXTO.ya_esta_en_ese_estado);
  });

  it('sin nada que advertir devuelve vacío, y ahí la celda dice «se aplica»', () => {
    const f = previaDe('activate', conjunto(), padres('ACTIVE'));
    expect(f.motivo).toBeNull();
    expect(f.advertencia).toBeNull();
    expect(f.ejecutable).toBe(true);
    expect(textoQuePasa(f)).toBe('');
  });

  it('la advertencia del Objeto_Desaparecido llega sin `padres`: viaja en la fila', () => {
    // R3.4 se puede advertir en el diálogo hoy mismo, porque `desaparecidoAt` es
    // un campo de la fila. La de R6.4 no: el `status` de la campaña no está en
    // `MetricasObjeto` y por eso este caso no pasa `padres`.
    const f = previaDe('activate', conjunto({ desaparecidoAt: '2025-03-01T09:00:00.000Z' }));
    const texto = textoQuePasa(f);
    expect(texto).toContain('objeto desaparecido');
    expect(texto).toContain('Meta ya no lo devuelve');
  });

  it('las dos advertencias y el motivo entran los tres en la misma celda', () => {
    const f = previaDe(
      'activate',
      conjunto({
        status: 'ACTIVE',
        effectiveStatus: 'CAMPAIGN_PAUSED',
        desaparecidoAt: '2025-03-01T09:00:00.000Z',
      }),
      padres('PAUSED'),
    );
    const texto = textoQuePasa(f);
    expect(texto).toContain(MOTIVO_TEXTO.ya_esta_en_ese_estado);
    expect(texto).toContain('no entrega hasta que se active la campaña');
    expect(texto).toContain('objeto desaparecido');
  });
});
