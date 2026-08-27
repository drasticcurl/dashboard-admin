/**
 * La ida y la vuelta del Nivel_Activo y el Filtro_Cascada por la URL.
 *
 * ## POR QUÉ ES UN MÓDULO PROPIO Y NO VIVE EN NINGUNO DE LOS DOS LLAMADORES
 *
 * Lo usan `page.tsx` (server component) y `GestorAnuncios.tsx` (client), y **no
 * puede vivir en ninguno de los dos**:
 *
 * - En `page.tsx` no, porque un `page` de Next no puede exportar nada más que el
 *   default y los campos de ruta: el chequeo generado
 *   (`.next/types/app/…/page.ts`) restringe el resto de los exports a `never` y
 *   `tsc` rompe. Sin exportarla no hay forma de escribir el test de la ida y
 *   vuelta, que es lo que hace compartible al link de 2.12.
 * - En `GestorAnuncios.tsx` tampoco, y esto es lo que hay que no olvidar: ese
 *   archivo es `'use client'`, así que cuando un server component lo importa,
 *   React reemplaza sus exports por referencias de cliente. `GestorAnuncios` se
 *   puede **renderizar** desde el server, pero una función suya **no se puede
 *   llamar**: tira «Attempted to call … from the server but … is on the client».
 *   El error es de runtime y `tsc` no lo ve, así que la única defensa es que la
 *   función no esté ahí.
 *
 * Un módulo sin directiva sirve a los dos lados: el server lo importa como código
 * normal y el bundler lo mete en el bundle del cliente cuando `GestorAnuncios` lo
 * importa. **Sin `pg` y sin `next/headers`**, por lo mismo que `lib/ads/plazos.ts`:
 * un import de servidor acá rompe el bundle del cliente.
 *
 * ## LAS CUATRO PIEZAS SON UN CICLO Y ESTÁN JUNTAS PARA QUE SE LEA
 *
 *     fila  ──cascadaDeCampania──▶ Cascada
 *           ──paramsDeNivel──────▶ ?level=campaign&campaignIds=<id>
 *           ──cascadaDeSearchParams──▶ { campaignIds: [<id>] }
 *           ──cascadaInicial─────▶ la MISMA Cascada
 *
 * Que cierre es lo que verifica `navegacionCampania.test.ts`.
 */

import { MAX_CASCADA, type Cascada } from '@/lib/ads/seleccion';
import type { MetricasObjeto, NivelAds } from '@/lib/ads/tipos';

/**
 * La cascada que produce subir a la campaña de una fila (2.12 de
 * `toggle-conjuntos-entrega`). `null` = no hay a dónde subir.
 *
 * A nivel campaña `campaignId` ES el `objectId` de la fila, así que el filtro se
 * apuntaría a sí mismo: no es un caso a soportar, es uno a no producir.
 */
export function cascadaDeCampania(fila: Pick<MetricasObjeto, 'level' | 'campaignId'>): Cascada | null {
  if (fila.level === 'campaign' || !fila.campaignId) return null;
  return { nivel: 'campaign', ids: [fila.campaignId], descartados: 0, motivo: null };
}

/**
 * Los query params que reflejan un nivel y una cascada (R8 c7). Es el cuerpo que
 * `escribirUrl` tenía inline, sin un cambio: los dos `delete` van SIEMPRE, así que
 * cambiar de nivel no puede dejar colgada una cascada del nivel anterior.
 */
export function paramsDeNivel(
  actuales: string,
  nuevoNivel: NivelAds,
  nuevaCascada: { nivel: 'campaign' | 'adset'; ids: readonly string[] } | null,
  extra?: Record<string, string>,
): URLSearchParams {
  const params = new URLSearchParams(actuales);
  params.set('level', nuevoNivel);
  params.delete('campaignIds');
  params.delete('adsetIds');
  if (nuevaCascada && nuevaCascada.ids.length > 0) {
    const clave = nuevaCascada.nivel === 'campaign' ? 'campaignIds' : 'adsetIds';
    for (const id of nuevaCascada.ids) params.append(clave, id);
  }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v) params.set(k, v);
    else params.delete(k);
  }
  return params;
}

/** Un valor de query string como lista de ids de Meta válidos y únicos, hasta el tope. */
function idsDeCascada(v: string | string[] | undefined): string[] {
  const crudos = typeof v === 'string' ? [v] : Array.isArray(v) ? v : [];
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const id of crudos) {
    if (out.length >= MAX_CASCADA) break;
    if (!/^\d{1,20}$/.test(id) || vistos.has(id)) continue;
    vistos.add(id);
    out.push(id);
  }
  return out;
}

/**
 * El Filtro_Cascada que la URL trae, ya saneado: dígitos de 1 a 20, sin
 * repetidos, hasta `MAX_CASCADA` (R8 c7, c13).
 *
 * **`campaignIds` vale también en el nivel CAMPAÑA desde la task 13.4.** Antes se
 * ignoraba ahí, y con eso el link del tercer estado del interruptor quedaba a
 * medias de una forma que se lee como un bug intermitente: la PRIMERA pintura sí
 * venía filtrada —`getMetricasAds` recibe estos ids— pero `construirUrl` toma la
 * cascada del ESTADO del cliente, y ese estado arrancaba en `null`, así que el
 * primer cambio de filtro, de página o de orden pedía la tabla entera y la campaña
 * se perdía de vista.
 *
 * `adsetIds` sigue valiendo SÓLO en el nivel anuncio, y eso no cambió: el filtro
 * de conjuntos es sobre `o."adsetId"`, que a nivel conjunto es la propia fila.
 */
export function cascadaDeSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
  nivel: NivelAds,
): { campaignIds: string[]; adsetIds: string[] } {
  return {
    campaignIds: idsDeCascada(searchParams.campaignIds),
    adsetIds: nivel === 'ad' ? idsDeCascada(searchParams.adsetIds) : [],
  };
}

/**
 * La cascada del primer render, reconstruida de lo que `page.tsx` leyó de la URL.
 *
 * `'ad'` es el único nivel que lee `adsetIds`; los otros dos leen `campaignIds`, y
 * su `cascada.nivel` es `'campaign'` en los dos casos porque lo que el filtro
 * compara es `o."campaignId"`.
 *
 * El recorte a `MAX_CASCADA` queda acá y no se saltea: la URL la puede escribir
 * cualquiera, y el chip informa cuántos ids se descartaron.
 */
export function cascadaInicial(
  nivel: NivelAds,
  campaignIds: readonly string[] | undefined,
  adsetIds: readonly string[] | undefined,
): Cascada | null {
  const ids = nivel === 'ad' ? adsetIds : campaignIds;
  if (!ids || ids.length === 0) return null;
  return {
    nivel: nivel === 'ad' ? 'adset' : 'campaign',
    ids: ids.slice(0, MAX_CASCADA),
    descartados: Math.max(0, ids.length - MAX_CASCADA),
    motivo: ids.length > MAX_CASCADA ? 'tope' : null,
  };
}
