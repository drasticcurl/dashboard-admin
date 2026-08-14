/**
 * Contratos CONGELADOS del rediseño (plan §4 y §5).
 *
 * Este archivo lo escribe T01 y NINGUNA otra task lo modifica: lo importan
 * T02, T03, T04, T05, T06 y T07. Un cambio acá después de que arranque la
 * ola A rompe tres tasks a la vez; si un tipo te parece incompleto, se anota
 * en §10 del plan y no se completa por tu cuenta.
 *
 * Las cinco reglas de implementación de §4, las que más se van a
 * malinterpretar:
 *
 * 1. Un `id` no se renombra nunca: es la clave del layout que el usuario ya
 *    guardó. Si se renombra, el widget desaparece de su pantalla sin
 *    explicación. Para cambiar el nombre visible se cambia `label`, que es
 *    para eso.
 * 2. Un widget nunca hace fetch: recibe `data` por parámetro. Con 25 widgets
 *    pidiendo lo suyo serían 25 requests por cambio de rango.
 * 3. `render` recibe el `size` y lo usa: un widget en 2x2 no es el de 1x1 más
 *    grande, muestra más. Un KPI en 1x1 es número + label; en 2x1 agrega el
 *    sub y el trend; en 2x2 agrega un sparkline.
 * 4. Un `id` del layout que no está en el catálogo se ignora y se avisa: se
 *    descarta esa entrada, se muestran los demás y la barra dice "1 widget
 *    guardado ya no existe". No se tira: la pantalla no puede quedar en
 *    blanco por un layout viejo.
 * 5. `tamañosPermitidos` se respeta en la UI: el menú de tamaño de un widget
 *    sólo ofrece los suyos.
 */

import type { ReactNode } from 'react';

/** Los cuatro tamaños de D-R03. `w` y `h` en celdas de la grilla. */
export type WidgetSize = { w: 1 | 2; h: 1 | 2 };

/** Una entrada del layout guardado. El ORDEN del array es el orden en pantalla. */
export type WidgetPlacement = { id: string; w: 1 | 2; h: 1 | 2 };

/** Lo que se guarda en settings.ui_layout_*. `v` permite migrar el formato. */
export type WidgetLayout = { v: 1; widgets: WidgetPlacement[] };

/**
 * La definición de un widget en el catálogo de una pantalla.
 *
 * `render` recibe los datos YA CARGADOS de la pantalla: un widget no hace su
 * propio fetch. Con 25 widgets, cada uno pidiendo lo suyo serían 25 requests
 * por cambio de rango y el panel se caería solo.
 */
export type WidgetDef<TData> = {
  id: string;               // estable y para siempre: es la clave del layout guardado
  label: string;            // el nombre en la lista de widgets
  hint?: string;            // qué significa la métrica, para el tooltip
  grupo: WidgetGrupo;       // para agrupar la lista de widgets
  tamañoPorDefecto: WidgetSize;
  /** Tamaños que este widget acepta. Un gráfico no tiene sentido en 1x1. */
  tamañosPermitidos: WidgetSize[];
  render: (data: TData, size: WidgetSize) => ReactNode;
};

export type WidgetGrupo = 'plata' | 'volumen' | 'eficiencia' | 'calidad' | 'graficos' | 'listas';

/** El catálogo de una pantalla. La clave es el `id`, para resolver el layout. */
export type WidgetCatalogo<TData> = Record<string, WidgetDef<TData>>;

/** Una parte del embudo: un grupo de pasos contiguos, o un hito. */
export type EmbudoEtapa = {
  stageOrder: number;
  label: string;
  /** Los pasos que la etapa contiene, en orden. Vacío para las etapas de hito. */
  slugs: string[];
  /** De dónde salió el conteo. La UI lo muestra: no es lo mismo un paso que un hito. */
  fuente: 'paso' | 'hito';
  /** Sesiones que completaron la etapa: el conteo de su ÚLTIMO paso (D-R08). */
  sessions: number;
  /** % sobre la etapa base (la primera). 0-100, ya multiplicado. */
  pctOfBase: number;
  /** % sobre la etapa anterior. 0-100. La primera etapa devuelve 100. */
  pctOfPrevious: number;
  /** Caída contra la anterior, en puntos. La primera devuelve 0. */
  dropFromPrevious: number;
  /**
   * ANCHO con el que se dibuja el trapecio, 0-100. Recortado al de la etapa
   * anterior cuando `sessions` la supera (D-R09). Distinto de `pctOfBase`
   * SÓLO en ese caso, y por eso son dos campos y no uno.
   */
  anchoDibujo: number;
  /**
   * true cuando `sessions` superó a la etapa anterior. La UI muestra una marca
   * visible: sin esto el usuario ve un número que no cierra con el dibujo.
   */
  inconsistente: boolean;
};

/** Se agrega a FunnelData sin tocar los campos que ya tiene. */
export type EmbudoPorEtapas = {
  etapas: EmbudoEtapa[];
  /** Etapas configuradas que apuntan a un slug que ya no existe (D-R07). */
  huerfanas: { stageOrder: number; label: string; slugFaltante: string }[];
};
