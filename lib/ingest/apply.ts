import { tx } from '../db';
import { listSteps, type Funnel } from '../funnels';
import { isKnownEvent, type IngestEvent, type IngestPayload } from '../types';
import { DIRECT_LABEL } from './schema';

type MilestoneColumn =
  | 'sales_view_at'
  | 'checkout_click_at'
  | 'purchased_at'
  | 'upsell_view_at'
  | 'upsell_click_at'
  | 'downsell_view_at';

// El vocabulario del §6 mapea 1:1 a columnas de sessions. El primer `at` de
// cada hito es el que gana: el upsert aplica LEAST, así que un lote desordenado
// no puede correr la hora de una compra.
const MILESTONE_BY_EVENT: Record<string, MilestoneColumn> = {
  sales_view: 'sales_view_at',
  checkout_click: 'checkout_click_at',
  purchase: 'purchased_at',
  upsell_view: 'upsell_view_at',
  upsell_click: 'upsell_click_at',
  downsell_view: 'downsell_view_at',
};

export type ApplyResult = { accepted: number; warnings: string[] };

/**
 * Estado que un lote le pide a sessions, derivado sin asumir orden: minAt/maxAt
 * para los extremos de la sesión, maxStepIndex para el embudo (D3) y el primer
 * `at` de cada hito.
 */
function deriveSessionState(events: IngestEvent[]) {
  let minAt: Date | null = null;
  let maxAt: Date | null = null;
  let maxStepIndex = 0;
  const milestones: Record<MilestoneColumn, Date | null> = {
    sales_view_at: null,
    checkout_click_at: null,
    purchased_at: null,
    upsell_view_at: null,
    upsell_click_at: null,
    downsell_view_at: null,
  };
  for (const ev of events) {
    const at = new Date(ev.at);
    if (!minAt || at < minAt) minAt = at;
    if (!maxAt || at > maxAt) maxAt = at;
    if (ev.name === 'step_view' && typeof ev.stepIndex === 'number' && ev.stepIndex > maxStepIndex) {
      maxStepIndex = ev.stepIndex;
    }
    const milestone = MILESTONE_BY_EVENT[ev.name];
    if (milestone && (!milestones[milestone] || at < milestones[milestone]!)) {
      milestones[milestone] = at;
    }
  }
  return { minAt, maxAt, maxStepIndex, milestones };
}

// El INSERT literal del plan §3.3. La semántica de LEAST/GREATEST (que ignoran
// los NULL) y el CASE de la atribución están resueltos ahí: no se tocan.
// El WHERE del DO UPDATE es la única adición (task T02 §5c): un conflicto
// contra una sesión que ya existe con OTRO funnel_id no la pisa. El insert
// devuelve rowCount 0 en ese caso (verificado contra Postgres 16) y los
// eventos de todas formas se guardan con su propio funnel_id.
const SESSION_UPSERT_SQL = `
  INSERT INTO sessions (id, funnel_id, visitor_id, variant, day, started_at, last_seen_at,
                        max_step_index, sales_view_at, checkout_click_at, purchased_at,
                        upsell_view_at, upsell_click_at, downsell_view_at,
                        utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid,
                        country, device, referrer_host, landing_path, experiment)
  VALUES ($1::uuid, $2::smallint, $3::uuid, $4, $5::date, $6::timestamptz, $7::timestamptz, $8::smallint,
          $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz, $13::timestamptz, $14::timestamptz,
          $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
  ON CONFLICT (id) DO UPDATE SET
    started_at        = LEAST(sessions.started_at, EXCLUDED.started_at),
    last_seen_at      = GREATEST(sessions.last_seen_at, EXCLUDED.last_seen_at),
    max_step_index    = GREATEST(sessions.max_step_index, EXCLUDED.max_step_index),
    sales_view_at     = LEAST(sessions.sales_view_at, EXCLUDED.sales_view_at),
    checkout_click_at = LEAST(sessions.checkout_click_at, EXCLUDED.checkout_click_at),
    purchased_at      = LEAST(sessions.purchased_at, EXCLUDED.purchased_at),
    upsell_view_at    = LEAST(sessions.upsell_view_at, EXCLUDED.upsell_view_at),
    upsell_click_at   = LEAST(sessions.upsell_click_at, EXCLUDED.upsell_click_at),
    downsell_view_at  = LEAST(sessions.downsell_view_at, EXCLUDED.downsell_view_at),
    utm_source   = CASE WHEN sessions.utm_source   = '(directo)' THEN EXCLUDED.utm_source   ELSE sessions.utm_source   END,
    utm_medium   = CASE WHEN sessions.utm_medium   = '(directo)' THEN EXCLUDED.utm_medium   ELSE sessions.utm_medium   END,
    utm_campaign = CASE WHEN sessions.utm_campaign = '(directo)' THEN EXCLUDED.utm_campaign ELSE sessions.utm_campaign END,
    utm_content  = CASE WHEN sessions.utm_content  = '(directo)' THEN EXCLUDED.utm_content  ELSE sessions.utm_content  END,
    utm_term     = CASE WHEN sessions.utm_term     = '(directo)' THEN EXCLUDED.utm_term     ELSE sessions.utm_term     END,
    fbclid        = COALESCE(sessions.fbclid, EXCLUDED.fbclid),
    country       = COALESCE(sessions.country, EXCLUDED.country),
    device        = COALESCE(sessions.device, EXCLUDED.device),
    referrer_host = COALESCE(sessions.referrer_host, EXCLUDED.referrer_host),
    landing_path  = COALESCE(sessions.landing_path, EXCLUDED.landing_path),
    -- Gana el PRIMER no-nulo, sin importar el orden en que aterricen los
    -- lotes (D2 de la spec ab-test-popup-descuento): COALESCE es confluente e
    -- idempotente, a diferencia de un EXCLUDED-gana que dependería del orden.
    experiment    = COALESCE(sessions.experiment, EXCLUDED.experiment)
  -- day y variant NO se actualizan (plan §3.3): una sesión que cruza la
  -- medianoche pertenece al día en que empezó.
  WHERE sessions.funnel_id = $2
`;

export async function applyBatch(funnel: Funnel, payload: IngestPayload): Promise<ApplyResult> {
  const warnings: string[] = [];
  const errors: { reason: string; detail: string }[] = [];

  // El schema aplica el default, pero applyBatch acepta el tipo sin
  // normalizar (los tests lo llaman directo): se resuelve acá una sola vez.
  const variant = payload.variant ?? 'default';

  // El variant se guarda igual aunque no esté declarado: se anota y se avisa
  // (regla 1 del §4, D20). La key ya autenticó el funnel, así que esto es un
  // bug de configuración del funnel, no un ataque.
  if (!funnel.variants.includes(variant)) {
    warnings.push(`unknown_variant:${variant}`);
    errors.push({
      reason: 'unknown_variant',
      detail: `variant '${variant}' no declarado en '${funnel.slug}' (declarados: ${funnel.variants.join(', ')})`,
    });
  }

  // Validación de la dimensión del experimento, espejo de la de `variant`,
  // con UNA diferencia: el arreglo vacío no valida nada (funnel que no
  // testea). El valor fuera del conjunto se guarda IGUAL (D20: no se descarta
  // nada): el aviso es para el humano que mira el banner del embudo, no un
  // rechazo.
  const experiment = payload.experiment;
  if (experiment && funnel.experiments.length > 0 && !funnel.experiments.includes(experiment)) {
    warnings.push(`unknown_experiment:${experiment}`);
    errors.push({
      reason: 'unknown_experiment',
      detail: `experiment '${experiment}' no declarado en '${funnel.slug}' (declarados: ${funnel.experiments.join(', ')})`,
    });
  }

  for (const ev of payload.events) {
    if (!isKnownEvent(ev.name)) {
      // Fuera del vocabulario del §6 se guarda tal cual (D20) y se avisa.
      warnings.push(`unknown_event:${ev.name}`);
      errors.push({ reason: 'unknown_event', detail: `nombre de evento desconocido: '${ev.name}'` });
    }
  }

  const state = deriveSessionState(payload.events);

  const accepted = await tx(async (c) => {
    // El día es la única resolución de zona horaria del pipeline y se hace en
    // SQL a propósito: aritmética de TZ en JS corre un día en horario de
    // verano (lib/day.ts explica el porqué).
    const dayRow = await c.query<{ day: string }>(
      'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day',
      [state.minAt!.toISOString(), funnel.timezone],
    );
    const day = dayRow.rows[0].day;

    const steps = await listSteps(funnel.id);
    const stepByIndex = new Map(steps.map((s) => [s.stepIndex, s.slug] as const));
    for (const ev of payload.events) {
      if (ev.name !== 'step_view' || typeof ev.stepIndex !== 'number') continue;
      const catalogSlug = stepByIndex.get(ev.stepIndex);
      if (catalogSlug === undefined) {
        // Alguien agregó pasos y no actualizó el catálogo: grita, no falla
        // (task T02 §5d). El evento se guarda igual.
        warnings.push(`unknown_step:${ev.stepIndex}`);
        errors.push({
          reason: 'unknown_step',
          detail: `step_index ${ev.stepIndex} no existe en el catálogo de '${funnel.slug}'`,
        });
      } else if (ev.stepSlug !== catalogSlug) {
        // Cambiaron el orden de las preguntas y el catálogo quedó viejo: el
        // embudo se mide por stepIndex, que es lo que se guarda.
        warnings.push(`step_slug_mismatch:${ev.stepIndex}:${ev.stepSlug ?? ''}`);
        errors.push({
          reason: 'step_slug_mismatch',
          detail: `step ${ev.stepIndex}: el slug enviado '${ev.stepSlug ?? ''}' no coincide con el catálogo ('${catalogSlug}')`,
        });
      }
    }

    const utms = payload.context?.utms;
    const upsertRes = await c.query(SESSION_UPSERT_SQL, [
      payload.sessionId,
      funnel.id,
      payload.visitorId,
      variant,
      day,
      state.minAt!.toISOString(),
      state.maxAt!.toISOString(),
      state.maxStepIndex,
      state.milestones.sales_view_at?.toISOString() ?? null,
      state.milestones.checkout_click_at?.toISOString() ?? null,
      state.milestones.purchased_at?.toISOString() ?? null,
      state.milestones.upsell_view_at?.toISOString() ?? null,
      state.milestones.upsell_click_at?.toISOString() ?? null,
      state.milestones.downsell_view_at?.toISOString() ?? null,
      utms?.utm_source ?? DIRECT_LABEL,
      utms?.utm_medium ?? DIRECT_LABEL,
      utms?.utm_campaign ?? DIRECT_LABEL,
      utms?.utm_content ?? DIRECT_LABEL,
      utms?.utm_term ?? DIRECT_LABEL,
      utms?.fbclid ?? null,
      payload.context?.country ?? null,
      payload.context?.device ?? null,
      payload.context?.referrer ?? null,
      payload.context?.path ?? null,
      // El parámetro nuevo va AL FINAL ($25) para no correr ningún índice
      // posicional existente. La ausencia llega undefined desde el schema y
      // se guarda NULL: el COALESCE del DO UPDATE la distingue de "vino algo".
      payload.experiment ?? null,
    ]);

    if (upsertRes.rowCount === 0) {
      // Colisión de uuid o funnel mal configurado: la sesión ya existe con otro
      // funnel_id y no se sobrescribe, que movería números de dos funnels a la
      // vez (task T02 §5c). Los eventos igual se insertan, con este funnel.
      warnings.push('session_funnel_mismatch');
      errors.push({
        reason: 'session_funnel_mismatch',
        detail: `la sesión ${payload.sessionId} ya pertenece a otro funnel; no se sobrescribió`,
      });
    }

    // Un solo INSERT con múltiples VALUES: hasta 50 eventos por lote, y un
    // insert por evento sería 50 round-trips por request (task T02 §5e). El
    // day de cada evento se calcula con su propio at en la TZ del funnel.
    const rows: string[] = [];
    const params: unknown[] = [funnel.id, payload.sessionId, payload.visitorId, variant, funnel.timezone];
    let p = 5;
    for (const ev of payload.events) {
      const iName = p + 1;
      const iAt = p + 2;
      const iStep = p + 3;
      const iSlug = p + 4;
      const iValue = p + 5;
      const iCurr = p + 6;
      const iUid = p + 7;
      const iProps = p + 8;
      rows.push(
        `($1::smallint, $2::uuid, $3::uuid, $${iName}, $${iStep}::smallint, $${iSlug}, $4, ` +
          `$${iAt}::timestamptz, ($${iAt}::timestamptz AT TIME ZONE $5)::date, ` +
          `$${iValue}::bigint, $${iCurr}, $${iUid}, $${iProps}::jsonb)`,
      );
      params.push(
        ev.name,
        ev.at,
        ev.stepIndex ?? null,
        ev.stepSlug ?? null,
        ev.value ?? null,
        ev.currency ?? null,
        ev.eventUid ?? null,
        JSON.stringify(ev.props ?? {}),
      );
      p += 8;
    }
    await c.query(
      `INSERT INTO events (funnel_id, session_id, visitor_id, name, step_index, step_slug,
                           variant, occurred_at, day, value_cents, currency, event_uid, props)
       VALUES ${rows.join(', ')}`,
      params,
    );

    if (errors.length > 0) {
      // Una fila por problema, en la misma transacción que los eventos: si el
      // batch se hace visible, sus avisos también (D20).
      const errorRows: string[] = [];
      const errorParams: unknown[] = [funnel.id];
      errors.forEach((e, i) => {
        errorRows.push(`($1::smallint, $${i * 2 + 2}, $${i * 2 + 3})`);
        errorParams.push(e.reason, e.detail);
      });
      await c.query(`INSERT INTO ingest_errors (funnel_id, reason, detail) VALUES ${errorRows.join(', ')}`, errorParams);
    }

    return payload.events.length;
  });

  return { accepted, warnings };
}
