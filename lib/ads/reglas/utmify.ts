/**
 * Traducción entre el CSV de UTMify y las Reglas de este panel, en los dos
 * sentidos.
 *
 * PURO Y CLIENT-SAFE: no importa `pg`, ni React, ni nada de runtime. Lo usan
 * el route de import/export (server) y los tests. Que sea puro es lo que hace
 * testeable el mapeo sin base: son 12 filas de un CSV real contra 12 objetos
 * esperados, y eso se verifica en `utmify.test.ts` con los valores exactos.
 *
 * POR QUÉ ESTE ARCHIVO EXISTE
 * El usuario administra las reglas en UTMify y las quiere acá. Antes esta
 * traducción se hacía A MANO cada vez (el seed de la migración 016 y el
 * reemplazo del 2026-08-16 se escribieron leyendo el CSV fila por fila), y eso
 * es exactamente el trabajo que un import automatiza. La traducción no es
 * obvia: hay cuatro conversiones que no se ven a simple vista y cada una es un
 * bug silencioso de plata si se hace mal.
 *
 * LAS CUATRO TRAMPAS DEL FORMATO
 *
 * 1. CÉNTIMOS. UTMify guarda TODO importe en céntimos: `actionLimitCentsInfo:
 *    2500` es €25,00 y `spend: 1000` es €10,00. La base guarda euros
 *    (`numeric(14,2)`). Se divide por 100 al importar y se multiplica al
 *    exportar. Sin esto, un techo de €25 entra como €2.500 y la regla sube el
 *    presupuesto cien veces más de lo que el usuario cree.
 *
 * 2. EL PORCENTAJE ES UN FACTOR. `actionPercentInfo: 2.5` significa "poné el
 *    presupuesto en 2,5 veces el actual". La base lo guarda como factor×100
 *    (`action_value: 250, action_unit: 'percent'`) y el CHECK
 *    `ad_rules_percent_direccion` exige >100 para subir y <100 para bajar.
 *
 * 3. `applyTo` SON DOS CAMPOS. `ActiveAdsets` no es un valor de este sistema:
 *    es `level: 'adset'` + `statusFilter: 'active'`. Nueve combinaciones.
 *
 * 4. NO HAY `OR`. `blockOperator: 'Or'` no se puede representar: el motor
 *    combina condiciones con Y y nada más (dos reglas separadas expresan lo
 *    mismo y se prenden/apagan por separado). Una fila con `Or` se rechaza con
 *    un mensaje que lo dice, en vez de importarse como `And` y disparar sobre
 *    objetos que el usuario no quería tocar.
 *
 * LO QUE NO VIAJA EN EL FORMATO (y por eso el import lo decide y lo avisa)
 * UTMify no tiene columnas para: la cuenta publicitaria, `enabled`, `dry_run`,
 * el cooldown por objeto ni el tope de acciones por objeto por día. Los dos
 * primeros los decide el importador (la cuenta la elige el usuario; enabled y
 * dry_run los fuerza el sistema: toda regla nueva nace apagada y en sombra).
 * Los dos frenos son rieles de seguridad que este panel tiene y UTMify no: se
 * les pone un default explícito y el resultado del import lo informa.
 */

import type { Condicion, Regla } from '../tipos';
import { motivoIncoherente } from './coherencia';

// ─────────────────────────────────────────────────────────────────────────────
// El formato: las 18 columnas del export de UTMify, en su orden exacto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El encabezado tal cual lo escribe UTMify. El orden importa: el export tiene
 * que producir un archivo que UTMify pueda volver a leer, y el import acepta
 * las columnas en cualquier orden pero necesita reconocer los nombres.
 */
export const COLUMNAS_UTMIFY = [
  'adPlatform',
  'name',
  'nameContains',
  'applyTo',
  'actionType',
  'actionFixedCentsInfo',
  'actionLimitCentsInfo',
  'actionPercentInfo',
  'blockConditions',
  'blockOperator',
  'calculationPeriod',
  'frequencyType',
  'frequencyOncePerDayHour',
  'intervalStartTime',
  'intervalEndTime',
  'executionLimit',
  'timeZoneIana',
  'scope',
] as const;

/** Una regla lista para insertar: todo lo que el CSV pudo decir, ya en euros. */
export type ReglaImportada = {
  name: string;
  level: Regla['level'];
  statusFilter: Regla['statusFilter'];
  nameFilter: string | null;
  nameFilterMode: Regla['nameFilterMode'];
  action: Regla['action'];
  actionValue: number | null;
  actionUnit: Regla['actionUnit'];
  budgetMax: number | null;
  budgetMin: number | null;
  period: Regla['period'];
  everyMinutes: number;
  windowStart: string | null;
  windowEnd: string | null;
  maxRunsPerDay: number | null;
  cooldownMinutes: number;
  maxActionsPerObjectPerDay: number;
  conditions: Condicion[];
};

/** Una fila que no se pudo traducir, con el número de línea del archivo. */
export type ErrorFila = { linea: number; name: string; error: string };

export type ResultadoImport = {
  reglas: ReglaImportada[];
  errores: ErrorFila[];
  /** Decisiones de traducción que el usuario tiene que conocer. Sin duplicados. */
  avisos: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Parser de CSV (RFC 4180): comillas, comas adentro, `""` y CRLF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un `split(',')` NO sirve para este archivo y no es una cuestión de estilo: la
 * columna `blockConditions` es un JSON entrecomillado que contiene comas Y
 * comillas escapadas como `""`. Partir por comas rompe cada condición en
 * pedazos y el import entero se vuelve basura silenciosa.
 *
 * Devuelve las filas tal como están en el archivo, sin interpretar nada: los
 * campos vacíos quedan como string vacío, no como null.
 */
export function parsearCsv(texto: string): string[][] {
  // El BOM de Excel/Sheets se cuela al principio y contamina el nombre de la
  // primera columna ('\uFEFFadPlatform' !== 'adPlatform').
  const limpio = texto.replace(/^\uFEFF/, '');
  const filas: string[][] = [];
  let campo = '';
  let fila: string[] = [];
  let enComillas = false;

  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];

    if (enComillas) {
      if (c === '"') {
        // `""` adentro de un campo entrecomillado es una comilla literal.
        if (limpio[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        campo += c;
      }
      continue;
    }

    if (c === '"') {
      enComillas = true;
    } else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      // CRLF cuenta como UN salto: si viene \r\n se saltea el \n.
      if (c === '\r' && limpio[i + 1] === '\n') i++;
      fila.push(campo);
      campo = '';
      filas.push(fila);
      fila = [];
    } else {
      campo += c;
    }
  }

  // La última fila puede no terminar en salto de línea.
  if (campo !== '' || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }

  // Las líneas totalmente vacías (un salto al final del archivo) no son filas.
  return filas.filter((f) => f.some((v) => v.trim() !== ''));
}

/** Escapa un campo para escribirlo: comillas sólo cuando hacen falta. */
function escaparCampo(v: string): string {
  if (v === '') return '';
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tablas de mapeo
// ─────────────────────────────────────────────────────────────────────────────

/** `applyTo` → los dos campos que este sistema usa (trampa 3 del docblock). */
const APLICAR_A: Record<string, { level: Regla['level']; statusFilter: Regla['statusFilter'] }> = {
  activecampaigns: { level: 'campaign', statusFilter: 'active' },
  pausedcampaigns: { level: 'campaign', statusFilter: 'paused' },
  allcampaigns: { level: 'campaign', statusFilter: 'any' },
  activeadsets: { level: 'adset', statusFilter: 'active' },
  pausedadsets: { level: 'adset', statusFilter: 'paused' },
  alladsets: { level: 'adset', statusFilter: 'any' },
  activeads: { level: 'ad', statusFilter: 'active' },
  pausedads: { level: 'ad', statusFilter: 'paused' },
  allads: { level: 'ad', statusFilter: 'any' },
};

const APLICAR_A_INVERSO: Record<string, string> = {
  'campaign|active': 'ActiveCampaigns',
  'campaign|paused': 'PausedCampaigns',
  'campaign|any': 'AllCampaigns',
  'adset|active': 'ActiveAdsets',
  'adset|paused': 'PausedAdsets',
  'adset|any': 'AllAdsets',
  'ad|active': 'ActiveAds',
  'ad|paused': 'PausedAds',
  'ad|any': 'AllAds',
};

const ACCION: Record<string, Regla['action']> = {
  enable: 'activate',
  activate: 'activate',
  pause: 'pause',
  disable: 'pause',
  increasebudget: 'budget_increase',
  reducebudget: 'budget_decrease',
  decreasebudget: 'budget_decrease',
};

const ACCION_INVERSA: Record<Regla['action'], string> = {
  activate: 'Enable',
  pause: 'Pause',
  budget_increase: 'IncreaseBudget',
  budget_decrease: 'ReduceBudget',
};

const OPERADOR: Record<string, Condicion['op']> = {
  greaterthan: '>',
  greaterequal: '>=',
  greaterthanorequal: '>=',
  lessthan: '<',
  lessequal: '<=',
  lessthanorequal: '<=',
  equal: '=',
  equals: '=',
  notequal: '!=',
};

const OPERADOR_INVERSO: Record<Condicion['op'], string> = {
  '>': 'GreaterThan',
  '>=': 'GreaterEqual',
  '<': 'LessThan',
  '<=': 'LessEqual',
  '=': 'Equal',
  '!=': 'NotEqual',
};

/** `field` de UTMify → métrica del motor. `approvedSales` es el que no se adivina. */
const METRICA: Record<string, Condicion['metric']> = {
  roi: 'roi',
  roas: 'roas',
  spend: 'spend',
  budget: 'budget',
  approvedsales: 'sales',
  sales: 'sales',
  revenue: 'revenue',
  profit: 'profit',
  net: 'net',
  cpa: 'cpa',
  cpc: 'cpc',
  ctr: 'ctr',
  impressions: 'impressions',
  clicks: 'clicks',
};

const METRICA_INVERSA: Record<Condicion['metric'], string> = {
  roi: 'roi',
  roas: 'roas',
  spend: 'spend',
  budget: 'budget',
  sales: 'approvedSales',
  revenue: 'revenue',
  profit: 'profit',
  net: 'net',
  cpa: 'cpa',
  cpc: 'cpc',
  ctr: 'ctr',
  impressions: 'impressions',
  clicks: 'clicks',
};

/**
 * Las métricas cuyo valor viaja en CÉNTIMOS (trampa 1). ROI, ROAS, CTR y las
 * cantidades (ventas, impresiones, clics) son números pelados: dividirlas por
 * 100 convertiría "ROI > 1,3" en "ROI > 0,013" y la regla dispararía siempre.
 */
const METRICAS_EN_CENTIMOS: ReadonlySet<Condicion['metric']> = new Set<Condicion['metric']>([
  'spend',
  'budget',
  'revenue',
  'profit',
  'net',
  'cpa',
  'cpc',
]);

const PERIODO: Record<string, Regla['period']> = {
  today: 'today',
  yesterday: 'yesterday',
  // Decisión heredada del seed de la 016: una campaña pausada no gastó HOY, así
  // que mirar hoy la dejaría pausada para siempre. `LastSevenDays` entra como
  // los 7 días SIN hoy, que es la ventana con la que se puede decidir.
  lastsevendays: '7d_excl_today',
  last7days: '7d_excl_today',
};

const PERIODO_INVERSO: Record<Regla['period'], string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'LastSevenDays',
  '7d_excl_today': 'LastSevenDays',
};

/** `frequencyType` → minutos. `OncePerDay` se resuelve aparte (necesita la hora). */
const FRECUENCIA: Record<string, number> = {
  each1min: 1,
  each5mins: 5,
  each10mins: 10,
  each15mins: 15,
  each30mins: 30,
  eachhour: 60,
  each60mins: 60,
  onceperday: 1440,
};

/** Los minutos que el formulario ofrece, más el 10 que trae UTMify. */
const FRECUENCIAS_SOPORTADAS = [1, 5, 10, 15, 30, 60, 1440] as const;

function frecuenciaAUtmify(everyMinutes: number): string {
  // Un valor fuera de la lista sólo puede venir de un UPDATE a mano en la base
  // (el formulario ofrece 1/5/15/30/60/1440 y el import produce además 10). Se
  // exporta el más cercano en vez de inventar una etiqueta que UTMify no
  // entienda; el redondeo se documenta en `avisosDeExport`.
  const cerca = FRECUENCIAS_SOPORTADAS.reduce((a, b) =>
    Math.abs(b - everyMinutes) < Math.abs(a - everyMinutes) ? b : a,
  );
  if (cerca === 1440) return 'OncePerDay';
  if (cerca === 60) return 'EachHour';
  if (cerca === 1) return 'Each1Min';
  return `Each${cerca}Mins`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de parseo de valores sueltos
// ─────────────────────────────────────────────────────────────────────────────

const vacio = (v: string | undefined): boolean => v == null || v.trim() === '';

/** Un número del CSV, o null si la celda está vacía. Tira si no es número. */
function num(v: string | undefined, campo: string): number | null {
  if (vacio(v)) return null;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) throw new Error(`${campo}: «${v}» no es un número`);
  return n;
}

/** Céntimos → euros con 2 decimales exactos (trampa 1). */
function centimosAEur(centimos: number): number {
  return Math.round(centimos) / 100;
}

/** 'HH:MM' | 'HH:MM:SS' → 'HH:MM'. null si viene vacío. */
function hora(v: string | undefined, campo: string): string | null {
  if (vacio(v)) return null;
  const s = String(v).trim();
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) throw new Error(`${campo}: «${s}» no es una hora HH:MM`);
  const h = Number(m[1]);
  if (h > 23) throw new Error(`${campo}: la hora «${s}» no existe`);
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

type CondicionCruda = { field?: unknown; operator?: unknown; valueA?: unknown; valueB?: unknown };

function condicionesDeJson(raw: string): Condicion[] {
  if (vacio(raw)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('blockConditions no es un JSON válido');
  }
  if (!Array.isArray(parsed)) throw new Error('blockConditions tiene que ser una lista');

  return parsed.map((c, i): Condicion => {
    const cc = c as CondicionCruda;
    const posicion = `condición ${i + 1}`;

    const campo = String(cc.field ?? '').trim().toLowerCase();
    const metric = METRICA[campo];
    if (!metric) {
      throw new Error(
        `${posicion}: la métrica «${String(cc.field ?? '')}» no existe en este panel (las que hay: ${Object.keys(METRICA_INVERSA).join(', ')})`,
      );
    }

    const opCrudo = String(cc.operator ?? '').trim().toLowerCase();
    const op = OPERADOR[opCrudo];
    if (!op) {
      // `Between` es el caso real que cae acá: necesita dos valores y el motor
      // sólo tiene comparaciones simples. Dos condiciones (>= y <=) lo expresan.
      throw new Error(
        `${posicion}: el operador «${String(cc.operator ?? '')}» no se puede representar` +
          (opCrudo.includes('between')
            ? '. Un rango se escribe como dos condiciones: >= el mínimo y <= el máximo'
            : ''),
      );
    }

    if (cc.valueB != null) {
      throw new Error(`${posicion}: «valueB» (rangos) no se soporta; usá dos condiciones`);
    }

    const bruto = Number(cc.valueA);
    if (!Number.isFinite(bruto)) {
      throw new Error(`${posicion}: «valueA» tiene que ser un número (llegó «${String(cc.valueA)}»)`);
    }

    return { metric, op, value: METRICAS_EN_CENTIMOS.has(metric) ? centimosAEur(bruto) : bruto };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Import: CSV → reglas
// ─────────────────────────────────────────────────────────────────────────────

/** El cooldown y el tope por objeto que UTMify no tiene. Ver docblock. */
export const FRENOS_POR_DEFECTO = {
  /**
   * Igual a la frecuencia de la regla: la regla puede actuar cada vez que
   * evalúa, que es exactamente lo que hace UTMify (no tiene cooldown). Poner
   * los 60 min del default de la base frenaría a la mitad una regla de cada 30
   * y el usuario vería su escalera de presupuesto avanzar más lento que en
   * UTMify sin ninguna explicación visible.
   */
  cooldownIgualALaFrecuencia: true,
  /**
   * El tope de acciones por objeto por día SÍ es un riel de este panel que
   * UTMify no tiene, y se mantiene: es lo que evita que un bug de condiciones
   * multiplique un presupuesto sin techo durante todo un día.
   *
   * POR QUÉ 8 Y NO 4 (cambiado el 2026-09-01)
   * Era 4, con el argumento de que «4 alcanza para la escalera 25→50→100→200».
   * Alcanzaba justo, y por eso no alcanzaba: el cupo se cuenta POR OBJETO y no
   * por (regla, objeto) —`historialDeHoy` filtra sólo por `object_id`—, así que
   * cualquier pausa, reactivación o acción manual sobre ese mismo conjunto le
   * come un peldaño a la escalera. Con 4 exactos, una sola acción ajena la
   * dejaba clavada un peldaño antes del final, y el síntoma es un presupuesto
   * que no sube con `skipped_reason = 'max_por_objeto'` enterrado en el
   * historial.
   *
   * Con la escalera extendida a 25→50→100→200→400→800 son 6 subidas. Sumale el
   * reseteo de las 00:00 que baja a €25 todo lo que pase de €50, y al menos una
   * pausa: 8 quedaba justo otra vez. 10 es el número que deja la escalera
   * completa más el reseteo más un par de acciones ajenas.
   *
   * Subirlo NO afloja el freno que importa. El que acota la plata es el techo
   * absoluto (`ads_max_daily_budget_eur`), que rechaza cualquier presupuesto
   * calculado por encima de él; esto sólo acota la CANTIDAD de ediciones por
   * día, que es un límite contra el reinicio permanente de la fase de
   * aprendizaje de Meta, no contra el gasto.
   */
  maxAccionesPorObjetoPorDia: 10,
} as const;

/**
 * Traduce el CSV completo. NUNCA tira: los problemas de una fila la dejan
 * afuera con su número de línea y el resto sigue. Un import que aborta entero
 * por una fila mala obliga a editar el archivo a ciegas.
 */
export function importarCsvUtmify(texto: string): ResultadoImport {
  const filas = parsearCsv(texto);
  if (filas.length === 0) return { reglas: [], errores: [], avisos: ['El archivo está vacío.'] };

  const encabezado = filas[0].map((h) => h.trim());
  const indice = new Map<string, number>();
  encabezado.forEach((h, i) => indice.set(h.toLowerCase(), i));

  if (!indice.has('name') || !indice.has('applyto') || !indice.has('actiontype')) {
    return {
      reglas: [],
      errores: [],
      avisos: [
        'El archivo no parece un export de reglas de UTMify: faltan las columnas name, applyTo o actionType.',
      ],
    };
  }

  const reglas: ReglaImportada[] = [];
  const errores: ErrorFila[] = [];
  const avisos = new Set<string>();

  for (let f = 1; f < filas.length; f++) {
    const fila = filas[f];
    const linea = f + 1; // +1 porque la 1 es el encabezado
    const col = (nombre: string): string | undefined => {
      const i = indice.get(nombre.toLowerCase());
      return i == null ? undefined : fila[i];
    };
    const name = (col('name') ?? '').trim();

    try {
      if (name === '') throw new Error('la columna name está vacía');
      if (name.length > 200) throw new Error('el nombre pasa los 200 caracteres');

      const plataforma = (col('adPlatform') ?? 'Meta').trim().toLowerCase();
      if (plataforma !== '' && plataforma !== 'meta') {
        throw new Error(`adPlatform «${col('adPlatform')}»: este panel sólo maneja Meta`);
      }

      // ── applyTo → level + statusFilter ──────────────────────────────────
      const aplicarA = (col('applyTo') ?? '').trim().toLowerCase();
      const alcance = APLICAR_A[aplicarA];
      if (!alcance) {
        throw new Error(
          `applyTo «${col('applyTo')}» no se reconoce (los válidos: ${Object.values(APLICAR_A_INVERSO).join(', ')})`,
        );
      }

      // ── actionType ──────────────────────────────────────────────────────
      const accionCruda = (col('actionType') ?? '').trim().toLowerCase();
      const action = ACCION[accionCruda];
      if (!action) {
        throw new Error(`actionType «${col('actionType')}» no se reconoce`);
      }
      const esPresupuesto = action === 'budget_increase' || action === 'budget_decrease';

      // D-A5: en Meta los anuncios no tienen presupuesto propio.
      if (esPresupuesto && alcance.level === 'ad') {
        throw new Error('en Meta los anuncios no tienen presupuesto: no se puede aplicar a anuncios');
      }

      // ── valor y unidad de la acción (trampas 1 y 2) ─────────────────────
      const pct = num(col('actionPercentInfo'), 'actionPercentInfo');
      const fijoCent = num(col('actionFixedCentsInfo'), 'actionFixedCentsInfo');
      const limiteCent = num(col('actionLimitCentsInfo'), 'actionLimitCentsInfo');

      let actionValue: number | null = null;
      let actionUnit: Regla['actionUnit'] = null;
      if (esPresupuesto) {
        if (pct != null && fijoCent != null) {
          throw new Error('trae actionPercentInfo y actionFixedCentsInfo a la vez: no se sabe cuál usar');
        }
        if (pct != null) {
          actionUnit = 'percent';
          // El factor de UTMify (2,5) es el porcentaje/100 de la base (250).
          actionValue = Math.round(pct * 100 * 100) / 100;
          if (action === 'budget_increase' && actionValue <= 100) {
            throw new Error(
              `actionPercentInfo ${pct} escala el presupuesto a ${actionValue}% y eso lo BAJA: para subir hace falta un factor mayor a 1`,
            );
          }
          if (action === 'budget_decrease' && actionValue >= 100) {
            throw new Error(
              `actionPercentInfo ${pct} escala el presupuesto a ${actionValue}% y eso lo SUBE: para bajar hace falta un factor menor a 1`,
            );
          }
        } else if (fijoCent != null) {
          actionUnit = 'fixed';
          actionValue = centimosAEur(fijoCent);
        } else {
          throw new Error(
            'una acción de presupuesto necesita actionPercentInfo o actionFixedCentsInfo y llegaron los dos vacíos',
          );
        }
        if (actionValue == null || actionValue <= 0) {
          throw new Error('el valor de la acción de presupuesto tiene que ser mayor a 0');
        }
      }

      // El límite es el techo cuando sube y el piso cuando baja. En las reglas
      // de "resetear presupuesto a 25" el truco es justamente ése: restar un
      // monto enorme con piso 25 deja el presupuesto EN 25.
      let budgetMax: number | null = null;
      let budgetMin: number | null = null;
      if (esPresupuesto) {
        if (limiteCent == null) {
          throw new Error(
            action === 'budget_increase'
              ? 'falta actionLimitCentsInfo: una subida sin techo no se detiene nunca'
              : 'falta actionLimitCentsInfo: una bajada necesita un piso',
          );
        }
        const limite = centimosAEur(limiteCent);
        if (limite <= 0) throw new Error('actionLimitCentsInfo tiene que ser mayor a 0');
        if (action === 'budget_increase') budgetMax = limite;
        else budgetMin = limite;
      }

      // ── condiciones ─────────────────────────────────────────────────────
      const operadorBloque = (col('blockOperator') ?? 'And').trim().toLowerCase();
      if (operadorBloque !== '' && operadorBloque !== 'and') {
        throw new Error(
          `blockOperator «${col('blockOperator')}»: el motor sólo combina condiciones con Y. Un OR se expresa con dos reglas separadas, que además se prenden y apagan por separado`,
        );
      }
      const conditions = condicionesDeJson(col('blockConditions') ?? '');
      if (conditions.length > 50) throw new Error('más de 50 condiciones');
      if (conditions.length === 0) {
        avisos.add(
          `«${name}» no trae condiciones: se va a aplicar a TODOS los objetos que pasen el filtro de alcance.`,
        );
      }

      // ── período ─────────────────────────────────────────────────────────
      const periodoCrudo = (col('calculationPeriod') ?? 'Today').trim().toLowerCase();
      const period = PERIODO[periodoCrudo];
      if (!period) throw new Error(`calculationPeriod «${col('calculationPeriod')}» no se reconoce`);
      if (period === '7d_excl_today') {
        avisos.add(
          '«LastSevenDays» se importó como «7 días sin hoy»: un objeto pausado no gastó hoy, y mirando hoy quedaría pausado para siempre.',
        );
      }

      // ── frecuencia y ventana horaria ────────────────────────────────────
      const frecCruda = (col('frequencyType') ?? '').trim().toLowerCase();
      const everyMinutes = FRECUENCIA[frecCruda];
      if (everyMinutes == null) {
        throw new Error(`frequencyType «${col('frequencyType')}» no se reconoce`);
      }

      let windowStart = hora(col('intervalStartTime'), 'intervalStartTime');
      let windowEnd = hora(col('intervalEndTime'), 'intervalEndTime');
      let maxRunsPerDay = num(col('executionLimit'), 'executionLimit');

      if (frecCruda === 'onceperday') {
        const h = num(col('frequencyOncePerDayHour'), 'frequencyOncePerDayHour') ?? 0;
        if (h < 0 || h > 23) throw new Error(`frequencyOncePerDayHour ${h}: tiene que estar entre 0 y 23`);
        // Una vez por día = la ventana de esa hora, con tope de 1 corrida. El
        // motor no tiene "una vez por día" como concepto propio: lo expresa con
        // ventana + max_runs_per_day, que es lo que ya hizo el seed de la 016.
        const hh = String(h).padStart(2, '0');
        windowStart = `${hh}:00`;
        windowEnd = `${hh}:59`;
        maxRunsPerDay = maxRunsPerDay ?? 1;
      }

      if (maxRunsPerDay != null && (!Number.isInteger(maxRunsPerDay) || maxRunsPerDay <= 0)) {
        throw new Error('executionLimit tiene que ser un entero positivo');
      }
      // La media ventana y el resto de las incoherencias se validan con el mismo
      // módulo que el API y el formulario. El import es la tercera puerta de
      // entrada y era la única que no las chequeaba todas: una regla importada
      // que no puede actuar nunca es peor que una que no se importó, porque
      // queda en la lista como si fuera a funcionar. El error corta esta línea
      // y el resto del CSV sigue entrando.
      const incoherencia = motivoIncoherente({
        action,
        statusFilter: alcance.statusFilter,
        windowStart,
        windowEnd,
        conditions,
      });
      if (incoherencia !== null) throw new Error(incoherencia);

      // ── lo que el formato no puede expresar ─────────────────────────────
      const zona = (col('timeZoneIana') ?? '').trim();
      if (zona !== '') {
        avisos.add(
          `La zona horaria del CSV («${zona}») se ignora: la ventana horaria se evalúa siempre en la zona de la cuenta publicitaria de la regla.`,
        );
      }
      const scope = (col('scope') ?? '').trim();
      if (scope !== '') {
        avisos.add(
          `La columna scope («${scope}») se ignora: la cuenta de destino es la que elegiste en el import.`,
        );
      }

      const nameFilter = (col('nameContains') ?? '').trim() || null;

      reglas.push({
        name,
        level: alcance.level,
        statusFilter: alcance.statusFilter,
        nameFilter,
        nameFilterMode: 'contains',
        action,
        actionValue,
        actionUnit,
        budgetMax,
        budgetMin,
        period,
        everyMinutes,
        windowStart,
        windowEnd,
        maxRunsPerDay,
        cooldownMinutes: everyMinutes,
        maxActionsPerObjectPerDay: FRENOS_POR_DEFECTO.maxAccionesPorObjetoPorDia,
        conditions,
      });
    } catch (e) {
      errores.push({ linea, name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Nombres repetidos dentro del MISMO archivo: el único de la base es
  // (account_id, name), así que dos filas con el mismo nombre chocarían al
  // insertar la segunda. Se avisa acá con el nombre, no con el código del FK.
  const vistos = new Set<string>();
  for (const r of reglas) {
    if (vistos.has(r.name)) {
      avisos.add(`El archivo trae «${r.name}» más de una vez: se va a importar una sola.`);
    }
    vistos.add(r.name);
  }

  if (reglas.length > 0) {
    avisos.add(
      `UTMify no exporta el cooldown ni el tope de acciones por objeto: el cooldown quedó igual a la frecuencia de cada regla (como en UTMify) y el tope en ${FRENOS_POR_DEFECTO.maxAccionesPorObjetoPorDia} acciones por objeto por día, que es el freno de este panel. Se cambian editando la regla.`,
    );
    avisos.add('Toda regla importada nace apagada y en modo simulación: activarla es un paso aparte.');
  }

  return { reglas: dedupPorNombre(reglas), errores, avisos: Array.from(avisos) };
}

/** Se queda con la primera aparición de cada nombre (el aviso ya se emitió). */
function dedupPorNombre(reglas: ReglaImportada[]): ReglaImportada[] {
  const vistos = new Set<string>();
  const salida: ReglaImportada[] = [];
  for (const r of reglas) {
    if (vistos.has(r.name)) continue;
    vistos.add(r.name);
    salida.push(r);
  }
  return salida;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export: reglas → CSV
// ─────────────────────────────────────────────────────────────────────────────

/** Lo mínimo que el export necesita de una regla. */
export type ReglaParaExportar = Pick<
  Regla,
  | 'name'
  | 'accountId'
  | 'level'
  | 'statusFilter'
  | 'nameFilter'
  | 'action'
  | 'actionValue'
  | 'actionUnit'
  | 'budgetMax'
  | 'budgetMin'
  | 'period'
  | 'everyMinutes'
  | 'windowStart'
  | 'windowEnd'
  | 'maxRunsPerDay'
> & { condiciones: readonly Condicion[] };

/**
 * Escribe el CSV en el formato de UTMify.
 *
 * `scope` lleva el id de la cuenta, que es una extensión nuestra: UTMify lo
 * exporta vacío. Sin eso, un archivo con las reglas de dos cuentas tiene
 * nombres repetidos y no hay forma de saber cuál era de cuál. El import lo
 * ignora (la cuenta de destino se elige a mano), así que no rompe el
 * round-trip.
 *
 * Lo que este archivo NO puede llevar, porque el formato no tiene columnas:
 * `enabled`, `dry_run`, el cooldown y el tope por objeto. Un export→import
 * conserva la lógica de la regla (alcance, acción, condiciones, frecuencia) y
 * vuelve a aplicar los defaults en esos cuatro.
 */
export function exportarCsvUtmify(reglas: readonly ReglaParaExportar[]): string {
  const lineas: string[] = [COLUMNAS_UTMIFY.join(',')];

  for (const r of reglas) {
    const esPresupuesto = r.action === 'budget_increase' || r.action === 'budget_decrease';

    const pct = esPresupuesto && r.actionUnit === 'percent' && r.actionValue != null
      ? // 250 (base) → 2.5 (UTMify). Se recorta el cero final: 2.5, no 2.50.
        String(Math.round((r.actionValue / 100) * 10000) / 10000)
      : '';
    const fijo = esPresupuesto && r.actionUnit === 'fixed' && r.actionValue != null
      ? String(Math.round(r.actionValue * 100))
      : '';
    const limiteEur = r.action === 'budget_increase' ? r.budgetMax : r.action === 'budget_decrease' ? r.budgetMin : null;
    const limite = limiteEur != null ? String(Math.round(limiteEur * 100)) : '';

    const condiciones = r.condiciones.map((c) => ({
      field: METRICA_INVERSA[c.metric],
      operator: OPERADOR_INVERSO[c.op],
      valueA: METRICAS_EN_CENTIMOS.has(c.metric) ? Math.round(c.value * 100) : c.value,
      valueB: null,
    }));

    const frecuencia = frecuenciaAUtmify(r.everyMinutes);
    const unaVezPorDia = frecuencia === 'OncePerDay';
    // Con una corrida por día la hora vive en `frequencyOncePerDayHour` y las
    // dos columnas de intervalo van vacías, igual que en el export de UTMify.
    const horaDiaria = unaVezPorDia && r.windowStart ? String(Number(r.windowStart.slice(0, 2))) : unaVezPorDia ? '0' : '';

    const campos: Record<(typeof COLUMNAS_UTMIFY)[number], string> = {
      adPlatform: 'Meta',
      name: r.name,
      nameContains: r.nameFilter ?? '',
      applyTo: APLICAR_A_INVERSO[`${r.level}|${r.statusFilter}`] ?? '',
      actionType: ACCION_INVERSA[r.action],
      actionFixedCentsInfo: fijo,
      actionLimitCentsInfo: limite,
      actionPercentInfo: pct,
      blockConditions: condiciones.length === 0 ? '' : JSON.stringify(condiciones),
      blockOperator: 'And',
      calculationPeriod: PERIODO_INVERSO[r.period],
      frequencyType: frecuencia,
      frequencyOncePerDayHour: horaDiaria,
      intervalStartTime: unaVezPorDia ? '' : r.windowStart ?? '',
      intervalEndTime: unaVezPorDia ? '' : r.windowEnd ?? '',
      // `executionLimit` sólo se escribe si NO es el 1 implícito de OncePerDay:
      // repetirlo ahí sería ruido que UTMify no pone.
      executionLimit: unaVezPorDia && r.maxRunsPerDay === 1 ? '' : r.maxRunsPerDay != null ? String(r.maxRunsPerDay) : '',
      timeZoneIana: '',
      scope: r.accountId,
    };

    lineas.push(COLUMNAS_UTMIFY.map((c) => escaparCampo(campos[c])).join(','));
  }

  // Salto final: los CSV se abren en Excel/Sheets y la última línea sin \n a
  // veces se lee mal.
  return `${lineas.join('\n')}\n`;
}

/** Lo que el export pierde, para mostrarlo en la UI antes de bajar el archivo. */
export function avisosDeExport(reglas: readonly ReglaParaExportar[]): string[] {
  const avisos: string[] = [];
  if (reglas.length === 0) return ['No hay reglas para exportar.'];
  avisos.push(
    'El formato de UTMify no tiene columnas para el estado (prendida/apagada), el modo simulación, el cooldown ni el tope de acciones por objeto: eso no viaja en el archivo.',
  );
  if (reglas.some((r) => r.period === '7d')) {
    avisos.push(
      'Alguna regla usa «7 días» y UTMify sólo tiene «LastSevenDays»: al reimportar va a quedar como «7 días sin hoy».',
    );
  }
  if (reglas.some((r) => !FRECUENCIAS_SOPORTADAS.includes(r.everyMinutes as (typeof FRECUENCIAS_SOPORTADAS)[number]))) {
    avisos.push(
      'Alguna regla tiene una frecuencia que UTMify no puede expresar: se exportó la más cercana de su lista.',
    );
  }
  return avisos;
}
