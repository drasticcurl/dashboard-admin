/**
 * Catalogo_Metricas (task 3.1 de gestion-campanas-anuncios): la declaración
 * tipada y cerrada de las 27 columnas que la Tabla_Anuncios puede mostrar, y la
 * ÚNICA fuente de verdad de su rótulo, alineación, formato, definición, niveles
 * y ordenabilidad. La Vista, el ConfiguradorColumnas, los encabezados, la
 * Previsualizacion y el formateo de celdas leen de acá: agregar una métrica es
 * agregar una entrada (decisión estructural §4 del design).
 *
 * PURA: no importa `pg` ni toca la red. Los formateadores vienen de
 * `components/ui.tsx` (importar no modifica el archivo), así que el formato de
 * número es el mismo en las 14 pantallas.
 *
 * Desvío D-07: el catálogo tiene 27 entradas y no 12. Las 12 de R2 c2 llevan
 * `base: true` y son (a) lo que el configurador muestra tildado de fábrica,
 * (b) el fallback de R2 c11 y (c) lo que aplica el fallback de R3 c9.
 *
 * Desvío D-06: ROI se muestra como porcentaje (×100) mientras el contrato y las
 * reglas usan la escala de múltiplo. La definición de la columna lleva el
 * puente.
 */

import { fmtDateTime, fmtInt, fmtMoney, fmtPct } from '@/components/ui';
import type { ClaveOrden, MetricasObjeto, NivelAds } from './tipos';

export type FormatoMetrica = 'texto' | 'fecha' | 'entero' | 'eur' | 'porcentaje' | 'multiplicador';
export type AlineacionMetrica = 'izquierda' | 'derecha' | 'centro';

export type EntradaCatalogo = {
  /** Clave estable e invariante entre sesiones y despliegues (R2 c1). */
  clave: ClaveOrden | 'seleccion';
  /** 1 a 40 caracteres, en castellano (R2 c1). */
  rotulo: string;
  alineacion: AlineacionMetrica;
  formato: FormatoMetrica;
  /** 1 a 240 caracteres (R2 c1). Es el tooltip de R2 c10. */
  definicion: string;
  /** En qué niveles existe. Fuera de esos niveles la celda es `—` (R2 c8). */
  niveles: readonly NivelAds[];
  /** Si el encabezado acepta orden (R4 c1, c11). */
  ordenable: boolean;
  /** Columna_Fija: siempre visible, no desmarcable, a la izquierda (R2 c4). */
  fija?: true;
  /** Del conjunto base de las doce de R2 c2: lo que se muestra sin Vista. */
  base?: true;
  /** Metricas_Rango: obliga a asegurarAlcance antes de leer (R7 c5). */
  rango?: true;
  /** Campo de la Marketing API que la alimenta, y si tiene retiro anunciado (R7 c12). */
  campoApi?: string;
  retiroAnunciado?: boolean;
};

/** Una columna visible en la Tabla_Anuncios: clave + ancho en píxeles (48..640). */
export type ColumnaVisible = { clave: string; ancho: number };

const NIVELES_TODOS: readonly NivelAds[] = ['campaign', 'adset', 'ad'];

/**
 * Las 27 entradas, en el orden declarado. El orden ES el orden del fallback de
 * R2 c11 (las doce base primero, tal como se muestran hoy).
 */
export const CATALOGO_METRICAS: readonly EntradaCatalogo[] = [
  {
    clave: 'seleccion',
    rotulo: 'Seleccionar',
    alineacion: 'centro',
    formato: 'texto',
    definicion: 'Checkbox de selección: tilda el objeto para las Accion_Lote del nivel activo.',
    niveles: NIVELES_TODOS,
    ordenable: false,
    fija: true,
    base: true,
  },
  {
    clave: 'nombre',
    rotulo: 'Nombre',
    alineacion: 'izquierda',
    formato: 'texto',
    definicion: 'Nombre del objeto tal como está configurado en Meta. Al activarlo baja al nivel de abajo con ese objeto como Filtro_Cascada.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    fija: true,
    base: true,
  },
  {
    clave: 'estado',
    rotulo: 'Estado',
    alineacion: 'izquierda',
    formato: 'texto',
    definicion: 'Estado configurado del objeto (ACTIVE/PAUSED) y su estado efectivo, que es el que Meta dice que ocurre de verdad. El estado no es una Columna_Fija: se puede ocultar.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    base: true,
  },
  {
    clave: 'presupuesto',
    rotulo: 'Presupuesto',
    alineacion: 'derecha',
    formato: 'eur',
    definicion: 'Presupuesto diario en EUR del objeto que lo administra. Este panel edita únicamente presupuestos diarios: un presupuesto total se muestra pero no se edita.',
    niveles: ['campaign', 'adset'],
    ordenable: true,
    base: true,
  },
  {
    clave: 'ultimaActualizacion',
    rotulo: 'Últ. actualización',
    alineacion: 'izquierda',
    formato: 'fecha',
    definicion: 'Fecha y hora de la acción real más reciente registrada en el historial sobre este objeto, sobre todo el vocabulario de acciones (pausar, activar, presupuesto, duplicar, renombrar, programar).',
    niveles: NIVELES_TODOS,
    ordenable: true,
    base: true,
  },
  {
    clave: 'ventas',
    rotulo: 'Ventas',
    alineacion: 'derecha',
    formato: 'entero',
    definicion: 'Órdenes aprobadas del período atribuidas a este objeto por los UTMs de la campaña, el conjunto y el anuncio.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    base: true,
  },
  {
    clave: 'cpa',
    rotulo: 'CPA',
    alineacion: 'derecha',
    formato: 'eur',
    definicion: 'Costo por adquisición: gasto en EUR del período dividido ventas del período. Sin valor cuando no hubo ventas.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    base: true,
  },
  {
    clave: 'gastos',
    rotulo: 'Gastos',
    alineacion: 'derecha',
    formato: 'eur',
    definicion: 'Gasto de Meta del período en EUR, sumado por día y por objeto.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    base: true,
  },
  {
    clave: 'ingresos',
    rotulo: 'Ingresos',
    alineacion: 'derecha',
    formato: 'eur',
    definicion: 'Ingresos brutos aprobados del período atribuidos a este objeto.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    base: true,
  },
  {
    clave: 'ganancia',
    rotulo: 'Ganancia',
    alineacion: 'derecha',
    formato: 'eur',
    definicion: 'Neto menos gasto de ads: lo que queda después de descuentos, comisiones, costos y la publicidad de este objeto.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    base: true,
  },
  {
    clave: 'roas',
    rotulo: 'ROAS',
    alineacion: 'derecha',
    formato: 'multiplicador',
    definicion: 'Ingresos brutos dividido gasto de ads. Multiplicador: 2,00 significa que cada euro de ads devolvió 2 de ingresos.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    base: true,
  },
  {
    clave: 'roi',
    rotulo: 'ROI',
    alineacion: 'derecha',
    formato: 'porcentaje',
    definicion: 'ROI = neto ÷ gasto de ads, mostrado ×100. Las reglas usan la escala de múltiplo: 110 % acá es 1,10 en una condición.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    base: true,
  },
  {
    clave: 'impresiones',
    rotulo: 'Impresiones',
    alineacion: 'derecha',
    formato: 'entero',
    definicion: 'Suma de impresiones del período (totales del período, nunca un promedio de los valores diarios).',
    niveles: NIVELES_TODOS,
    ordenable: true,
  },
  {
    clave: 'clics',
    rotulo: 'Clics',
    alineacion: 'derecha',
    formato: 'entero',
    definicion: 'Suma de clics del período, agregada sobre los totales diarios.',
    niveles: NIVELES_TODOS,
    ordenable: true,
  },
  {
    clave: 'ctr',
    rotulo: 'CTR',
    alineacion: 'derecha',
    formato: 'porcentaje',
    definicion: 'Clics dividido impresiones y multiplicado por cien, sobre los totales del período, con dos decimales.',
    niveles: NIVELES_TODOS,
    ordenable: true,
  },
  {
    clave: 'cpc',
    rotulo: 'CPC',
    alineacion: 'derecha',
    formato: 'eur',
    definicion: 'Costo por clic: gasto en EUR del período dividido clics del período.',
    niveles: NIVELES_TODOS,
    ordenable: true,
  },
  {
    clave: 'cpm',
    rotulo: 'CPM',
    alineacion: 'derecha',
    formato: 'eur',
    definicion: 'Costo por mil impresiones: gasto en EUR del período dividido impresiones del período y multiplicado por mil.',
    niveles: NIVELES_TODOS,
    ordenable: true,
  },
  {
    clave: 'alcance',
    rotulo: 'Alcance',
    alineacion: 'derecha',
    formato: 'entero',
    definicion: 'Personas alcanzadas en el rango completo, pedido a Meta sin desglose diario porque el alcance no es aditivo entre días: sólo hay número cuando el período pedido coincide exactamente con un rango guardado.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    rango: true,
  },
  {
    clave: 'frecuencia',
    rotulo: 'Frecuencia',
    alineacion: 'derecha',
    formato: 'multiplicador',
    definicion: 'Impresiones del rango completo dividido alcance del rango, con dos decimales. Como el alcance, sólo existe para el rango exacto guardado.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    rango: true,
  },
  {
    clave: 'videoReproducciones',
    rotulo: 'Reproducciones',
    alineacion: 'derecha',
    formato: 'entero',
    definicion: 'Reproducciones de video (video_play_actions), sumadas por día en el período. Los conteos de video son aditivos entre días.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    campoApi: 'video_play_actions',
    retiroAnunciado: false,
  },
  {
    clave: 'videoThruplay',
    rotulo: 'ThruPlay',
    alineacion: 'derecha',
    formato: 'entero',
    definicion: 'Reproducciones de video completadas (video_thruplay_watched_actions), sumadas por día en el período.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    campoApi: 'video_thruplay_watched_actions',
    retiroAnunciado: false,
  },
  {
    clave: 'videoP25',
    rotulo: 'Video 25 %',
    alineacion: 'derecha',
    formato: 'entero',
    definicion: 'Reproducciones que alcanzaron el 25 % del video (video_p25_watched_actions), sumadas por día.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    campoApi: 'video_p25_watched_actions',
    retiroAnunciado: false,
  },
  {
    clave: 'videoP50',
    rotulo: 'Video 50 %',
    alineacion: 'derecha',
    formato: 'entero',
    definicion: 'Reproducciones que alcanzaron el 50 % del video (video_p50_watched_actions), sumadas por día.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    campoApi: 'video_p50_watched_actions',
    retiroAnunciado: false,
  },
  {
    clave: 'videoP75',
    rotulo: 'Video 75 %',
    alineacion: 'derecha',
    formato: 'entero',
    definicion: 'Reproducciones que alcanzaron el 75 % del video (video_p75_watched_actions), sumadas por día.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    campoApi: 'video_p75_watched_actions',
    retiroAnunciado: false,
  },
  {
    clave: 'videoP100',
    rotulo: 'Video 100 %',
    alineacion: 'derecha',
    formato: 'entero',
    definicion: 'Reproducciones que alcanzaron el 100 % del video (video_p100_watched_actions), sumadas por día.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    campoApi: 'video_p100_watched_actions',
    retiroAnunciado: false,
  },
  {
    clave: 'hookRate',
    rotulo: 'Hook rate (reproducciones ÷ impresiones)',
    alineacion: 'derecha',
    formato: 'porcentaje',
    definicion: 'Reproducciones de video (video_play_actions) sobre impresiones del período, ×100. No es el hook rate del administrador de anuncios, que usa la vista de 3 segundos: esa métrica vive en el desglose por tipo de acción y tiene retiro anunciado.',
    niveles: NIVELES_TODOS,
    ordenable: true,
    campoApi: 'video_play_actions',
    retiroAnunciado: false,
  },
  {
    clave: 'inicioProgramado',
    rotulo: 'Inicio programado',
    alineacion: 'izquierda',
    formato: 'fecha',
    definicion: 'Fecha y hora de inicio programado del objeto, expresada en la zona horaria de la cuenta, tal como Meta la devuelve. Vacía cuando Meta no devuelve un inicio programado.',
    niveles: ['campaign', 'adset'],
    ordenable: true,
  },
];

/** Las dos Columna_Fija, en orden canónico (R2 c4, glosario). */
export const CLAVES_FIJAS = ['seleccion', 'nombre'] as const;

/** Las doce entradas del conjunto base de R2 c2, en el orden del catálogo. */
export const CLAVES_BASE: readonly string[] = CATALOGO_METRICAS.filter((e) => e.base).map(
  (e) => e.clave,
);

/** La entrada de una clave, o undefined cuando la clave no existe (R2 c13). */
export function entrada(clave: string): EntradaCatalogo | undefined {
  return CATALOGO_METRICAS.find((e) => e.clave === clave);
}

const fmtMultiplicador = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formateo total de una celda (R2 c9, c12, R7 c3, c14). `null`, `undefined`,
 * `NaN` e `Infinity` → `'—'`. Todo número finito —INCLUIDO el cero— se formatea
 * con el formato declarado, con coma decimal es-AR y dos decimales en los
 * importes en EUR, y nunca es `'—'`.
 */
export function formatear(e: EntradaCatalogo, valor: unknown): string {
  if (valor === null || valor === undefined) return '—';
  if (typeof valor === 'number' && !Number.isFinite(valor)) return '—';

  switch (e.formato) {
    case 'texto':
      return String(valor);
    case 'fecha': {
      const iso = typeof valor === 'number' ? new Date(valor).toISOString() : String(valor);
      return fmtDateTime(iso);
    }
    case 'entero':
      return typeof valor === 'number' ? fmtInt(valor) : '—';
    case 'eur':
      return typeof valor === 'number' ? fmtMoney(valor, 'EUR') : '—';
    case 'porcentaje':
      // Presentación ×100: el contrato guarda el cociente (D-06, R7 c1).
      return typeof valor === 'number' ? fmtPct(valor * 100, 2) : '—';
    case 'multiplicador':
      return typeof valor === 'number' ? fmtMultiplicador.format(valor) : '—';
  }
}

/**
 * El valor crudo de una fila para una clave del catálogo. Es la ÚNICA función
 * que conoce el mapeo clave → campo de `MetricasObjeto`: `celdasDeFila` y
 * `comparadorOrden` la usan para no duplicar el mapeo en dos lugares.
 */
export function valorDeMetrica(fila: MetricasObjeto, clave: ClaveOrden): number | string | null {
  switch (clave) {
    case 'nombre': return fila.objectName;
    case 'estado': return fila.status;
    case 'ultimaActualizacion': return fila.ultimaAccionAt;
    case 'inicioProgramado': return fila.inicioProgramado;
    case 'presupuesto': return fila.dailyBudgetEur;
    case 'ventas': return fila.sales;
    case 'cpa': return fila.cpaEur;
    case 'gastos': return fila.spendEur;
    case 'ingresos': return fila.revenueEur;
    case 'ganancia': return fila.profitEur;
    case 'roas': return fila.roas;
    case 'roi': return fila.roi;
    case 'impresiones': return fila.impressions;
    case 'clics': return fila.clicks;
    case 'ctr': return fila.ctr;
    case 'cpc': return fila.cpcEur;
    case 'cpm': return fila.cpmEur;
    case 'alcance': return fila.alcance;
    case 'frecuencia': return fila.frecuencia;
    case 'hookRate': return fila.hookRate;
    case 'videoReproducciones': return fila.videoReproducciones;
    case 'videoThruplay': return fila.videoThruplay;
    case 'videoP25': return fila.videoP25;
    case 'videoP50': return fila.videoP50;
    case 'videoP75': return fila.videoP75;
    case 'videoP100': return fila.videoP100;
  }
}

/** Anchos de arranque cuando la configuración no declara uno para una fija. */
const ANCHO_DEFECTO: Record<(typeof CLAVES_FIJAS)[number], number> = {
  seleccion: 48,
  // El Gestor reemplaza esto por el 25 % del ancho visible cuando la Vista no
  // lo declara (R5 c8); acá es un valor de arranque razonable.
  nombre: 280,
};

/**
 * La configuración de columnas resuelta para pintar: claves ajenas al catálogo
 * descartadas (R2 c13), sin repetidas, y las dos Columna_Fija forzadas a las
 * dos posiciones de más a la izquierda (R2 c4, c6). El resto conserva el orden
 * de la configuración.
 */
export function columnasParaRender(
  configuracion: readonly { clave: string; ancho: number }[],
  catalogo: readonly EntradaCatalogo[] = CATALOGO_METRICAS,
): ColumnaVisible[] {
  const conocidas = new Set<string>(catalogo.map((e) => e.clave));
  const vistas: ColumnaVisible[] = [];
  const vistasClaves = new Set<string>();
  for (const c of configuracion) {
    if (!conocidas.has(c.clave) || vistasClaves.has(c.clave)) continue;
    vistasClaves.add(c.clave);
    vistas.push({ clave: c.clave, ancho: c.ancho });
  }

  const noFijas = vistas.filter((c) => !CLAVES_FIJAS.includes(c.clave as (typeof CLAVES_FIJAS)[number]));
  const fijas: ColumnaVisible[] = CLAVES_FIJAS.map((clave) => {
    const propia = vistas.find((c) => c.clave === clave);
    return propia ?? { clave, ancho: ANCHO_DEFECTO[clave] };
  });
  return [...fijas, ...noFijas];
}

/**
 * Las celdas de una fila para las columnas visibles, en el MISMO orden y con la
 * MISMA cantidad que el encabezado (invariante de R2 c7, Property 1). Una
 * columna cuyo nivel no la expone da `—` y conserva su lugar (R2 c8).
 */
export function celdasDeFila(
  columnas: readonly ColumnaVisible[],
  fila: MetricasObjeto,
  catalogo: readonly EntradaCatalogo[] = CATALOGO_METRICAS,
): string[] {
  return columnas.map((c) => {
    if (c.clave === 'seleccion') return ''; // el checkbox lo pinta TablaAds
    const e = entrada(c.clave);
    if (!e) return '—';
    if (!e.niveles.includes(fila.level)) return '—';
    return formatear(e, valorDeMetrica(fila, c.clave as ClaveOrden));
  });
}
