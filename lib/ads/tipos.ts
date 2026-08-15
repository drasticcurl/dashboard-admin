/**
 * Contratos del módulo de Anuncios (§4, §5 y §6 de 00-PLAN-ANUNCIOS.md).
 *
 * ESTE ARCHIVO ESTUVO CONGELADO hasta la spec gestion-campanas-anuncios
 * (P-G03 de su design.md). Esa spec lo extiende de forma ESTRICTAMENTE ADITIVA:
 * nada se quita, nada se renombra, ninguna semántica existente cambia. Las dos
 * reglas que hacen seguro el cambio:
 *   - todo campo nuevo de los tipos de SALIDA (`MetricasObjeto`,
 *     `ResultadoMetricas`) es OBLIGATORIO y `| null`: `filaDesdeRow` es el único
 *     productor y el compilador tiene que obligarlo a poblar cada campo. Un `?`
 *     acá dejaría una columna en `—` para siempre sin que nadie se entere.
 *   - todo campo nuevo de los tipos de ENTRADA (`FiltrosAds`) es OPCIONAL con
 *     `?`: hay muchos llamadores y cada filtro nuevo es opt-in.
 *
 * Acá viven SOLO tipos y firmas. Ninguna implementación: `getMetricasAds` se
 * implementa en `lib/queries/ads.ts` (T15), `evaluar` en `lib/ads/reglas/motor.ts`
 * (T16) y los lectores/escritores de Meta en `lib/ads/meta.ts` (T13).
 *
 * DOS ADVERTENCIAS QUE CUATRO TASKS VAN A LEER ACÁ Y NINGUNA VA A LEER EN sales.ts:
 *
 * 1. `roas` y `roi` NO son el `roi` de `lib/queries/sales.ts`. Allá `roi`
 *    significa `resultado / gasto_total` (con `resultado = neto − ads` y
 *    `gasto_total = comisiones + costos + ads`). Acá:
 *      roas = revenueEur / spendEur        (bruto sobre gasto de ads)
 *      roi  = netEur / spendEur            (neto sobre gasto de ads)
 *    Los dos son múltiplos, no porcentajes, y los umbrales del usuario (1.1 a
 *    1.3) están en esta escala. No repliques la fórmula de sales.ts.
 *
 * 2. `null` en una métrica significa "no se puede calcular", NUNCA cero. Un
 *    objeto con €0 de gasto no tiene ROI: si se devuelve `0`, la condición
 *    `ROI < 1.1` se cumple y una regla pausa un conjunto que todavía no gastó
 *    nada. Es el falso positivo más caro del motor.
 *
 * 3. Las unidades NO son uniformes entre contratos, y cada campo lo dice en su
 *    propio nombre:
 *    - `MetaCampaign`/`MetaAdSet` traen presupuestos en UNIDADES MÍNIMAS (tal
 *      como los devuelve Meta: 2500 = €25,00).
 *    - `MetricasObjeto.dailyBudgetEur`, `Regla.actionValue/budgetMax/budgetMin`
 *      y las condiciones están en EUR.
 *    - La conversión ×100 se hace UNA sola vez, en el borde contra la API (D-A6).
 */

// MetaAdsError es una clase de runtime (se usa `e instanceof MetaAdsError` en
// sync.ts) y vive en lib/ads/meta.ts. Acá se trae solo su TIPO para que
// ResultadoEscritura pueda referenciarlo. Es un import de solo-tipo en ambas
// direcciones (meta.ts importa los tipos de acá), así que no hay ciclo en runtime.
import type { MetaAdsError } from './meta';

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Contrato de las métricas por objeto
// ─────────────────────────────────────────────────────────────────────────────

export type NivelAds = 'campaign' | 'adset' | 'ad';

/** Una fila de la tabla del gestor y la entrada de una evaluación de regla. */
export type MetricasObjeto = {
  level: NivelAds;
  objectId: string;
  objectName: string | null;
  accountId: string;
  /** Los tres ids de la jerarquía, siempre poblados: permiten subir al padre. */
  campaignId: string;
  adsetId: string; // '' cuando level === 'campaign'
  adId: string; // '' cuando level !== 'ad'
  funnelId: number | null;

  status: string | null;
  effectiveStatus: string | null;
  /** Dónde vive el presupuesto de ESTE objeto. null = este nivel no lo maneja. */
  budgetLevel: 'campaign' | 'adset' | null;
  /**
   * Qué TIPO de presupuesto tiene el objeto donde vive.
   * 'daily'    → lo único que este módulo sabe escribir.
   * 'lifetime' → se muestra pero NO se edita, y las reglas de presupuesto lo
   *              omiten con motivo 'presupuesto_lifetime_no_soportado' (D-A10).
   * null       → este nivel no maneja presupuesto (siempre en los anuncios).
   */
  budgetMode: 'daily' | 'lifetime' | null;
  /** En EUR, ya dividido por 100. null = no tiene presupuesto propio. */
  dailyBudgetEur: number | null;

  spendEur: number;
  impressions: number;
  clicks: number;

  sales: number; // órdenes con status 'approved'
  revenueEur: number; // bruto aprobado
  refundedEur: number;
  commissionsEur: number;
  costsEur: number;
  netEur: number; // revenue − refunded − commissions − costs
  profitEur: number; // net − spend   ← la columna GANANCIA

  /** null cuando el denominador es 0. NUNCA 0 ni Infinity: null = "no se puede calcular". */
  roas: number | null; // revenue / spend
  roi: number | null; // net / spend
  cpaEur: number | null; // spend / sales
  ctr: number | null;
  cpcEur: number | null;

  /** Última acción real (no simulada) sobre este objeto. Columna ÚLT. ACTUALIZACIÓN. */
  ultimaAccionAt: string | null;

  // ── Agregados de gestion-campanas-anuncios (P-G03). OBLIGATORIOS y `| null`:
  // el compilador obliga a `filaDesdeRow` a poblarlos. ─────────────────────

  /** Metricas_Creativo derivadas. null = denominador cero (R7 c3). */
  cpmEur: number | null; // gasto × 1000 ÷ impresiones del período
  hookRate: number | null; // video_play_actions ÷ impresiones (cociente, se muestra ×100)

  /** Video. null = la Marketing API no devolvió el campo (R7 c8, c14). 0 = devolvió cero. */
  videoReproducciones: number | null;
  videoThruplay: number | null;
  videoP25: number | null;
  videoP50: number | null;
  videoP75: number | null;
  videoP100: number | null;

  /** Metricas_Rango. null = no hay fila para el (from,to) exacto (R7 c6). NUNCA sumadas. */
  alcance: number | null;
  frecuencia: number | null;

  /** Inicio programado que devolvió Meta, ISO 8601. null = sin inicio (R11 c8). */
  inicioProgramado: string | null;
};

export type PeriodoAds = 'today' | 'yesterday' | '7d' | '7d_excl_today';

/** Clave de columna del Catalogo_Metricas, reutilizada como clave de Orden_Tabla. */
export type ClaveOrden =
  | 'nombre' | 'estado' | 'ultimaActualizacion' | 'inicioProgramado'
  | 'presupuesto' | 'ventas' | 'cpa' | 'gastos' | 'ingresos' | 'ganancia'
  | 'roas' | 'roi' | 'impresiones' | 'clics' | 'ctr' | 'cpc' | 'cpm'
  | 'alcance' | 'frecuencia' | 'hookRate'
  | 'videoReproducciones' | 'videoThruplay'
  | 'videoP25' | 'videoP50' | 'videoP75' | 'videoP100';

export type FiltrosAds = {
  level: NivelAds;
  period: PeriodoAds;
  accountIds?: string[]; // vacío o ausente = todas las cuentas activas
  status?: 'active' | 'paused' | 'any';
  nombre?: string; // substring, case-insensitive
  campaignId?: string; // para bajar un nivel desde la tabla
  adsetId?: string;
  /**
   * Tope de filas. Default 500, máximo 1000. La respuesta siempre viene acotada
   * y la UI/motor saben si se cortó por `hayMas`.
   */
  limit?: number;

  // ── Agregados de gestion-campanas-anuncios (P-G03). OPCIONALES: cada
  // llamador opta por usarlos. ─────────────────────────────────────────────

  /** Filtro_Cascada por campaña. Hasta 50 ids. Ausente o vacío = sin cascada (R8 c11). */
  campaignIds?: string[];
  /** Filtro_Cascada por conjunto. Hasta 50 ids. */
  adsetIds?: string[];

  /**
   * Oculta las filas sin NINGÚN dato en el período: sin gasto y sin ventas. Una
   * fila con gasto y sin ventas SÍ tiene dato (está quemando plata) y no se
   * oculta nunca. Ausente = se muestran todas.
   */
  ocultarSinDatos?: boolean;
  /**
   * Oculta los conjuntos y anuncios cuyo PADRE está apagado, según el
   * `effective_status` que informa Meta (`CAMPAIGN_PAUSED`, `ADSET_PAUSED`). A
   * nivel campaña no aplica: una campaña no tiene padre. Ausente = todos.
   */
  ocultarPadreApagado?: boolean;

  /** Orden_Tabla. Default 'gastos' descendente cuando no se indica. */
  orderBy?: ClaveOrden;
  orderDir?: 'asc' | 'desc';
  /** Página 1-based (R4 c10). Si viene, `after` se ignora. */
  page?: number;

  /**
   * Las columnas visibles. Sirve para NO pedirle a Meta las Metricas_Rango
   * cuando ninguna Vista las muestra. Ausente = ninguna Metricas_Rango.
   */
  columnas?: ClaveOrden[];

  /**
   * @deprecated Cursor por objectId. Incompatible con Orden_Tabla (R4 c3).
   * Se conserva declarado para no romper llamadores; `page` lo reemplaza y
   * tiene precedencia. Se retira cuando no queden consumidores.
   */
  after?: string;
};

/** El retorno completo de `getMetricasAds`, extraído para que T15 y T16 lo usen igual. */
export type ResultadoMetricas = {
  filas: MetricasObjeto[];
  /** true si se alcanzó el `limit` y hay más filas detrás del cursor. */
  hayMas: boolean;
  /** Ventas del período que NO matchean ningún objeto. Se muestra, no se esconde (D-A8). */
  sinAtribuir: { sales: number; revenueEur: number };
  /**
   * El día (o rango) resuelto en la zona de la cuenta, para que la UI lo muestre.
   * `timezone` es UNA zona: la llamada tira si las cuentas alcanzadas mezclan
   * zonas (§4 punto 2).
   */
  rango: { from: string; to: string; timezone: string };
  generatedAt: string;

  // ── Agregados de gestion-campanas-anuncios (P-G03). OBLIGATORIOS: la
  // paginación por página no puede romperse en silencio. ───────────────────

  /** Total de filas que los filtros alcanzan, antes del recorte de página (R4 c10, c13). */
  total: number;
  /** Página devuelta, 1-based. */
  pagina: number;
  /** Páginas alcanzadas por los filtros vigentes. */
  totalPaginas: number;
  /** El Orden_Tabla con el que se resolvió, ya normalizado. */
  orden: { clave: ClaveOrden; dir: 'asc' | 'desc' };
  /** Cuando alguna Metricas_Rango se pidió y no se pudo traer. null = sin problema. */
  alcanceError: string | null;
};

export type FirmaGetMetricasAds = (f: FiltrosAds) => Promise<ResultadoMetricas>;

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Contrato del motor de reglas
// ─────────────────────────────────────────────────────────────────────────────

export type Regla = {
  id: number;
  name: string;
  enabled: boolean;
  dryRun: boolean;
  accountIds: string[];
  level: NivelAds;
  statusFilter: 'active' | 'paused' | 'any';
  nameFilter: string | null;
  nameFilterMode: 'contains' | 'not_contains';
  action: 'pause' | 'activate' | 'budget_increase' | 'budget_decrease';
  actionValue: number | null;
  actionUnit: 'percent' | 'fixed' | null;
  budgetMax: number | null;
  budgetMin: number | null;
  period: PeriodoAds;
  /** Sólo 'object' en esta versión (el CHECK ad_rules_mlevel_valido lo fuerza). */
  metricsLevel: 'object';
  everyMinutes: number;
  windowStart: string | null; // 'HH:MM'
  windowEnd: string | null; // 'HH:MM'
  maxRunsPerDay: number | null;
  cooldownMinutes: number;
  maxActionsPerObjectPerDay: number;
};

export type Condicion = {
  metric:
    | 'sales'
    | 'revenue'
    | 'spend'
    | 'net'
    | 'profit'
    | 'roi'
    | 'roas'
    | 'cpa'
    | 'budget'
    | 'impressions'
    | 'clicks'
    | 'ctr'
    | 'cpc';
  op: '>' | '>=' | '<' | '<=' | '=' | '!=';
  value: number;
};

export type MotivoOmision =
  | 'cooldown'
  | 'max_por_objeto'
  | 'techo_alcanzado'
  | 'piso_alcanzado'
  | 'sin_presupuesto_en_este_nivel'
  | 'ya_esta_en_ese_estado'
  | 'metrica_indefinida'
  | 'fuera_de_ventana_horaria'
  | 'presupuesto_bajo_el_minimo'
  /** El objeto tiene presupuesto TOTAL y este módulo sólo escribe diario (D-A10). */
  | 'presupuesto_lifetime_no_soportado'
  /** La cuenta no factura en EUR y el módulo no convierte monedas (D-A10). */
  | 'moneda_no_soportada'
  /** La regla alcanza cuentas en zonas distintas: "hoy" no es uno solo (§4.2). */
  | 'zonas_horarias_mezcladas'
  /** El pedido pasa `ads_max_daily_budget_eur` o el delta del tick (D-A9c). */
  | 'tope_absoluto'
  /** Quedó una mutación sin cerrar sobre este objeto: hay que reconciliar antes. */
  | 'resultado_indeterminado_previo';

export type ContextoEvaluar = {
  ahora: Date;
  /** En la zona de la cuenta, para la ventana horaria. */
  horaLocal: string;
  accionesRealesHoy: number;
  ultimaAccionRealAt: Date | null;
  /** Mínimo de la cuenta en unidades mínimas, si se conoce. */
  minimoPresupuesto: number | null;
};

export type Decision = {
  objectId: string;
  cumple: boolean;
  /** Se cumple pero no se actúa. Cuando hay motivo, `aplicar` es false. */
  motivo: MotivoOmision | null;
  aplicar: boolean;
  /** Solo para acciones de presupuesto, en unidades mínimas (D-A6). */
  presupuestoAntes: number | null;
  presupuestoDespues: number | null;
  /** El renglón en castellano que va al historial Y a Telegram. Siempre presente. */
  explicacion: string;
  /** Las métricas con las que se decidió, para congelar en ad_actions.metrics. */
  metrics: Record<string, number | null>;
};

/** PURA: no toca red ni base. Es lo que hace testeable el módulo. */
export type FirmaEvaluar = (
  regla: Regla,
  condiciones: Condicion[],
  fila: MetricasObjeto,
  contexto: ContextoEvaluar,
) => Decision;

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Contrato de la escritura a Meta
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Campaña tal como la devuelve Meta, sin normalizar a EUR.
 * TODOS los importes están en UNIDADES MÍNIMAS de la moneda de la cuenta (D-A6).
 */
export type MetaCampaign = {
  campaignId: string;
  name: string | null;
  objective: string | null;
  status: string | null;
  effectiveStatus: string | null;
  dailyBudget: number | null; // unidades mínimas. null = no lo maneja este nivel
  lifetimeBudget: number | null; // unidades mínimas. Se lee, NO se escribe (D-A10)
  bidStrategy: string | null;
  createdTime: string | null; // ISO 8601, tal como viene de Meta
  // Programación (R11 c8): ISO 8601 tal como viene de Meta. null = sin inicio/fin.
  startTime: string | null;
  endTime: string | null;
};

export type MetaAdSet = {
  adsetId: string;
  campaignId: string; // siempre presente: es la FK hacia ad_campaigns
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  dailyBudget: number | null; // unidades mínimas
  lifetimeBudget: number | null; // unidades mínimas
  optimizationGoal: string | null;
  billingEvent: string | null;
  bidStrategy: string | null;
  createdTime: string | null;
  // Agregados de gestion-campanas-anuncios (R11 c8): programación tal como la
  // devuelve Meta, ISO 8601. null = sin inicio/fin programado.
  startTime: string | null;
  endTime: string | null;
};

/** Los datos de DSA de un conjunto, leídos best-effort (P-G01). */
export type DsaConjunto = {
  adsetId: string;
  dsaPayor: string | null;
  dsaBeneficiary: string | null;
};

export type MetaAd = {
  adId: string;
  adsetId: string; // FK hacia ad_sets
  campaignId: string; // desnormalizado, como en la tabla `ads`
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  creativeId: string | null;
  createdTime: string | null;
  // NO hay presupuesto: en Meta los anuncios no tienen (D-A5).
};

/**
 * Lo que una escritura tiene que dejar distinguir. §6c del plan depende de esto:
 * un POST que termina en timeout puede haberse aplicado igual, y el llamador no
 * puede decidir distinto entre "Meta dijo no" y "no se sabe".
 */
export type ResultadoEscritura =
  | { estado: 'confirmado' }
  | { estado: 'fallido'; error: MetaAdsError }
  | { estado: 'indeterminado'; error: MetaAdsError };

/**
 * Vocabulario_Acciones completo (R15 c2): los seis valores originales del CHECK
 * `ad_actions_action_valida` más los tres de gestion-campanas-anuncios
 * (migración 018 §1).
 */
export type AccionAds =
  | 'pause' | 'activate'
  | 'budget_increase' | 'budget_decrease' | 'budget_set'
  | 'config'
  | 'duplicate' | 'rename' | 'schedule';

/**
 * El resultado de UNA Copia (R10 c8). No reusa `ResultadoEscritura` a propósito:
 * una duplicación indeterminada puede haber creado PARTE de los objetos, y
 * `ResultadoEscritura` no tiene dónde poner esa lista. `creados` lleva los ids
 * que Meta confirmó, aunque falten los demás.
 */
export type ResultadoCopia =
  | { estado: 'confirmado'; creados: string[] }
  | { estado: 'fallido'; error: MetaAdsError; creados: string[] }
  | { estado: 'indeterminado'; error: MetaAdsError; creados: string[]; handle: string | null };

/** El consumo que informó Meta para ESA CUENTA. Lo lee el backoff (D-A14). */
export type UsoCuenta = {
  callCount: number;
  totalTime: number;
  totalCPUTime: number;
  regainAccessAt: Date | null;
};

export type MetaCuenta = {
  accountId: string;
  currency: string | null;
  timezoneName: string | null;
  accountStatus: number | null;
};

export type MetaObjetoLeido = {
  objectId: string;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
};

// Firmas del cliente (implementadas en lib/ads/meta.ts). No son implementaciones:
// definen la forma que T14 (lectura) y T16 (escritura) importan.

export type FirmaFetchCampaigns = (accountId: string) => Promise<MetaCampaign[]>;
export type FirmaFetchAdSets = (accountId: string) => Promise<MetaAdSet[]>;
export type FirmaFetchAds = (accountId: string) => Promise<MetaAd[]>;
export type FirmaFetchCuenta = (accountId: string) => Promise<MetaCuenta>;
export type FirmaFetchMinimoPresupuesto = (accountId: string) => Promise<number | null>;
export type FirmaSetStatus = (objectId: string, status: 'ACTIVE' | 'PAUSED') => Promise<void>;
export type FirmaSetDailyBudget = (objectId: string, unidadesMinimas: number) => Promise<void>;
export type FirmaFetchObjeto = (objectId: string, level: NivelAds) => Promise<MetaObjetoLeido | null>;
export type FirmaVerificarPermisos = () => Promise<{
  ok: boolean;
  scopes: string[];
  falta: string[];
  detalle: string;
  apiVersion: string;
}>;
export type FirmaUltimoUso = (accountId: string) => UsoCuenta | null;
