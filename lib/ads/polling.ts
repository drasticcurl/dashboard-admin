'use client';

/**
 * Polling del gasto de anuncios: el disparador que faltaba.
 *
 * EL PROBLEMA
 * `lib/ads/live.ts` ya refresca el gasto con un TTL de 60 s, pero solo corre
 * DENTRO de un request. Y en el panel no había ningún request periódico: las
 * tres pantallas que muestran gasto (Resumen, Ventas, Anuncios) refetchean
 * cuando cambia el rango, el funnel o un filtro, y nada más. Con una pestaña
 * abierta mirando "hoy", el número se congelaba en el valor del primer render y
 * el único camino era F5 (o el Boton_Actualizar de Anuncios). El TTL de 60 s
 * existía y no servía de nada: nadie llegaba a consultarlo.
 *
 * CÓMO
 * Un `setInterval` por pantalla que repite el mismo fetch de datos que ya
 * existe. El refresco del gasto viaja de arriba: el route llama a
 * `ensureFreshAdSpend`, así que un pedido más es, además, un sync más.
 *
 * Tres cosas que este hook hace y que un setInterval pelado no:
 *
 *   1. Se frena con la pestaña oculta (`document.hidden`). Diez pestañas de
 *      fondo no pueden multiplicar por diez las llamadas a Meta. Al volver a la
 *      pestaña, si el último tick quedó viejo, dispara enseguida en vez de
 *      esperar el intervalo entero (los browsers frenan los timers de las
 *      pestañas de fondo, así que sin esto volver después de un rato mostraba
 *      un número viejo por un minuto más).
 *   2. Cede ante lo que esté pasando (`pausado`): un diálogo abierto, una
 *      acción de lote en vuelo o un pedido ya abierto. El polling es lo menos
 *      importante de la pantalla y nunca puede moverle la mesa al usuario.
 *   3. El callback vive en un ref, así que cambiar de filtro no reinicia el
 *      intervalo (si no, cada tecla en el buscador de nombre correría el reloj).
 *
 * QUIÉN FRENA A META
 * No este hook: el TTL del server (`ADS_LIVE_TTL_SECONDS`), que se compara
 * contra `ad_accounts.last_sync_at` y por lo tanto es global a todas las
 * pestañas y todos los usuarios. Bajar el intervalo de acá sube los requests al
 * panel y las consultas a la base, NO las llamadas a Meta. Por eso el mínimo de
 * este archivo es holgado.
 */

import { useEffect, useRef } from 'react';

/** El intervalo por defecto, en segundos. */
export const SEGUNDOS_POLLING_DEFAULT = 60;

/**
 * Piso del intervalo. No protege a Meta (eso es el TTL del server): protege al
 * panel y a la base de un valor puesto de más en el env.
 */
export const SEGUNDOS_POLLING_MINIMO = 15;

/**
 * Cada cuánto se repite el pedido, en segundos.
 *
 * `NEXT_PUBLIC_ADS_POLL_SECONDS` se inyecta en el bundle EN EL BUILD (es la
 * regla de las NEXT_PUBLIC_ de Next), no se lee en caliente: cambiarla necesita
 * un deploy. El valor que sí se puede mover sin build es el TTL del server.
 *
 * `0` apaga el polling. Un valor que no es número cae al default a propósito:
 * un typo en el env no puede apagar el refresco en silencio, que es justo el
 * bug que este archivo vino a arreglar.
 */
export function segundosDePollingGasto(): number {
  const crudo = process.env.NEXT_PUBLIC_ADS_POLL_SECONDS?.trim();
  if (!crudo) return SEGUNDOS_POLLING_DEFAULT;
  const n = Number(crudo);
  if (!Number.isFinite(n)) return SEGUNDOS_POLLING_DEFAULT;
  if (n <= 0) return 0;
  return Math.max(SEGUNDOS_POLLING_MINIMO, Math.round(n));
}

/**
 * Repite `onTick` cada `segundos` mientras la pestaña esté visible.
 *
 * `pausado` corta el tick sin desarmar el intervalo: cuando se despausa, el
 * siguiente tick cae en su horario y no hay que reconstruir nada.
 */
export function usePollingGasto(
  onTick: () => void,
  opts?: { pausado?: boolean; segundos?: number },
): void {
  const segundos = opts?.segundos ?? segundosDePollingGasto();
  const pausado = opts?.pausado ?? false;

  // El callback cierra sobre los filtros y el estado de la pantalla, así que
  // cambia en cada render. Va a un ref para que eso no reinicie el intervalo.
  const cb = useRef(onTick);
  useEffect(() => {
    cb.current = onTick;
  }, [onTick]);

  const pausadoRef = useRef(pausado);
  useEffect(() => {
    pausadoRef.current = pausado;
  }, [pausado]);

  const ultimoTick = useRef<number>(Date.now());

  useEffect(() => {
    if (segundos <= 0) return;
    const ms = segundos * 1000;

    const disparar = (): void => {
      if (pausadoRef.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      ultimoTick.current = Date.now();
      cb.current();
    };

    const id = setInterval(disparar, ms);

    const alVolver = (): void => {
      if (document.hidden) return;
      if (Date.now() - ultimoTick.current >= ms) disparar();
    };
    document.addEventListener('visibilitychange', alVolver);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, [segundos]);
}

/**
 * Lo que hace falta para contar una antigüedad: los dos campos que `FrescuraAds`
 * (lib/ads/live.ts) y `FrescuraJerarquia` (lib/ads/liveJerarquia.ts) tienen
 * iguales.
 *
 * Es la forma común y no una unión de los dos tipos. `textoEdad` lee `ageSeconds`
 * y `error`, los dos los declaran idénticos, y una unión obligaría a tocar esta
 * firma cada vez que aparezca una tercera sincronización. La compatibilidad la
 * verifica TypeScript en el llamador, que es donde está el tipo concreto.
 *
 * Además desacopla: este módulo es `'use client'` y así no nombra dos módulos de
 * server que hablan con la base.
 */
export type FrescuraLeible = {
  /** Antigüedad en segundos que calculó el server, null si nunca se sincronizó. */
  ageSeconds: number | null;
  /** Error de la última corrida, si hay. */
  error: string | null;
};

/**
 * La antigüedad de una sincronización en palabras, del valor que calculó el
 * server.
 *
 * Se llamaba `textoEdadGasto` y dejó de ser sólo del gasto (task 11 de
 * frescura-y-acciones-anuncios): la usan la Marca_Frescura del gasto (R1 c6), el
 * sub del widget de gasto de Ventas, el Resumen, y ahora también la edad de la
 * Jerarquía en la barra del gestor (R4.5). Una sola función para que las tres
 * pantallas —y las dos sincronizaciones— digan lo mismo con las mismas palabras:
 * dos edades que hay que comparar de un vistazo no pueden estar escritas en dos
 * vocabularios.
 *
 * `error` gana sobre la edad, y no es un descuido. Las dos frescuras avanzan su
 * reloj TAMBIÉN cuando la corrida falla (`syncAdSpend` escribe `last_sync_at`,
 * `anotarCorrida` escribe `last_hierarchy_sync_at`), para que el TTL siga
 * frenando mientras Meta rechaza llamadas. O sea que con un error la edad dice
 * cuándo se INTENTÓ, no de cuándo es el dato: mostrar "al día" ahí sería
 * exactamente la mentira que este spec vino a sacar de la pantalla. Quien dibuja
 * pone el mensaje del error al lado.
 *
 * `null` significa "no hay dato que mostrar" y lo resuelve el llamador (la barra
 * y el Resumen ponen un guion). Nunca se confunde con "sincronizó recién": una
 * frescura que existe pero nunca sincronizó devuelve `'nunca sincronizado'`.
 *
 * No tiene reloj propio: se queda quieta hasta el próximo pedido, que con el
 * polling es como máximo un intervalo después.
 */
export function textoEdad(f: FrescuraLeible | null | undefined): string | null {
  if (!f) return null;
  if (f.error) return 'sync con error';
  const s = f.ageSeconds;
  if (s === null) return 'nunca sincronizado';
  if (s < 90) return 'al día';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86_400)} d`;
}

/**
 * @deprecated Alias de compatibilidad para el commit del spec
 * frescura-y-acciones-anuncios. `textoEdad` es el nombre nuevo (task 11).
 *
 * Existe sólo porque `app/(panel)/resumen/ResumenView.tsx` y
 * `lib/widgets/catalogo-ventas.tsx` quedaron fuera de ese commit: los dos ya
 * están actualizados en el árbol de trabajo, pero mezclados con el rediseño
 * visual, y arrastrar el rediseño para renombrar un import dejaría la mitad de
 * los tokens de sombra sin definir en producción.
 *
 * BORRAR cuando el rediseño se commitee: en ese momento los dos consumidores
 * pasan a importar `textoEdad` y este alias queda sin uso.
 */
export const textoEdadGasto = textoEdad;
