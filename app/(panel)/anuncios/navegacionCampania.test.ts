import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  cascadaDeCampania,
  cascadaDeSearchParams,
  cascadaInicial,
  paramsDeNivel,
} from './cascadaUrl';
import { rotuloCascada } from './ChipCascada';
import { MAX_CASCADA, type Cascada } from '@/lib/ads/seleccion';
import type { MetricasObjeto, NivelAds } from '@/lib/ads/tipos';

/**
 * La navegación a la campaña, task 13.4 de `toggle-conjuntos-entrega` (1.15, 2.12).
 *
 * ## QUÉ DEFECTO CIERRA
 *
 * 1.15: un conjunto que no entrega porque su campaña está pausada —92 de 169 en la
 * cuenta— no ofrecía NINGUNA forma de llegar a esa campaña desde su fila. Había que
 * ir a buscarla a mano a la vista de campañas, y activarla es lo único que haría
 * entregar al conjunto.
 *
 * ## ES NAVEGACIÓN Y NO CASCADA, Y ESO YA ESTÁ CERRADO
 *
 * El link cambia de nivel con el filtro puesto; la campaña se activa con su propio
 * interruptor en su propia fila. Activar una campaña cambia la entrega —y el
 * gasto— de todos los conjuntos que tiene debajo, un radio mucho mayor que la fila
 * que el usuario tocó, y hoy no hay ninguna previa que muestre ese alcance antes de
 * tocar 92 objetos. Este archivo no verifica ninguna escritura porque no hay
 * ninguna: `subirACampania` escribe la URL y nada más.
 *
 * ## LO QUE SE VERIFICA ACÁ ES LA IDA Y LA VUELTA
 *
 * Y las dos mitades juntas, no cada una por separado, porque lo que 2.12 necesita
 * es que el link sea COMPARTIBLE: la cascada que sale por la URL tiene que ser la
 * misma que vuelve a entrar cuando alguien recarga o abre el link pegado en un
 * chat.
 *
 *     fila de conjunto  ──cascadaDeCampania──▶  Cascada
 *                       ──paramsDeNivel─────▶  ?level=campaign&campaignIds=<id>
 *                       ──cascadaDeSearchParams──▶  { campaignIds: [<id>] }
 *                       ──cascadaInicial────▶  la MISMA Cascada
 *
 * **La vuelta es la mitad que estaba rota y hay que decir cómo.** `page.tsx`
 * ignoraba `campaignIds` en el nivel campaña, y el síntoma no era «el link no
 * filtra»: la PRIMERA pintura sí venía filtrada, porque `getMetricasAds` recibe los
 * ids del server component. Lo que fallaba era la segunda: `construirUrl` toma la
 * cascada del ESTADO del cliente, y ese estado arrancaba en `null`, así que el
 * primer cambio de filtro —o de página, o de orden, o el tick de refresco— pedía la
 * tabla entera y la campaña se perdía de vista. Un bug que aparece recién en la
 * segunda interacción se reporta como «a veces no anda».
 *
 * ## POR QUÉ CONTRA FUNCIONES PURAS Y NO CONTRA EL COMPONENTE
 *
 * Es el criterio de todo el repo y no una excepción de este archivo: `vitest.config.ts`
 * corre en node, sin jsdom y sin testing-library, así que la decisión se prueba
 * donde vive —`accionDeToggle`, `dibujoDeEstado`, `senalDeEntrega` y
 * `frescuraDeFila` están exportadas por lo mismo—. Lo que el componente agrega
 * arriba de estas cuatro funciones son tres `setState` y un `router.replace`.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Lo único que `cascadaDeCampania` lee de una fila, con el `Pick` de la firma: el
 * nivel y la campaña. El test no arma una `MetricasObjeto` de cuarenta campos para
 * afirmar algo sobre dos.
 */
type Fila = Pick<MetricasObjeto, 'level' | 'campaignId'>;

function fila(level: NivelAds, campaignId: string): Fila {
  return { level, campaignId };
}

/** Una fila de conjunto: la que dispara el link (los 92). */
function conjunto(campaignId: string): Fila {
  return fila('adset', campaignId);
}

/** Los `searchParams` que Next le pasa al server component, a partir de una URL. */
function searchParamsDe(url: string): Record<string, string | string[] | undefined> {
  const params = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : url);
  const out: Record<string, string | string[] | undefined> = {};
  for (const clave of new Set(params.keys())) {
    const todos = params.getAll(clave);
    // Next entrega un string cuando la clave aparece una vez y un array cuando
    // aparece varias. La distinción importa: `cascadaDeSearchParams` tiene que
    // aceptar las dos formas y el test no puede normalizarla por su cuenta.
    out[clave] = todos.length === 1 ? todos[0] : todos;
  }
  return out;
}

/** El `level` que la URL declara, como lo resuelve `page.tsx`. */
function nivelDe(url: string): NivelAds {
  const v = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('level');
  return v === 'adset' || v === 'ad' || v === 'campaign' ? v : 'campaign';
}

const CAMPANIA = '23851000000000000042';

// ─── La ida: la URL que arma subirACampania ──────────────────────────────────

describe('la ida: subirACampania arma level=campaign con la campaña como única cascada', () => {
  it('la cascada es la campaña de la fila, sola y sin descartes', () => {
    expect(cascadaDeCampania(conjunto(CAMPANIA))).toEqual({
      nivel: 'campaign',
      ids: [CAMPANIA],
      descartados: 0,
      motivo: null,
    });
  });

  it('la URL queda en el nivel campaña, con campaignIds y sin adsetIds', () => {
    const params = paramsDeNivel(
      // Se parte de una URL de nivel conjunto con una cascada de campaña puesta,
      // que es exactamente el estado desde el que se toca el link: el usuario está
      // mirando los conjuntos de otra campaña.
      'level=adset&period=today&campaignIds=23851000000000000099&status=any',
      'campaign',
      cascadaDeCampania(conjunto(CAMPANIA)),
    );

    expect(params.get('level')).toBe('campaign');
    expect(params.getAll('campaignIds')).toEqual([CAMPANIA]);
    // La cascada anterior NO queda colgada: `paramsDeNivel` borra las dos claves
    // antes de escribir la nueva. Sin eso el link llevaría a las dos campañas.
    expect(params.getAll('campaignIds')).not.toContain('23851000000000000099');
    expect(params.getAll('adsetIds')).toEqual([]);
    // Y los filtros que el usuario tenía puestos siguen ahí: cambiar de nivel no
    // es empezar de cero.
    expect(params.get('period')).toBe('today');
    expect(params.get('status')).toBe('any');
  });

  it('una fila de campaña no produce link: `campaignId` es su propio `objectId`', () => {
    // Sin esta guarda el link se apuntaría a sí mismo. No es un caso a soportar,
    // es uno a no producir.
    expect(cascadaDeCampania(fila('campaign', CAMPANIA))).toBeNull();
  });

  it('una fila sin campaña tampoco: no hay a dónde ir', () => {
    expect(cascadaDeCampania(fila('adset', ''))).toBeNull();
  });

  it('un anuncio sube a SU campaña, no a su conjunto', () => {
    // El link del tercer estado sólo aparece para `antepasado: 'campaign'`, pero la
    // función es la misma para las tres filas de la jerarquía y su destino siempre
    // es la campaña. Que un anuncio la produzca bien es lo que hace que el día que
    // se agregue el link ahí no haya que tocar esto.
    expect(cascadaDeCampania(fila('ad', CAMPANIA))).toEqual({
      nivel: 'campaign',
      ids: [CAMPANIA],
      descartados: 0,
      motivo: null,
    });
  });
});

// ─── La vuelta: page.tsx reconstruye la cascada de esa URL ───────────────────

describe('la vuelta: la URL del link vuelve a producir la misma cascada', () => {
  it('la ida y la vuelta cierran: el objeto que sale es el que entra', () => {
    // IDA
    const salida = cascadaDeCampania(conjunto(CAMPANIA));
    expect(salida).not.toBeNull();
    const url = `/anuncios?${paramsDeNivel('level=adset&period=today', 'campaign', salida).toString()}`;

    // VUELTA, por el camino real: `page.tsx` lee los searchParams y le pasa los ids
    // a `GestorAnuncios`, que arma el estado inicial.
    const nivel = nivelDe(url);
    expect(nivel).toBe('campaign');
    const { campaignIds, adsetIds } = cascadaDeSearchParams(searchParamsDe(url), nivel);
    expect(campaignIds).toEqual([CAMPANIA]);

    const vuelta = cascadaInicial(nivel, campaignIds, adsetIds);

    // Lo que hace compartible al link: la vuelta es la ida.
    expect(vuelta).toEqual(salida);
  });

  it('`campaignIds` se lee TAMBIÉN en el nivel campaña: es la mitad que estaba rota', () => {
    // Antes de la task 13.4 esto devolvía `[]` y `cascadaInicial` devolvía `null`,
    // así que el estado del cliente arrancaba sin cascada y `construirUrl` pedía la
    // tabla entera en la segunda interacción.
    const sp = searchParamsDe(`?level=campaign&campaignIds=${CAMPANIA}`);
    expect(cascadaDeSearchParams(sp, 'campaign').campaignIds).toEqual([CAMPANIA]);
    expect(cascadaInicial('campaign', [CAMPANIA], [])).toEqual({
      nivel: 'campaign',
      ids: [CAMPANIA],
      descartados: 0,
      motivo: null,
    });
  });

  it('el nivel conjunto y el nivel anuncio no cambiaron de fuente', () => {
    // Preservación: `adsetIds` sigue leyéndose SÓLO en el nivel anuncio, y el nivel
    // conjunto sigue leyendo `campaignIds`. Extender uno no puede haber movido al
    // otro.
    const sp = searchParamsDe(`?campaignIds=${CAMPANIA}&adsetIds=23851000000000000077`);

    const enConjunto = cascadaDeSearchParams(sp, 'adset');
    expect(enConjunto.campaignIds).toEqual([CAMPANIA]);
    expect(enConjunto.adsetIds).toEqual([]);
    expect(cascadaInicial('adset', enConjunto.campaignIds, enConjunto.adsetIds)).toEqual({
      nivel: 'campaign',
      ids: [CAMPANIA],
      descartados: 0,
      motivo: null,
    });

    const enAnuncio = cascadaDeSearchParams(sp, 'ad');
    expect(enAnuncio.adsetIds).toEqual(['23851000000000000077']);
    // A nivel anuncio la cascada sale de los conjuntos, no de las campañas.
    expect(cascadaInicial('ad', enAnuncio.campaignIds, enAnuncio.adsetIds)).toEqual({
      nivel: 'adset',
      ids: ['23851000000000000077'],
      descartados: 0,
      motivo: null,
    });
  });

  it('lo que la URL trae sucio se descarta: la escribe cualquiera', () => {
    // Ids que no son dígitos, repetidos, y más de los que el tope permite. Es la
    // misma limpieza de siempre; entra acá porque ahora corre también en el nivel
    // campaña.
    const sucios = new URLSearchParams();
    sucios.set('level', 'campaign');
    for (const id of ['abc', '', CAMPANIA, CAMPANIA, '1'.repeat(21), '99']) sucios.append('campaignIds', id);

    expect(cascadaDeSearchParams(searchParamsDe(`?${sucios.toString()}`), 'campaign').campaignIds).toEqual([
      CAMPANIA,
      '99',
    ]);
  });

  it('por encima del tope se recorta y el chip lo informa', () => {
    const muchos = Array.from({ length: MAX_CASCADA + 3 }, (_, i) => String(1000 + i));
    const c = cascadaInicial('campaign', muchos, []);
    expect(c!.ids).toHaveLength(MAX_CASCADA);
    expect(c!.descartados).toBe(3);
    expect(c!.motivo).toBe('tope');
  });

  it('sin ids no hay cascada, en ningún nivel', () => {
    for (const nivel of ['campaign', 'adset', 'ad'] as const) {
      expect(cascadaInicial(nivel, [], []), nivel).toBeNull();
      expect(cascadaInicial(nivel, undefined, undefined), nivel).toBeNull();
    }
  });

  it('para toda campaña, la ida y la vuelta cierran', () => {
    // La property que generaliza el caso concreto de arriba: cualquier id de Meta y
    // cualquier estado previo de la URL. Lo que se está fijando es que ninguna
    // combinación de filtros preexistentes pueda comerse la cascada.
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9]{1,20}$/),
        fc.constantFrom('', 'level=adset', 'level=ad&adsetIds=555', 'level=campaign&campaignIds=777', 'period=7d&status=active&sinDatos=0'),
        fc.constantFrom<'adset' | 'ad'>('adset', 'ad'),
        (campaignId, urlPrevia, level) => {
          const salida = cascadaDeCampania(fila(level, campaignId));
          expect(salida).not.toBeNull();

          const url = `/anuncios?${paramsDeNivel(urlPrevia, 'campaign', salida).toString()}`;
          const nivel = nivelDe(url);
          const { campaignIds, adsetIds } = cascadaDeSearchParams(searchParamsDe(url), nivel);

          expect(nivel).toBe('campaign');
          expect(cascadaInicial(nivel, campaignIds, adsetIds)).toEqual(salida);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── El rótulo del chip ──────────────────────────────────────────────────────

describe('el chip dice «La campaña X» cuando el nivel de la tabla es el de la cascada', () => {
  const cascadaCampania: Cascada = { nivel: 'campaign', ids: [CAMPANIA], descartados: 0, motivo: null };
  const cascadaConjunto: Cascada = { nivel: 'adset', ids: ['s1'], descartados: 0, motivo: null };

  it('en el nivel campaña con cascada de campaña: la campaña, no sus conjuntos', () => {
    // El caso que abre `subirACampania`. Con el rótulo viejo diría «Conjuntos de
    // "PXN 1"» sobre una tabla que muestra UNA campaña.
    expect(rotuloCascada(cascadaCampania, 'campaign', 'PXN 1')).toBe('La campaña "PXN 1"');
  });

  it('en el nivel conjunto con cascada de campaña: sigue diciendo lo de siempre', () => {
    // Preservación del texto de R8 c4: parado en conjuntos, «Conjuntos de "X"»
    // describe exactamente lo que hay en la tabla.
    expect(rotuloCascada(cascadaCampania, 'adset', 'PXN 1')).toBe('Conjuntos de "PXN 1"');
  });

  it('en el nivel anuncio con cascada de conjunto: idem', () => {
    expect(rotuloCascada(cascadaConjunto, 'ad', 'Frío')).toBe('Anuncios de "Frío"');
  });

  it('el caso simétrico del conjunto también está cubierto', () => {
    // `nivelActivo === cascada.nivel` no es «estoy en campañas»: es «el nivel de la
    // cascada y el de la tabla coinciden». El nivel conjunto con cascada de
    // conjunto no lo produce ninguna navegación de hoy, y el rótulo tiene que
    // leerse igual si mañana alguien la agrega.
    expect(rotuloCascada(cascadaConjunto, 'adset', 'Frío')).toBe('El conjunto "Frío"');
  });

  it('sin nombre cae al id, y el rótulo sigue armándose', () => {
    // `ChipCascada` pasa el id cuando no tiene el nombre: el texto no puede quedar
    // con un hueco.
    expect(rotuloCascada(cascadaCampania, 'campaign', CAMPANIA)).toBe(`La campaña "${CAMPANIA}"`);
  });
});
