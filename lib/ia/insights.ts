/**
 * Persistencia y caché de los insights. Es donde vive el freno al gasto.
 *
 * ─── TRES FRENOS, EN ESTE ORDEN ────────────────────────────────────────────
 *
 * 1. LA PANTALLA NO GENERA. `leerInsightVigente()` es un SELECT y es lo único que
 *    corre al abrir el Resumen o Finanzas. Generar se pide explícitamente: por
 *    cron, o por el botón. /resumen es `force-dynamic` y repite el pedido cada
 *    minuto, así que generar en el render serían ~1.440 llamadas por día por
 *    pestaña abierta.
 *
 * 2. LA HUELLA. `UNIQUE (ambito, huella)` en la migración 029. El insight es una
 *    función de los datos: si los datos no cambiaron, no hay nada que volver a
 *    preguntar. Es mejor que un TTL porque un TTL de 6 h regenera cuatro veces por
 *    día aunque no se haya movido un número.
 *
 * 3. EL TECHO DIARIO. `OPENAI_INSIGHTS_MAX_DIA`. Los dos frenos de arriba
 *    dependen de que el código esté bien; este depende de un count(*). Existe
 *    porque la ruta de generación gasta plata de verdad, y un bug de re-render o
 *    una sesión filtrada no pueden convertirse en una factura.
 *
 * ─── Y UN GUARD DE ALUCINACION ─────────────────────────────────────────────
 * Cada insight tiene que citar las métricas en las que se apoya, con el valor que
 * figura en el brief. `validarEvidencia` compara esas citas contra el brief antes
 * de guardar: un número que el modelo inventó no coincide con nada y se descarta.
 * Es determinístico y no cuesta una llamada más.
 */

import { createHash } from 'node:crypto';
import { q, q1 } from '@/lib/db';
import { hayIa, pedirInsights, type Insight } from './openai';

export type AmbitoInsight = 'resumen' | 'finanzas';
export type OrigenInsight = 'cron' | 'manual';

export type InsightGuardado = {
  ambito: AmbitoInsight;
  insights: Insight[];
  rango: { desde: string; hasta: string };
  modelo: string;
  /** ISO. Es para mostrar "generado hace 3 h", no entra en ningún brief. */
  generadoEn: string;
  /** true si la fila salía de la caché en vez de una llamada nueva. */
  deCache: boolean;
};

/** Se pidió generar y ya se llegó al techo del día. El route lo traduce a 429. */
export class LimiteIaError extends Error {
  readonly usados: number;
  readonly techo: number;

  constructor(usados: number, techo: number) {
    super(
      `se alcanzó el techo de ${techo} análisis por día (van ${usados}). ` +
        'Se sube con OPENAI_INSIGHTS_MAX_DIA.',
    );
    this.name = 'LimiteIaError';
    this.usados = usados;
    this.techo = techo;
  }
}

function techoDiario(): number {
  const raw = Number(process.env.OPENAI_INSIGHTS_MAX_DIA);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

function tz(): string {
  return process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
}

// ─── La huella ──────────────────────────────────────────────────────────────

/**
 * JSON con las claves ORDENADAS, recursivamente.
 *
 * El orden importa porque la huella es un hash del texto. `JSON.stringify` respeta
 * el orden de inserción, así que sin esto reordenar dos campos del tipo del brief
 * —un refactor que no cambia ningún dato— invalidaría toda la caché y regeneraría
 * todo una vez. Agregar o sacar un campo SÍ tiene que invalidarla, y lo hace.
 */
export function canonicalizar(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalizar).join(',')}]`;
  const o = v as Record<string, unknown>;
  const claves = Object.keys(o).sort();
  return `{${claves.map((k) => `${JSON.stringify(k)}:${canonicalizar(o[k])}`).join(',')}}`;
}

export function huellaDe(brief: unknown): string {
  return createHash('sha256').update(canonicalizar(brief)).digest('hex');
}

// ─── El guard de alucinación ────────────────────────────────────────────────

/**
 * Todos los valores hoja del brief, como números y como texto. Es el conjunto
 * contra el que se verifica lo que el modelo dijo que leyó.
 */
function hojasDelBrief(v: unknown, nums: Set<number>, textos: Set<string>): void {
  if (typeof v === 'number') {
    nums.add(redondear4(v));
    return;
  }
  if (typeof v === 'string') {
    textos.add(v.toLowerCase());
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) hojasDelBrief(x, nums, textos);
    return;
  }
  if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) hojasDelBrief(x, nums, textos);
  }
}

function redondear4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Convierte a número lo que el modelo escribió, aceptando los formatos en los que
 * puede venir: '3100.2', '3.100,20' (es-AR), '4,32 %', 'EUR 1234.56', '-500'.
 * null si no es un número.
 */
export function parsearValorCitado(s: string): number | null {
  let t = s.trim().replace(/[%\s]/g, '').replace(/^[^\d.,\-+]+/, '').replace(/[^\d.,\-+]+$/, '');
  if (t.length === 0) return null;

  const tieneComa = t.includes(',');
  const tienePunto = t.includes('.');
  if (tieneComa && tienePunto) {
    // '3.100,20' → el último separador es el decimal.
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (tieneComa) {
    // Una coma sola puede ser decimal ('4,32') o de miles ('1,234'). Se asume
    // decimal: es cómo escribe un modelo al que se le pidió castellano.
    t = t.replace(',', '.');
  }

  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Filtra la evidencia que no se corresponde con el brief y descarta los insights
 * que se quedaron sin ninguna cita válida.
 *
 * Para un valor numérico se acepta el valor exacto, el dividido por 100 y el
 * multiplicado por 100: los ratios viajan en tanto por uno y el prompt le pide
 * escribirlos como porcentaje, así que citar 4.32 para un 0.0432 del brief es
 * correcto y no una invención.
 *
 * Un insight con `evidencia` vacía se conserva: el schema permite el array vacío y
 * no todo lo que vale decir tiene un número (por ejemplo "faltan saldos por
 * cargar"). Lo que se descarta es el que citó cosas y NINGUNA existe.
 */
export function validarEvidencia(
  insights: Insight[],
  brief: unknown,
): { validados: Insight[]; citasDescartadas: number; insightsDescartados: number } {
  const nums = new Set<number>();
  const textos = new Set<string>();
  hojasDelBrief(brief, nums, textos);
  const briefTexto = canonicalizar(brief).toLowerCase();

  let citasDescartadas = 0;
  let insightsDescartados = 0;

  const validados: Insight[] = [];
  for (const ins of insights) {
    const buenas = ins.evidencia.filter((ev) => {
      const n = parsearValorCitado(ev.valor);
      if (n !== null) {
        return (
          nums.has(redondear4(n)) ||
          nums.has(redondear4(n / 100)) ||
          nums.has(redondear4(n * 100))
        );
      }
      // No numérico: alcanza con que el texto esté en el brief (un slug, el
      // código de moneda, el nombre de una cuenta).
      const v = ev.valor.trim().toLowerCase();
      return v.length > 0 && (textos.has(v) || briefTexto.includes(v));
    });

    citasDescartadas += ins.evidencia.length - buenas.length;

    if (ins.evidencia.length > 0 && buenas.length === 0) {
      insightsDescartados++;
      continue;
    }
    validados.push({ ...ins, evidencia: buenas });
  }

  return { validados, citasDescartadas, insightsDescartados };
}

// ─── Lectura ────────────────────────────────────────────────────────────────

type FilaInsight = {
  ambito: AmbitoInsight;
  cuerpo: { insights?: unknown };
  rangoDesde: string;
  rangoHasta: string;
  modelo: string;
  generadoEn: Date;
};

const VIGENTE_SQL = `
  SELECT ambito, cuerpo, rango_desde::text AS "rangoDesde", rango_hasta::text AS "rangoHasta",
         modelo, created_at AS "generadoEn"
  FROM ai_insights
  WHERE ambito = $1
  ORDER BY created_at DESC
  LIMIT 1`;

/**
 * El insight más nuevo de un ámbito, o null. Es lo ÚNICO que corre al abrir una
 * pantalla, y no llama a nadie.
 *
 * Devuelve null también si la feature está apagada: sin `OPENAI_API_KEY` no se
 * muestran insights viejos de cuando sí estaba, porque no habría forma de
 * regenerarlos y quedarían congelados en pantalla para siempre.
 */
export async function leerInsightVigente(ambito: AmbitoInsight): Promise<InsightGuardado | null> {
  if (!hayIa()) return null;

  const fila = await q1<FilaInsight>(VIGENTE_SQL, [ambito]);
  if (!fila) return null;

  const insights = Array.isArray(fila.cuerpo?.insights) ? (fila.cuerpo.insights as Insight[]) : [];
  return {
    ambito: fila.ambito,
    insights,
    rango: { desde: fila.rangoDesde, hasta: fila.rangoHasta },
    modelo: fila.modelo,
    generadoEn: fila.generadoEn.toISOString(),
    deCache: true,
  };
}

// ─── Generación ─────────────────────────────────────────────────────────────

const POR_HUELLA_SQL = `
  SELECT ambito, cuerpo, rango_desde::text AS "rangoDesde", rango_hasta::text AS "rangoHasta",
         modelo, created_at AS "generadoEn"
  FROM ai_insights
  WHERE ambito = $1 AND huella = $2`;

// El techo se cuenta en la TZ del dashboard y no en la del server: el server está
// en Europa, así que con `date_trunc('day', now())` el techo se reiniciaría a las
// 19:00 o 20:00 de Buenos Aires, en mitad de la jornada.
//
// No usa el índice de created_at (la expresión lo impide) y está bien: la tabla
// crece unas pocas filas por día.
const USADOS_HOY_SQL = `
  SELECT count(*)::int AS n
  FROM ai_insights
  WHERE (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`;

const INSERTAR_SQL = `
  INSERT INTO ai_insights
    (ambito, rango_desde, rango_hasta, huella, modelo, cuerpo, brief, tokens_in, tokens_out, origen)
  VALUES ($1, $2::date, $3::date, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
  ON CONFLICT (ambito, huella) DO NOTHING`;

export type PedidoGeneracion = {
  ambito: AmbitoInsight;
  instrucciones: string;
  brief: unknown;
  rango: { desde: string; hasta: string };
  origen: OrigenInsight;
  /** Fuerza la llamada aunque la huella ya esté. Sólo lo usa el cron con --forzar. */
  ignorarCache?: boolean;
};

/**
 * Genera (o devuelve de la caché) el insight de un brief.
 *
 * El orden de los chequeos es el que importa: primero la caché, DESPUES el techo.
 * Al revés, un día de muchos clicks sobre datos que no cambiaron consumiría el
 * techo sin haber llamado ni una vez a OpenAI.
 */
export async function generarInsight(p: PedidoGeneracion): Promise<InsightGuardado> {
  const huella = huellaDe(p.brief);

  if (!p.ignorarCache) {
    const cacheada = await q1<FilaInsight>(POR_HUELLA_SQL, [p.ambito, huella]);
    if (cacheada) {
      const insights = Array.isArray(cacheada.cuerpo?.insights)
        ? (cacheada.cuerpo.insights as Insight[])
        : [];
      return {
        ambito: cacheada.ambito,
        insights,
        rango: { desde: cacheada.rangoDesde, hasta: cacheada.rangoHasta },
        modelo: cacheada.modelo,
        generadoEn: cacheada.generadoEn.toISOString(),
        deCache: true,
      };
    }
  }

  const techo = techoDiario();
  const usados = (await q1<{ n: number }>(USADOS_HOY_SQL, [tz()]))?.n ?? 0;
  if (usados >= techo) throw new LimiteIaError(usados, techo);

  const respuesta = await pedirInsights(p.instrucciones, p.brief);
  const { validados, citasDescartadas, insightsDescartados } = validarEvidencia(
    respuesta.insights,
    p.brief,
  );

  // Se loguea y no se tira: un insight con una cita inventada se descarta, pero
  // los otros dos pueden estar perfectos y ya se pagó la llamada. Que aparezca en
  // el log es lo que permite notar que un modelo nuevo alucina más.
  if (citasDescartadas > 0 || insightsDescartados > 0) {
    console.warn(
      `[ia] ${p.ambito}: ${citasDescartadas} citas y ${insightsDescartados} insights descartados ` +
        `por no coincidir con el brief (modelo ${respuesta.modelo})`,
    );
  }

  const cuerpo = { insights: validados };

  await q(INSERTAR_SQL, [
    p.ambito,
    p.rango.desde,
    p.rango.hasta,
    huella,
    respuesta.modelo,
    JSON.stringify(cuerpo),
    JSON.stringify(p.brief),
    respuesta.tokensIn,
    respuesta.tokensOut,
    p.origen,
  ]);

  return {
    ambito: p.ambito,
    insights: validados,
    rango: p.rango,
    modelo: respuesta.modelo,
    generadoEn: new Date().toISOString(),
    deCache: false,
  };
}

/** Para el log del cron y para el aviso del botón. */
export async function usoDelDia(): Promise<{ usados: number; techo: number }> {
  const usados = (await q1<{ n: number }>(USADOS_HOY_SQL, [tz()]))?.n ?? 0;
  return { usados, techo: techoDiario() };
}
