/**
 * POST /api/ads/acciones — acciones manuales del gestor (T17 §9), refactorizada
 * por gestion-campanas-anuncios (task 18.2).
 *
 * La validación y la auditoría viven en `lib/ads/acciones.ts` (`preflight`,
 * `abrirAccion`/`cerrarAccion`); acá queda el esquema cerrado, la orquestación
 * por objeto y la respuesta unificada. La confirmación de la UI NO es un control
 * de seguridad: este handler se puede invocar directo con un curl autenticado.
 *
 * - `guard` ANTES de deserializar el cuerpo (R17 c1, c2): sin cookie, 401, cero
 *   escrituras, cero llamadas a Meta.
 * - Esquema cerrado con discriminante por acción (R17 c3): un campo no
 *   declarado, un id que no es 1..20 dígitos, un lote de más de 100, un
 *   presupuesto sin dos decimales o una acción fuera del vocabulario rechazan
 *   el pedido entero. Un estado distinto de ACTIVE/PAUSED o una operación de
 *   archivado/borrado NO son representables (R17 c13).
 * - Ejecución POR OBJETO, no atómica (R16 c1), con la fila de `ad_actions`
 *   abierta antes de la llamada y cerrada después (R15 c3). Los únicos cortes
 *   de lote son los tres del design: token vencido, cuota (con backoff por app)
 *   y cupo de objetos (R16 c1, c4, c5, R17 c17).
 *
 * Los interruptores globales del motor NO se consultan (R17 c6). El
 * Techo_Absoluto y el Tope_Lote sí: no tienen excepciones (R17 c5, c7).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated, getClientIp } from '@/lib/auth';
import { q, q1 } from '@/lib/db';
import { enviar, fetchObjeto, MetaAdsError, setDailyBudget, setInicio, setNombre } from '@/lib/ads/meta';
import type { NivelAds, ResultadoEscritura } from '@/lib/ads/tipos';
import {
  ETIQUETA_NIVEL,
  abrirAccion,
  activarBackoffCuota,
  armarExplicacion,
  cerrarAccion,
  preflight,
  type ObjetoPreflight,
  type ResultadoPreflight,
} from '@/lib/ads/acciones';
import { traducirError, type Corte } from '@/lib/ads/errores';
import type { MotivoOmisionLote } from '@/lib/ads/previsualizacion';
import { duplicar, type PedidoCopia } from '@/lib/ads/copias';
import { nombresDeCopias } from '@/lib/ads/nombres';
import { aplicarRenombre, LARGO_MAX_NOMBRE, type ModoRenombre } from '@/lib/ads/nombres';
import { sincronizarJerarquia } from '@/lib/ads/jerarquia';
import { verificarCupoObjetos } from '@/lib/ads/cupo';
import { reconciliarDuplicaciones } from '@/lib/ads/reconciliacion';
import { resolverInicio } from '@/lib/ads/programacion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

const idMeta = z.string().regex(/^\d{1,20}$/); // R17 c3: 1 a 20 dígitos

const dosDecimales = (n: number): boolean => Number(n.toFixed(2)) === n;

const base = z
  .object({
    level: z.enum(['campaign', 'adset', 'ad']),
    accountId: z.string().min(1).max(64),
    objectIds: z.array(idMeta).min(1).max(100), // R9 c9, R17 c3
  })
  .strict();

// Las ramas nuevas (duplicate/rename/schedule) se agregan en las tasks 23.3,
// 25.1 y 26.1. El discriminante hace que una acción fuera del vocabulario, un
// estado distinto de ACTIVE/PAUSED o un archivado/borrado NO sean representables
// (R17 c3, c13).
const schema = z.discriminatedUnion('action', [
  base.extend({ action: z.literal('pause') }).strict(),
  base.extend({ action: z.literal('activate') }).strict(),
  base.extend({
    action: z.literal('budget_set'),
    // 0,01 EUR en adelante, con 2 decimales (R13 c1). El Techo_Absoluto y el
    // Tope_Lote los valida el preflight contra settings (R17 c5, c7).
    budgetEur: z.number().positive().finite().refine(dosDecimales),
  }).strict(),
  base.extend({
    action: z.literal('duplicate'),
    // R10 c14: este panel duplica campañas y conjuntos, nunca anuncios. Que el
    // tipo lo haga imposible es más barato que un if que alguien puede borrar.
    level: z.enum(['campaign', 'adset']),
    copias: z.number().int().min(1).max(5).default(1), // R10 c4, c17
    objectIds: z.array(idMeta).min(1).max(20), // 20 objetos origen (R17 c15)
    inicio: z.string().datetime({ offset: true }).optional(), // R10 c15, c18
    budgetEur: z.number().positive().finite().refine(dosDecimales).optional(), // R10 c16
  }).strict(),
  base.extend({
    action: z.literal('rename'),
    // Exactamente uno de los cuatro modos, garantizado por el tipo (R12 c2).
    // El `exacto` recorta los espacios de los extremos y exige 1..400 (R12 c1,
    // c3, c4): un nombre vacío tras recortar es irrepresentable.
    modo: z.discriminatedUnion('tipo', [
      z.object({ tipo: z.literal('prefijo'), texto: z.string().min(1).max(100) }).strict(),
      z.object({ tipo: z.literal('sufijo'), texto: z.string().min(1).max(100) }).strict(),
      z
        .object({
          tipo: z.literal('reemplazo'),
          buscar: z.string().min(1).max(400),
          poner: z.string().min(0).max(400),
        })
        .strict(),
      z.object({ tipo: z.literal('exacto'), nombre: z.string().trim().min(1).max(400) }).strict(),
    ]),
  }).strict(),
  base.extend({
    action: z.literal('schedule'),
    // R11 c1, c9: el inicio se programa en el CONJUNTO. Un pedido a nivel ad es
    // imposible de representar: el rechazo pasa a ser un fallo de validación
    // antes de tocar la base, no un if que alguien puede borrar.
    level: z.literal('adset'),
    inicio: z.string().datetime({ offset: true }), // R11 c4
  }).strict(),
]);

type ResultadoObjeto = {
  objectId: string;
  objectName: string | null;
  estado: 'confirmado' | 'fallido' | 'indeterminado' | 'omitido' | 'no_intentado';
  /** Mensaje en castellano del catálogo de errores (R16 c9). */
  mensaje: string | null;
  /** El código de Meta como dato secundario (R16 c9). */
  codigoMeta: number | null;
  creados?: string[];
  motivo?: MotivoOmisionLote | 'ya_esta_entregando';
};

type CorteLote = {
  causa: 'token_vencido' | 'cuota' | 'cupo_objetos';
  detalle: string;
  backoffSegundos: number | null;
};

const TABLA_NIVEL: Record<NivelAds, { tabla: string; pk: string }> = {
  campaign: { tabla: 'ad_campaigns', pk: 'campaign_id' },
  adset: { tabla: 'ad_sets', pk: 'adset_id' },
  ad: { tabla: 'ads', pk: 'ad_id' },
};

const dosDec = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const eur = (n: number): string => `€${dosDec.format(n)}`;

export async function POST(req: NextRequest): Promise<Response> {
  // 1. Guard ANTES de deserializar (R17 c1): sin cookie, 401, nada de nada.
  if (!isAuthenticated(req.cookies)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  // 2. Esquema cerrado (R17 c3).
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const d = parsed.data;

  // 3. Preflight: revalida TODO contra la base y settings antes de cualquier
  //    escritura o llamada de escritura a Meta (R14 c10, R17 c4, c5, c7).
  const pf = await preflight({
    level: d.level,
    accountId: d.accountId,
    accion: d.action,
    objectIds: d.objectIds,
    budgetEur: d.action === 'budget_set' || d.action === 'duplicate' ? d.budgetEur : undefined,
    copias: d.action === 'duplicate' ? d.copias : undefined,
    inicio: d.action === 'duplicate' || d.action === 'schedule' ? d.inicio : undefined,
    modo: d.action === 'rename' ? d.modo : undefined,
  });
  if (!pf.ok) {
    return json(400, { ok: false, error: pf.error.motivo, detail: pf.error.detalle });
  }

  const actorHint = `ip=${getClientIp(req.headers)} ua=${(req.headers.get('user-agent') ?? '?').slice(0, 60)}`;

  // ── 3.5. Reconciliación previa: cerrar las duplicaciones sin resolver de ESTA
  // cuenta antes de operar sobre los objetos (es el momento en que importa:
  // es cuando alguien va a volver a tocarlos). Acotada a 20 filas y con
  // presupuesto de 5 segundos; un fallo no bloquea el pedido. ──────────────
  await Promise.race([
    reconciliarDuplicaciones(d.accountId, 20),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]).catch(() => undefined);

  // ── Duplicación: N objetos × K copias = N×K filas de ad_actions, una por
  // Copia, con object_id = el objeto ORIGINAL (P-G05, R15 c6, D-08). ────────
  if (d.action === 'duplicate') {
    const cupo = await verificarCupoObjetos(
      d.accountId,
      d.objectIds.length * d.copias,
    ).catch(() => null);
    return json(200, await ejecutarDuplicacion(d as DuplicarValidado, pf, actorHint, cupo));
  }

  if (d.action === 'rename') {
    return json(200, await ejecutarRenombre(d as RenombrarValidado, pf, actorHint));
  }

  if (d.action === 'schedule') {
    return ejecutarProgramacion(d as ProgramarValidado, pf, actorHint);
  }

  // 4. Ejecución por objeto, NO atómica (R16 c1). Las omisiones de la
  //    revalidación no se mandan a Meta y quedan registradas como 'omitido'.
  const resultados: ResultadoObjeto[] = [];
  let corte: CorteLote | null = null;
  let cortado = false;

  for (let i = 0; i < d.objectIds.length; i++) {
    const objeto = pf.objetos[i]!;
    const baseResultado = {
      objectId: objeto.objectId,
      objectName: objeto.objectName,
    };

    if (cortado) {
      resultados.push({ ...baseResultado, estado: 'no_intentado', mensaje: null, codigoMeta: null });
      continue;
    }

    const filaPrevia = pf.previa.filas.find((f) => f.objectId === objeto.objectId);
    if (filaPrevia?.motivo) {
      const explicacion = armarExplicacion({
        accion: d.action,
        nivel: d.level,
        objectName: objeto.objectName,
        objectId: objeto.objectId,
        accountId: d.accountId,
      });
      const id = await abrirAccion({
        accountId: d.accountId,
        nivel: d.level,
        objectId: objeto.objectId,
        objectName: objeto.objectName,
        accion: d.action,
        before: filaPrevia.antes,
        after: filaPrevia.despues,
        explicacion,
        actorHint,
      });
      await cerrarAccion(id, 'omitido');
      resultados.push({
        ...baseResultado,
        estado: 'omitido',
        mensaje: null,
        codigoMeta: null,
        motivo: filaPrevia.motivo,
      });
      continue;
    }

    const { campos, before, after, explicacion } = preparar(d, d.level, objeto);

    // La fila se abre ANTES del POST y se cierra después (R15 c3).
    const id = await abrirAccion({
      accountId: d.accountId,
      nivel: d.level,
      objectId: objeto.objectId,
      objectName: objeto.objectName,
      accion: d.action,
      before,
      after,
      explicacion,
      actorHint,
    });

    let r: ResultadoEscritura;
    try {
      r = await enviar(objeto.objectId, campos);
    } catch (e) {
      r = {
        estado: 'indeterminado',
        error: new MetaAdsError(e instanceof Error ? e.message : String(e), undefined, undefined, undefined, true),
      };
    }

    if (r.estado === 'confirmado') {
      await cerrarAccion(id, 'confirmado');
      await refrescarJerarquia(d.level, objeto.objectId);
      resultados.push({ ...baseResultado, estado: 'confirmado', mensaje: null, codigoMeta: null });
      continue;
    }

    // Error: el catálogo decide clasificación y corte (R16 c4, c5, c9).
    const ctx = {
      objectId: objeto.objectId,
      objectName: objeto.objectName,
      nivel: d.level,
      accountId: d.accountId,
    };
    const traducido = traducirError(
      {
        codigo: r.error.code,
        subcodigo: r.error.subcode,
        httpStatus: r.error.httpStatus,
        transient: r.error.transient,
        mensaje: r.error.message,
      },
      ctx,
    );
    await cerrarAccion(id, traducido.clasifica, { error: r.error.message });
    resultados.push({
      ...baseResultado,
      estado: traducido.clasifica,
      mensaje: traducido.mensaje,
      codigoMeta: traducido.codigoMeta,
    });

    const corteDelError = cortePara(traducido.corta);
    if (corteDelError) {
      if (corteDelError.causa === 'cuota') {
        // R17 c17: activar el backoff por app y devolver los segundos.
        const segundos = await activarBackoffCuota();
        corte = { causa: 'cuota', detalle: traducido.mensaje, backoffSegundos: segundos };
      } else {
        corte = { causa: corteDelError.causa, detalle: traducido.mensaje, backoffSegundos: null };
      }
      cortado = true;
    }
  }

  return json(200, {
    ok: true,
    aplicados: resultados.filter((r) => r.estado === 'confirmado').length,
    total: resultados.length,
    corte,
    resultados,
  });
}

function cortePara(c: Corte): { causa: 'token_vencido' | 'cuota' | 'cupo_objetos' } | null {
  return c === null ? null : { causa: c };
}

// ── La duplicación (R10, R15 c6, R17 c15, c16, D-08) ────────────────────────

type DuplicarValidado = {
  action: 'duplicate';
  level: 'campaign' | 'adset';
  accountId: string;
  objectIds: string[];
  copias: number;
  inicio?: string;
  budgetEur?: number;
};

async function ejecutarDuplicacion(
  d: DuplicarValidado,
  pf: Extract<ResultadoPreflight, { ok: true }>,
  actorHint: string,
  cupo: Awaited<ReturnType<typeof verificarCupoObjetos>> | null,
): Promise<Record<string, unknown>> {
  const k = d.copias;

  // Nombres planificados: determinísticos y sin colisión (P12), contra los
  // hermanos que la jerarquía local conoce más los ya planificados en la corrida.
  const ocupadosPorOrigen = new Map<string, Set<string>>();
  const planeados = new Set<string>();
  for (const o of pf.objetos) {
    const hermanos =
      d.level === 'campaign'
        ? await q<{ name: string | null }>(
            `SELECT name FROM ad_campaigns WHERE account_id = $1 AND campaign_id <> $2 AND name IS NOT NULL`,
            [d.accountId, o.objectId],
          )
        : await q<{ name: string | null }>(
            `SELECT name FROM ad_sets WHERE campaign_id = $1 AND adset_id <> $2 AND name IS NOT NULL`,
            [o.campaignId, o.objectId],
          );
    const ocupados = new Set(hermanos.map((h) => h.name!));
    ocupadosPorOrigen.set(o.objectId, ocupados);
  }

  // Un pedido por Copia, con el desglose exacto del árbol (R10 c1, c2).
  const desglose = await desgloseDe(d.level, d.accountId, d.objectIds);
  const pedidos: PedidoCopia[] = [];
  const originales: ObjetoPreflight[] = [];
  const numeroDeCopia: number[] = [];
  for (const o of pf.objetos) {
    const conteo = desglose.get(o.objectId) ?? { conjuntos: 0, anuncios: 0 };
    const ocupados = new Set(Array.from(ocupadosPorOrigen.get(o.objectId) ?? []).concat(Array.from(planeados)));
    const nombres = nombresDeCopias(o.objectName ?? '', k, ocupados);
    for (let n = 0; n < k; n++) {
      const nombre = nombres[n]!;
      planeados.add(nombre);
      const sufijo = (nombre.match(/ - Copia \d+$/) ?? [''])[0]!;
      pedidos.push({
        objectId: o.objectId,
        nivel: d.level,
        campaignId: d.level === 'adset' ? o.campaignId : undefined,
        nombre,
        sufijo,
        objetosEsperados: d.level === 'campaign' ? 1 + conteo.conjuntos + conteo.anuncios : 1 + conteo.anuncios,
        inicio: d.inicio,
      });
      originales.push(o);
      numeroDeCopia.push(n + 1);
    }
  }

  // R15 c3: la fila se abre ANTES de la llamada. object_id = el ORIGINAL;
  // after_value = el nombre planificado (la llave de la reconciliación, P-G05).
  const filasAuditoria: { id: number; pedido: PedidoCopia }[] = [];
  for (const pedido of pedidos) {
    const id = await abrirAccion({
      accountId: d.accountId,
      nivel: d.level,
      objectId: pedido.objectId,
      objectName: pedido.nombre,
      accion: 'duplicate',
      before: pedido.objectId,
      after: pedido.nombre,
      explicacion: armarExplicacion({
        accion: 'duplicate',
        nivel: d.level,
        objectName: pedido.objectId,
        objectId: pedido.objectId,
        accountId: d.accountId,
        extra: `«${pedido.nombre}»`,
      }),
      actorHint,
      metrics: {
        copia: numeroDeCopia[filasAuditoria.length],
        de: k,
        nivel: d.level,
        objetos_esperados: pedido.objetosEsperados,
        presupuesto_pedido_eur: d.budgetEur ?? null,
        presupuesto_aplicado: false,
        inicio_pedido: d.inicio ?? null,
        inicio_efectivo: d.inicio ?? null,
      },
    });
    filasAuditoria.push({ id, pedido });
  }

  // La operación de copia, UNA sola vez (R10 c10: nunca se repite).
  const creados = await duplicar(d.accountId, pedidos);

  // ── Cierre por Copia y cortes ──
  const resultados: ResultadoObjeto[] = [];
  let corte: CorteLote | null = null;
  let cortado = false;
  for (let i = 0; i < pedidos.length; i++) {
    const pedido = pedidos[i]!;
    const fila = filasAuditoria[i]!;
    const baseResultado = {
      objectId: pedido.objectId,
      objectName: pedido.nombre,
    };

    if (cortado || i >= creados.length) {
      resultados.push({
        ...baseResultado,
        estado: 'no_intentado',
        mensaje: null,
        codigoMeta: null,
        creados: [],
      });
      await cerrarAccion(fila.id, 'omitido');
      continue;
    }

    const r = creados[i]!;
    if (r.estado === 'confirmado') {
      await cerrarAccion(fila.id, 'confirmado', {
        metrics: { creados: r.creados, presupuesto_aplicado: false },
      });
      resultados.push({
        ...baseResultado,
        estado: 'confirmado',
        mensaje: null,
        codigoMeta: null,
        creados: r.creados,
      });
      continue;
    }

    const traducido = traducirError(
      {
        codigo: r.error.code,
        subcodigo: r.error.subcode,
        httpStatus: r.error.httpStatus,
        transient: r.error.transient,
        mensaje: r.error.message,
      },
      { objectId: pedido.objectId, objectName: pedido.nombre, nivel: d.level, accountId: d.accountId },
    );
    await cerrarAccion(fila.id, traducido.clasifica, {
      error: r.error.message,
      metrics: { creados: r.creados, handle: r.estado === 'indeterminado' ? r.handle : null },
    });
    resultados.push({
      ...baseResultado,
      estado: traducido.clasifica,
      mensaje: traducido.mensaje,
      codigoMeta: traducido.codigoMeta,
      creados: r.creados,
    });

    const c = cortePara(traducido.corta);
    if (c) {
      if (c.causa === 'cuota') {
        const segundos = await activarBackoffCuota();
        corte = { causa: 'cuota', detalle: traducido.mensaje, backoffSegundos: segundos };
      } else {
        corte = { causa: c.causa, detalle: traducido.mensaje, backoffSegundos: null };
      }
      cortado = true; // R16 c5: los no intentados vuelven como no_intentado
    }
  }

  // ── Sync de la jerarquía dentro de 5 s de la confirmación (R10 c9) ──
  const confirmadas = resultados.filter((r) => r.estado === 'confirmado');
  let jerarquiaSincronizada = false;
  if (confirmadas.length > 0) {
    const sync = Promise.race([
      // R10 c10: si el sync falla o no termina en 60 s, la duplicación queda
      // confirmada igual y NO se repite la operación de copia.
      sincronizarJerarquia({ cuentas: [d.accountId] })
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60_000)),
    ]);
    jerarquiaSincronizada = await sync;
  }

  // ── Presupuesto sobre el objeto de la Copia que lo lleva (R10 c16, R18 c3, c7) ──
  if (d.budgetEur !== undefined && jerarquiaSincronizada) {
    const filaPorNombre = new Map(filasAuditoria.map((f) => [f.pedido.nombre, f.id]));
    for (const r of confirmadas) {
      const original = pf.objetos.find((o) => o.objectId === r.objectId);
      if (!original) continue;
      const aplicado = await aplicarPresupuesto(d.accountId, r, original.budgetLevel, d.budgetEur);
      if (aplicado.ok) {
        const filaId = filaPorNombre.get(r.objectName ?? '');
        if (filaId !== undefined) {
          await q(
            `UPDATE ad_actions SET metrics = metrics || '{"presupuesto_aplicado": true}'::jsonb
              WHERE id = $1`,
            [filaId],
          );
        }
      }
    }
  }

  return {
    ok: true,
    aplicados: confirmadas.length,
    total: pedidos.length,
    corte,
    resultados,
    jerarquiaSincronizada,
    cupo,
  };
}

/** Aplica el presupuesto a la Copia sobre el objeto que lo lleva: la campaña si
 *  el original era CBO, cada conjunto si era ABO (R18 c3, c7). Nunca tira: un
 *  fallo deja la Copia pausada con el presupuesto heredado (R10 c19). */
async function aplicarPresupuesto(
  accountId: string,
  copia: { objectId: string; objectName?: string | null; creados?: string[] },
  budgetLevelOrigen: 'campaign' | 'adset' | null,
  budgetEur: number,
): Promise<{ ok: boolean; motivo: string | null }> {
  try {
    const nombre = copia.objectName;
    if (!nombre) return { ok: false, motivo: 'sin nombre planificado para encontrar la Copia' };
    const camp = await q1<{ id: string }>(
      `SELECT campaign_id AS id FROM ad_campaigns WHERE account_id = $1 AND name = $2
        ORDER BY synced_at DESC LIMIT 1`,
      [accountId, nombre],
    );
    if (!camp) return { ok: false, motivo: 'la jerarquía local todavía no incluye la Copia' };

    const unidades = Math.round(budgetEur * 100);
    if (budgetLevelOrigen === 'adset') {
      const conjuntos = await q<{ id: string }>(
        `SELECT adset_id AS id FROM ad_sets WHERE campaign_id = $1 AND daily_budget IS NOT NULL`,
        [camp.id],
      );
      for (const s of conjuntos) {
        await setDailyBudget(s.id, unidades);
      }
      return { ok: true, motivo: null };
    }
    await setDailyBudget(camp.id, unidades);
    return { ok: true, motivo: null };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : String(e) };
  }
}

/** El desglose de descendientes por objeto origen (misma cuenta que usa el
 *  preflight): una lectura de la jerarquía local, no de Meta (R14 c5). */
async function desgloseDe(
  level: NivelAds,
  accountId: string,
  objectIds: string[],
): Promise<Map<string, { conjuntos: number; anuncios: number }>> {
  const out = new Map<string, { conjuntos: number; anuncios: number }>();
  if (level === 'campaign') {
    const sets = await q<{ campaign_id: string; n: number }>(
      `SELECT campaign_id, count(*)::int AS n FROM ad_sets WHERE account_id = $1 AND campaign_id = ANY($2::text[]) GROUP BY campaign_id`,
      [accountId, objectIds],
    );
    const ads = await q<{ campaign_id: string; n: number }>(
      `SELECT campaign_id, count(*)::int AS n FROM ads WHERE account_id = $1 AND campaign_id = ANY($2::text[]) GROUP BY campaign_id`,
      [accountId, objectIds],
    );
    const adsPorCamp = new Map(ads.map((r) => [r.campaign_id, r.n]));
    for (const s of sets) out.set(s.campaign_id, { conjuntos: s.n, anuncios: adsPorCamp.get(s.campaign_id) ?? 0 });
    for (const id of objectIds) if (!out.has(id)) out.set(id, { conjuntos: 0, anuncios: 0 });
  } else if (level === 'adset') {
    const ads = await q<{ adset_id: string; n: number }>(
      `SELECT adset_id, count(*)::int AS n FROM ads WHERE account_id = $1 AND adset_id = ANY($2::text[]) GROUP BY adset_id`,
      [accountId, objectIds],
    );
    const porSet = new Map(ads.map((r) => [r.adset_id, r.n]));
    for (const id of objectIds) out.set(id, { conjuntos: 0, anuncios: porSet.get(id) ?? 0 });
  }
  return out;
}

/** Campos, before/after y explicación de una acción, por objeto. */
function preparar(
  d: { action: 'pause' | 'activate' | 'budget_set'; budgetEur?: number },
  nivel: NivelAds,
  o: ObjetoPreflight,
): { campos: Record<string, string>; before: string | null; after: string | null; explicacion: string } {
  if (d.action === 'pause') {
    return {
      campos: { status: 'PAUSED' },
      before: o.status,
      after: 'PAUSED',
      explicacion: armarExplicacion({
        accion: 'pause',
        nivel,
        objectName: o.objectName,
        objectId: o.objectId,
        accountId: o.accountId,
      }),
    };
  }
  if (d.action === 'activate') {
    return {
      campos: { status: 'ACTIVE' },
      before: o.status,
      after: 'ACTIVE',
      explicacion: armarExplicacion({
        accion: 'activate',
        nivel,
        objectName: o.objectName,
        objectId: o.objectId,
        accountId: o.accountId,
      }),
    };
  }
  const presupuesto = d.budgetEur!;
  return {
    campos: { daily_budget: String(Math.round(presupuesto * 100)) },
    before: o.dailyBudget !== null ? eur(o.dailyBudget / 100) : null,
    after: eur(presupuesto),
    explicacion: armarExplicacion({
      accion: 'budget_set',
      nivel,
      objectName: o.objectName,
      objectId: o.objectId,
      accountId: o.accountId,
      extra: `${o.dailyBudget !== null ? eur(o.dailyBudget / 100) : '—'} → ${eur(presupuesto)}`,
    }),
  };
}

/** Relee el objeto en Meta y refresca la fila de la jerarquía (T17 §9.9). */
async function refrescarJerarquia(level: NivelAds, objectId: string): Promise<void> {
  try {
    const o = await fetchObjeto(objectId, level);
    if (!o) return;
    const t = TABLA_NIVEL[level];
    if (level === 'ad') {
      await q(
        `UPDATE ads SET status = $2, effective_status = $3, synced_at = now() WHERE ad_id = $1`,
        [objectId, o.status, o.effectiveStatus],
      );
    } else {
      await q(
        `UPDATE ${t.tabla} SET status = $2, effective_status = $3, daily_budget = $4, lifetime_budget = $5, synced_at = now() WHERE ${t.pk} = $1`,
        [objectId, o.status, o.effectiveStatus, o.dailyBudget, o.lifetimeBudget],
      );
    }
  } catch {
    // Best-effort: la jerarquía se refresca en el próximo sync. La acción ya
    // quedó confirmada en Meta y en ad_actions.
  }
}

// ── El renombrado (R12) ─────────────────────────────────────────────────────

type RenombrarValidado = {
  action: 'rename';
  level: 'campaign' | 'adset' | 'ad';
  accountId: string;
  objectIds: string[];
  modo: ModoRenombre;
};

async function ejecutarRenombre(
  d: RenombrarValidado,
  pf: Extract<ResultadoPreflight, { ok: true }>,
  actorHint: string,
): Promise<Record<string, unknown>> {
  const resultados: ResultadoObjeto[] = [];
  let corte: CorteLote | null = null;
  let cortado = false;

  for (const objeto of pf.objetos) {
    const baseResultado = { objectId: objeto.objectId, objectName: objeto.objectName };

    if (cortado) {
      resultados.push({ ...baseResultado, estado: 'no_intentado', mensaje: null, codigoMeta: null });
      continue;
    }

    const filaPrevia = pf.previa.filas.find((f) => f.objectId === objeto.objectId);
    if (filaPrevia?.motivo) {
      resultados.push({
        ...baseResultado,
        estado: 'omitido',
        mensaje: null,
        codigoMeta: null,
        motivo: filaPrevia.motivo,
      });
      continue;
    }

    const actual = objeto.objectName ?? '';
    const solicitado = aplicarRenombre(actual, d.modo).trim();

    // R12 c3, c4: sin llamar a Meta. En un lote, el objeto queda fallido y el
    // resto continúa (R12 c10).
    if (solicitado === '') {
      const explicacion = armarExplicacion({
        accion: 'rename',
        nivel: d.level,
        objectName: objeto.objectName,
        objectId: objeto.objectId,
        accountId: d.accountId,
      });
      const id = await abrirAccion({
        accountId: d.accountId,
        nivel: d.level,
        objectId: objeto.objectId,
        objectName: objeto.objectName,
        accion: 'rename',
        before: actual,
        after: solicitado,
        explicacion,
        actorHint,
      });
      await cerrarAccion(id, 'fallido', { error: 'el nombre es obligatorio' });
      resultados.push({
        ...baseResultado,
        estado: 'fallido',
        mensaje: 'El nombre es obligatorio: no se aplicó ningún cambio.',
        codigoMeta: null,
      });
      continue;
    }
    if (solicitado.length > LARGO_MAX_NOMBRE) {
      const id = await abrirAccion({
        accountId: d.accountId,
        nivel: d.level,
        objectId: objeto.objectId,
        objectName: objeto.objectName,
        accion: 'rename',
        before: actual,
        after: solicitado.slice(0, 400),
        explicacion: armarExplicacion({
          accion: 'rename',
          nivel: d.level,
          objectName: objeto.objectName,
          objectId: objeto.objectId,
          accountId: d.accountId,
        }),
        actorHint,
      });
      await cerrarAccion(id, 'fallido', { error: `el nombre supera los ${LARGO_MAX_NOMBRE} caracteres` });
      resultados.push({
        ...baseResultado,
        estado: 'fallido',
        mensaje: `El nombre supera los ${LARGO_MAX_NOMBRE} caracteres que admite la Marketing API.`,
        codigoMeta: null,
      });
      continue;
    }

    const explicacion = armarExplicacion({
      accion: 'rename',
      nivel: d.level,
      objectName: objeto.objectName,
      objectId: objeto.objectId,
      accountId: d.accountId,
      extra: `«${solicitado}»`,
    });
    const id = await abrirAccion({
      accountId: d.accountId,
      nivel: d.level,
      objectId: objeto.objectId,
      objectName: objeto.objectName,
      accion: 'rename',
      before: actual,
      after: solicitado,
      explicacion,
      actorHint,
    });

    let r: ResultadoEscritura;
    try {
      r = await setNombre(objeto.objectId, solicitado);
    } catch (e) {
      r = {
        estado: 'indeterminado',
        error: new MetaAdsError(e instanceof Error ? e.message : String(e), undefined, undefined, undefined, true),
      };
    }

    if (r.estado === 'confirmado') {
      // R12 c5: releer el nombre en Meta dentro de 10 s y reflejarlo en la fila
      // local dentro de los 5 s siguientes.
      const releido = await Promise.race([
        fetchObjeto(objeto.objectId, d.level).then((o) => o?.name ?? null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
      if (releido !== null) {
        const t = TABLA_NIVEL[d.level];
        await q(
          `UPDATE ${t.tabla} SET name = $2, synced_at = now() WHERE ${t.pk} = $1`,
          [objeto.objectId, releido],
        );
        await cerrarAccion(id, 'confirmado');
        resultados.push({ ...baseResultado, estado: 'confirmado', mensaje: null, codigoMeta: null });
      } else {
        // R12 c11: la fila local conserva el nombre anterior, queda marcada
        // pendiente de verificación y se avisa.
        await cerrarAccion(id, 'confirmado', {
          metrics: { pendiente_verificacion: true },
        });
        resultados.push({
          ...baseResultado,
          estado: 'confirmado',
          mensaje: 'El renombrado no pudo verificarse: la fila local conserva el nombre anterior hasta la próxima sincronización.',
          codigoMeta: null,
        });
      }
      continue;
    }

    const traducido = traducirError(
      {
        codigo: r.error.code,
        subcodigo: r.error.subcode,
        httpStatus: r.error.httpStatus,
        transient: r.error.transient,
        mensaje: r.error.message,
      },
      { objectId: objeto.objectId, objectName: objeto.objectName, nivel: d.level, accountId: d.accountId },
    );
    await cerrarAccion(id, traducido.clasifica, { error: r.error.message });
    resultados.push({
      ...baseResultado,
      estado: traducido.clasifica,
      mensaje: traducido.mensaje,
      codigoMeta: traducido.codigoMeta,
    });

    const c = cortePara(traducido.corta);
    if (c) {
      if (c.causa === 'cuota') {
        const segundos = await activarBackoffCuota();
        corte = { causa: 'cuota', detalle: traducido.mensaje, backoffSegundos: segundos };
      } else {
        corte = { causa: c.causa, detalle: traducido.mensaje, backoffSegundos: null };
      }
      cortado = true;
    }
  }

  return {
    ok: true,
    aplicados: resultados.filter((r) => r.estado === 'confirmado').length,
    total: resultados.length,
    corte,
    resultados,
  };
}

// ─── La programación del inicio (R11) ───────────────────────────────────────

type ProgramarValidado = {
  action: 'schedule';
  level: 'adset';
  accountId: string;
  objectIds: string[];
  inicio: string;
};

async function ejecutarProgramacion(
  d: ProgramarValidado,
  pf: Extract<ResultadoPreflight, { ok: true }>,
  actorHint: string,
): Promise<Response> {
  const resultados: ResultadoObjeto[] = [];
  let corte: CorteLote | null = null;
  let cortado = false;

  // R11 c4: el inicio se resuelve a un ÚNICO instante con desplazamiento
  // explícito y segundos en 00, en la Zona_Cuenta. El cliente mandó un instante;
  // la pared en la zona de la cuenta es la fecha y hora que el usuario eligió.
  const pared = await q1<{ fecha: string; hora: string }>(
    `SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS fecha,
            to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI') AS hora`,
    [d.inicio, pf.zona],
  );
  if (!pared) {
    return json(400, { ok: false, error: 'fecha_invalida', detail: 'no se pudo resolver el inicio en la zona de la cuenta' });
  }
  const resuelto = await resolverInicio(pared.fecha, pared.hora, pf.zona);

  for (const objeto of pf.objetos) {
    const baseResultado = { objectId: objeto.objectId, objectName: objeto.objectName };

    if (cortado) {
      resultados.push({ ...baseResultado, estado: 'no_intentado', mensaje: null, codigoMeta: null });
      continue;
    }

    const filaPrevia = pf.previa.filas.find((f) => f.objectId === objeto.objectId);
    if (filaPrevia?.motivo) {
      resultados.push({
        ...baseResultado,
        estado: 'omitido',
        mensaje: null,
        codigoMeta: null,
        motivo: filaPrevia.motivo,
      });
      continue;
    }

    // R11 c6: un objeto que YA está entregando (inicio programado alcanzado)
    // se omite sin enviarle ningún cambio, y el lote sigue.
    const inicioLocal = objeto.inicioProgramado;
    if (inicioLocal !== null && new Date(inicioLocal).getTime() <= Date.now()) {
      const id = await abrirAccion({
        accountId: d.accountId,
        nivel: d.level,
        objectId: objeto.objectId,
        objectName: objeto.objectName,
        accion: 'schedule',
        before: inicioLocal,
        after: resuelto.instante,
        explicacion: armarExplicacion({
          accion: 'schedule',
          nivel: d.level,
          objectName: objeto.objectName,
          objectId: objeto.objectId,
          accountId: d.accountId,
        }),
        actorHint,
      });
      await cerrarAccion(id, 'omitido');
      resultados.push({
        ...baseResultado,
        estado: 'omitido',
        mensaje: 'El objeto ya está entregando: el inicio de un conjunto que arrancó no se puede cambiar.',
        codigoMeta: null,
        motivo: 'ya_esta_entregando',
      });
      continue;
    }

    const explicacion = armarExplicacion({
      accion: 'schedule',
      nivel: d.level,
      objectName: objeto.objectName,
      objectId: objeto.objectId,
      accountId: d.accountId,
      extra: `${pared.fecha} ${pared.hora} (${pf.zona})`,
    });
    const id = await abrirAccion({
      accountId: d.accountId,
      nivel: d.level,
      objectId: objeto.objectId,
      objectName: objeto.objectName,
      accion: 'schedule',
      before: inicioLocal,
      after: resuelto.instante,
      explicacion,
      actorHint,
      metrics: { inicio_pedido: d.inicio, inicio_efectivo: resuelto.instante },
    });

    let r: ResultadoEscritura;
    try {
      r = await setInicio(objeto.objectId, resuelto.instante);
    } catch (e) {
      r = {
        estado: 'indeterminado',
        error: new MetaAdsError(e instanceof Error ? e.message : String(e), undefined, undefined, undefined, true),
      };
    }

    if (r.estado === 'confirmado') {
      // R11 c7: releer dentro de 10 s y actualizar la fila local con el inicio
      // y el estado que devuelve Meta.
      const releido = await Promise.race([
        fetchObjeto(objeto.objectId, d.level),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
      if (releido) {
        await q(
          `UPDATE ad_sets SET start_time = $2::timestamptz, status = $3, effective_status = $4, synced_at = now()
            WHERE adset_id = $1`,
          [objeto.objectId, resuelto.instante, releido.status, releido.effectiveStatus],
        );
      }
      await cerrarAccion(id, 'confirmado', { metrics: { inicio_efectivo: resuelto.instante } });
      resultados.push({
        ...baseResultado,
        estado: 'confirmado',
        mensaje: resuelto.ajustadoPorDst
          ? `El inicio se ajustó por un cambio de horario: el instante efectivo enviado es ${resuelto.efectivo} (${pf.zona}).`
          : null,
        codigoMeta: null,
      });
      continue;
    }

    const traducido = traducirError(
      {
        codigo: r.error.code,
        subcodigo: r.error.subcode,
        httpStatus: r.error.httpStatus,
        transient: r.error.transient,
        mensaje: r.error.message,
      },
      { objectId: objeto.objectId, objectName: objeto.objectName, nivel: d.level, accountId: d.accountId },
    );
    await cerrarAccion(id, traducido.clasifica, { error: r.error.message });
    resultados.push({
      ...baseResultado,
      estado: traducido.clasifica,
      mensaje: traducido.mensaje,
      codigoMeta: traducido.codigoMeta,
    });

    const c = cortePara(traducido.corta);
    if (c) {
      if (c.causa === 'cuota') {
        const segundos = await activarBackoffCuota();
        corte = { causa: 'cuota', detalle: traducido.mensaje, backoffSegundos: segundos };
      } else {
        corte = { causa: c.causa, detalle: traducido.mensaje, backoffSegundos: null };
      }
      cortado = true;
    }
  }

  return json(200, {
    ok: true,
    aplicados: resultados.filter((r) => r.estado === 'confirmado').length,
    total: resultados.length,
    corte,
    resultados,
  });
}
