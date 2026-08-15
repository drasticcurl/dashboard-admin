/**
 * Escritor_Copias (task 22.1 de gestion-campanas-anuncios): `duplicar()`, la
 * función nueva del Cliente_Meta que ejecuta `/copies`, entiende su respuesta y
 * usa el batch asíncrono cuando corresponde (R10 c7).
 *
 * POR QUÉ NO REUSA `enviar()`: `enviar()` da por bueno el resultado sólo si Meta
 * responde `{"success": true}`, y `/copies` responde con los ids de los objetos
 * creados. Reusarlo registraría toda duplicación exitosa como fallida. Por eso
 * acá hay un intérprete propio, y `ResultadoCopia` es un tipo aparte de
 * `ResultadoEscritura`: una duplicación indeterminada puede haber creado PARTE
 * de los objetos, y `ResultadoEscritura` no tiene dónde poner esa lista.
 *
 * La clasificación es la de R10 c8:
 *   - confirmado: Meta devolvió ids para TODOS los objetos esperados, sin error;
 *   - fallido: Meta devolvió error y no quedó ningún objeto creado;
 *   - indeterminado: sin respuesta en 120 s, batch ilegible en 300 s, o ids de
 *     sólo parte de los objetos esperados (reintentar a ciegas duplicaría lo
 *     que ya existe).
 *
 * La forma exacta del sobre del batch es la incertidumbre D-01: `leerResultadoBatch`
 * la aísla con una sola responsabilidad, para que ajustarla con la salida de
 * `scripts/verificar-copies-ads.ts` sea un cambio local. La rama sincrónica está
 * completa desde ya.
 */

import { MetaAdsError, postForm } from './meta';
import type { ResultadoCopia } from './tipos';

export type PedidoCopia = {
  /** El objeto origen. Campaña o conjunto: nunca un anuncio (R10 c14). */
  objectId: string;
  nivel: 'campaign' | 'adset';
  /** La campaña padre del conjunto original: la copia queda bajo la misma (R10 c2). */
  campaignId?: string;
  /** Nombre planificado de esta Copia, ya resuelto por lib/ads/nombres.ts. */
  nombre: string;
  /** El sufijo de renombrado (` - Copia N`), para `rename_options` (R10 c5). */
  sufijo: string;
  /** Cuántos objetos se esperan crear (la Copia y todos sus descendientes). */
  objetosEsperados: number;
  /** Inicio en Zona_Cuenta, con desplazamiento explícito. Opcional (R10 c15). */
  inicio?: string;
};

const API_VERSION = process.env.META_API_VERSION ?? 'v21.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const MAX_SUBPETICIONES = 50; // R10 c7
const TIMEOUT_SINCRONICO = 120_000; // R10 c8: 120 s por sub-petición

/** Cuenta los objetos que la corrida entera va a crear: decide el transporte. */
function totalObjetos(pedidos: readonly PedidoCopia[]): number {
  return pedidos.reduce((a, p) => a + p.objetosEsperados, 0);
}

/** Los campos de UNA operación de copia, siempre en el MISMO POST (R10 c3, c5,
 *  c15). `status_option=PAUSED` y no `INHERITED_FROM_SOURCE`: heredar activaría
 *  una copia de una campaña activa, que es lo que el usuario pidió que no pase. */
function camposDe(pedido: PedidoCopia): Record<string, string> {
  const campos: Record<string, string> = {
    deep_copy: 'true',
    status_option: 'PAUSED',
    rename_options: JSON.stringify({
      rename_strategy: 'ONLY_TOP_LEVEL_RENAME',
      rename_suffix: pedido.sufijo,
    }),
  };
  if (pedido.nivel === 'adset') {
    if (!pedido.campaignId) throw new Error('duplicar: un conjunto necesita el id de su campaña padre');
    campos.campaign_id = pedido.campaignId;
  }
  if (pedido.inicio) campos.start_time = pedido.inicio;
  return campos;
}

/**
 * Extrae de una respuesta de Meta todos los ids de objetos creados. La forma
 * exacta de la respuesta de `/copies` puede variar entre versiones de la API:
 * este intérprete barre los campos que suelen traer ids (`id`, `campaign_id`,
 * `adset_id`, `ad_id`) y conserva los que parecen ids de Meta (15 a 20 dígitos).
 * Si la salida de verificar-copies-ads muestra otra forma, el ajuste es local.
 */
export function extraerIdsDeRespuesta(cuerpo: unknown): string[] {
  const ids = new Set<string>();
  const visitar = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (/^\d{15,20}$/.test(v)) ids.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visitar(x);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (['id', 'campaign_id', 'adset_id', 'ad_id'].includes(k)) visitar(x);
      }
    }
  };
  visitar(cuerpo);
  return Array.from(ids);
}

/** Clasifica UNA operación sincrónica según R10 c8. */
function clasificarSincronica(
  pedido: PedidoCopia,
  cuerpo: (Record<string, unknown> & { error?: { message?: string; code?: number; error_subcode?: number } }) | null,
  errorTransporte: MetaAdsError | null,
): ResultadoCopia {
  if (errorTransporte) {
    // Red o timeout: pudo haberse aplicado. Nunca fallido.
    return { estado: 'indeterminado', error: errorTransporte, creados: [], handle: null };
  }
  const err = cuerpo?.error;
  if (err) {
    // Meta procesó y rechazó. Si la respuesta trae ids, quedaron creados igual.
    const creados = extraerIdsDeRespuesta(cuerpo);
    return {
      estado: 'fallido',
      error: new MetaAdsError(err.message ?? 'error de Meta', err.code, undefined, err.error_subcode),
      creados,
    };
  }
  const creados = extraerIdsDeRespuesta(cuerpo);
  if (creados.length === 0) {
    // HTTP ok pero sin ids: no se sabe qué pasó (pudo aplicarse).
    return {
      estado: 'indeterminado',
      error: new MetaAdsError('la respuesta de /copies no trae identificadores de objetos creados'),
      creados,
      handle: null,
    };
  }
  if (creados.length < pedido.objetosEsperados) {
    // Ids de sólo parte de los objetos: hay objetos creados en la cuenta.
    return {
      estado: 'indeterminado',
      error: new MetaAdsError(`la respuesta trae ${creados.length} de los ${pedido.objetosEsperados} objetos esperados`),
      creados,
      handle: null,
    };
  }
  return { estado: 'confirmado', creados };
}

/**
 * Ejecuta las duplicaciones. El transporte lo decide el total de objetos a
 * crear (R10 c7): 1 o 2 → sincrónico; 3 o más → batch con hasta 50
 * sub-peticiones por llamada HTTP, partiendo en llamadas sucesivas si hacen
 * falta más. Nunca tira: devuelve un ResultadoCopia por pedido.
 *
 * Si Meta corta por cuota (613), el lote SE DETIENE y el array devuelto es más
 * corto que `pedidos`: los que faltan NO se intentaron y el llamador los
 * devuelve como `no_intentado` (R16 c5, R17 c17).
 */
export async function duplicar(
  accountId: string,
  pedidos: readonly PedidoCopia[],
): Promise<ResultadoCopia[]> {
  for (const p of pedidos) {
    if (p.nivel !== 'campaign' && p.nivel !== 'adset') {
      throw new Error('duplicar: este panel duplica campañas y conjuntos, nunca anuncios (R10 c14)');
    }
  }
  if (pedidos.length === 0) return [];

  if (totalObjetos(pedidos) >= 3) {
    return duplicarPorBatch(accountId, pedidos);
  }
  return duplicarSincronico(accountId, pedidos);
}

async function duplicarSincronico(
  accountId: string,
  pedidos: readonly PedidoCopia[],
): Promise<ResultadoCopia[]> {
  const out: ResultadoCopia[] = [];
  for (const pedido of pedidos) {
    let resultado: ResultadoCopia;
    try {
      const { cuerpo } = await postForm(
        `${BASE}/${pedido.objectId}/copies`,
        accountId,
        camposDe(pedido),
        TIMEOUT_SINCRONICO,
      );
      resultado = clasificarSincronica(pedido, cuerpo, null);
    } catch (e) {
      resultado = clasificarSincronica(pedido, null, e as MetaAdsError);
    }
    out.push(resultado);
    // R16 c5, R17 c17: cuota (613) corta el lote; el llamador rellena los
    // pedidos restantes como no intentados.
    if (resultado.estado === 'fallido' && resultado.error.code === 613) break;
  }
  return out;
}

/**
 * La rama batch, DETRÁS de `leerResultadoBatch`: la forma del sobre se ajusta
 * con la salida de verificar-copies-ads.ts sin tocar nada más. Hoy:
 *   - se postea `/{cuenta}/async_batch_requests` con las sub-peticiones (≤50
 *     por llamada, partiendo si hacen falta más);
 *   - se sondea `/{async_batch_id}` hasta 300 s (R10 c8);
 *   - los cuerpos por sub-petición se leen de `/{async_batch_id}/requests` y se
 *     clasifican con el MISMO intérprete que la rama sincrónica;
 *   - si el sobre no se deja leer, cada pedido queda `indeterminado` con su
 *     `handle` para el sondeo posterior.
 */
async function duplicarPorBatch(
  accountId: string,
  pedidos: readonly PedidoCopia[],
): Promise<ResultadoCopia[]> {
  const resultados = new Map<string, ResultadoCopia>();
  let cortado = false;
  for (let i = 0; i < pedidos.length && !cortado; i += MAX_SUBPETICIONES) {
    const chunk = pedidos.slice(i, i + MAX_SUBPETICIONES);
    let handle: string | null = null;
    try {
      const sub = chunk.map((p) => ({
        method: 'POST',
        relative_url: `${p.objectId}/copies`,
        body: new URLSearchParams(camposDe(p)).toString(),
        name: `copia-${p.objectId}`,
      }));
      const { cuerpo } = await postForm(
        `${BASE}/${accountId}/async_batch_requests`,
        accountId,
        { batch: JSON.stringify(sub), include_headers: 'false' },
        TIMEOUT_SINCRONICO,
      );
      handle =
        typeof cuerpo?.async_batch_id === 'string'
          ? cuerpo.async_batch_id
          : typeof cuerpo?.id === 'string'
            ? cuerpo.id
            : null;
      await leerResultadoBatch(accountId, handle, chunk, resultados);
      // Cuota (613) en una sub-petición: el lote se detiene (R16 c5, R17 c17).
      for (const p of chunk) {
        const r = resultados.get(p.objectId);
        if (r && r.estado === 'fallido' && r.error.code === 613) {
          cortado = true;
          break;
        }
      }
    } catch {
      // El sobre no se dejó leer: todos quedan indeterminados con el handle.
      for (const p of chunk) {
        resultados.set(p.objectId, {
          estado: 'indeterminado',
          error: new MetaAdsError(
            'el resultado del batch no se pudo leer (D-01: forma del sobre pendiente de verificar-copies-ads.ts)',
          ),
          creados: [],
          handle,
        });
      }
    }
  }
  return pedidos
    .map((p) => resultados.get(p.objectId))
    .filter((r): r is ResultadoCopia => r !== undefined);
}

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Sondea el lote y clasifica cada sub-petición. Única responsabilidad: SI la
 * forma del sobre cambia con la versión de la API, este es el único lugar que
 * se toca (D-01).
 */
export async function leerResultadoBatch(
  accountId: string,
  handle: string | null,
  pedidos: readonly PedidoCopia[],
  resultados: Map<string, ResultadoCopia>,
): Promise<void> {
  if (!handle) {
    for (const p of pedidos) {
      resultados.set(p.objectId, {
        estado: 'indeterminado',
        error: new MetaAdsError('el batch no devolvió identificador de sondeo'),
        creados: [],
        handle: null,
      });
    }
    return;
  }

  let completo = false;
  for (let t = 0; t < 60 && !completo; t++) {
    await esperar(5_000);
    try {
      const { cuerpo } = await postForm(`${BASE}/${handle}?fields=status`, accountId, {});
      const status = typeof cuerpo?.status === 'string' ? cuerpo.status : null;
      if (status === 'COMPLETE' || status === 'FAILED') completo = true;
    } catch {
      // seguimos sondeando hasta el presupuesto
    }
  }

  // Los cuerpos por sub-petición, si la edge es legible.
  let porPeticion: Record<string, unknown>[] = [];
  try {
    const { cuerpo } = await postForm(`${BASE}/${handle}/requests`, accountId, {});
    porPeticion = Array.isArray(cuerpo?.data) ? (cuerpo!.data as Record<string, unknown>[]) : [];
  } catch {
    porPeticion = [];
  }

  for (const p of pedidos) {
    const sub = porPeticion.find((s) => s.name === `copia-${p.objectId}`);
    if (!sub) {
      resultados.set(p.objectId, {
        estado: 'indeterminado',
        error: new MetaAdsError('el resultado del batch no trae la sub-petición de esta copia'),
        creados: [],
        handle,
      });
      continue;
    }
    const creados = extraerIdsDeRespuesta(sub.body ?? sub);
    if (creados.length === 0) {
      resultados.set(p.objectId, {
        estado: 'indeterminado',
        error: new MetaAdsError('la sub-petición del batch no trae ids de objetos creados'),
        creados,
        handle,
      });
    } else if (creados.length < p.objetosEsperados) {
      resultados.set(p.objectId, {
        estado: 'indeterminado',
        error: new MetaAdsError(`el batch trae ${creados.length} de los ${p.objetosEsperados} objetos esperados`),
        creados,
        handle,
      });
    } else {
      resultados.set(p.objectId, { estado: 'confirmado', creados });
    }
  }
}
