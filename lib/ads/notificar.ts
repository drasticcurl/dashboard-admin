/**
 * Avisos por Telegram del motor de reglas (T18).
 *
 * Dos piezas bien separadas, igual que `motor.ts` y `ejecutor.ts`:
 *
 * - `armarAviso` es PURA: no toca red ni base. Recibe los resultados de un tick
 *   y arma el texto (o devuelve null si no hay nada que avisar). Por eso se
 *   puede testear sin Telegram ni Postgres.
 * - `avisar` habla con la red: lee la configuración de `settings` y manda el
 *   mensaje. NUNCA tira: un error de Telegram no puede tumbar el worker ni
 *   abortar un tick (§6 del task). Timeout de 10 segundos para que una API
 *   colgada no retrase la próxima evaluación.
 *
 * QUÉ SE AVISA Y QUÉ NO (§6)
 * Con un tick por minuto, avisar todo son 1.440 mensajes por día. La regla:
 * se avisa lo que CAMBIÓ algo o lo que FALLÓ.
 *
 * | situación                        | ¿avisa?                          |
 * | una acción real ejecutada        | sí                               |
 * | una acción que falló (ok:false)  | sí, urgente                      |
 * | backoff activado                 | sí, urgente, una vez (el worker) |
 * | acciones simuladas (sombra)      | sí, agrupadas por hora (worker)  |
 * | ningún objeto cumplió            | no                               |
 * | la regla no le tocaba correr     | no                               |
 *
 * El texto REUSA las `explicacion` de T16 (`lib/ads/reglas/explicacion.ts`): el
 * panel y Telegram tienen que decir EXACTAMENTE lo mismo. No se arma un texto
 * paralelo. Se manda en texto plano, no en MarkdownV2: los nombres de campaña
 * traen `-`, `.`, `|`, `(`, `)`, que hay que escapar en MarkdownV2 o la API
 * devuelve 400 y el aviso se pierde. Texto plano se lee igual y no se rompe.
 *
 * El token se guarda en `settings` (D-A15) y es un secreto: nunca se escribe en
 * un log, nunca se devuelve entero, y `enmascararToken` es la única forma de
 * mostrarlo.
 */

import { q } from '../db';
import type { ResultadoCorrida } from './reglas/ejecutor';

export type MensajeAviso = { texto: string; urgente: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// armarAviso (puro)
// ─────────────────────────────────────────────────────────────────────────────

/** "HH:MM" en la hora local del server, para el encabezado del mensaje. */
function horaLocal(fecha: Date): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const partes = fmt.formatToParts(fecha);
  const hh = partes.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = partes.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hh}:${mm}`;
}

/**
 * Arma el mensaje de un tick. `null` = no hay nada que avisar.
 *
 * El parámetro `ahora` (opcional, default `new Date()`) existe sólo para que el
 * test pueda fijar el encabezado sin depender del reloj: la función sigue siendo
 * pura — misma entrada, misma salida.
 */
export function armarAviso(resultados: ResultadoCorrida[], ahora: Date = new Date()): MensajeAviso | null {
  const renglones: string[] = [];
  let urgente = false;
  let hayAlgo = false;

  for (const r of resultados) {
    // La regla no corrió (apagada, cooldown, fuera de ventana): no se avisa.
    if (!r.corrio) continue;

    for (const a of r.acciones) {
      hayAlgo = true;
      if (!r.dryRun && !a.ok) {
        // Una acción real que falló: urgente.
        urgente = true;
        renglones.push(`⚠️ ${r.ruleName}`);
        renglones.push(a.explicacion);
      } else if (!r.dryRun && a.ok) {
        // Una acción real ejecutada.
        renglones.push(`✅ ${r.ruleName}`);
        renglones.push(a.explicacion);
      } else {
        // Modo sombra: la explicacion ya arranca con "[SIMULACIÓN]". Sin emoji
        // para que el resumen del día no quede saturado de símbolos.
        renglones.push(`${r.ruleName}`);
        renglones.push(a.explicacion);
      }
    }
  }

  if (!hayAlgo) return null;

  return {
    texto: [`Panel · reglas · ${horaLocal(ahora)}`, '', ...renglones].join('\n'),
    urgente,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// avisar (red)
// ─────────────────────────────────────────────────────────────────────────────

/** Sólo los últimos 4 caracteres, precedidos de viñetas. Nunca el token entero. */
export function enmascararToken(token: string): string {
  if (!token) return '';
  return `••••${token.slice(-4)}`;
}

type ConfigTelegram = { habilitado: boolean; token: string | null; chatId: string | null };

/** Lee la configuración de `settings`. El token se usa pero nunca se imprime. */
async function leerConfig(): Promise<ConfigTelegram> {
  const filas = await q<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings
      WHERE key IN ('ads_telegram_enabled', 'ads_telegram_bot_token', 'ads_telegram_chat_id')`,
  );
  const m = new Map<string, unknown>(filas.map((f) => [f.key, f.value]));
  const cadena = (k: string): string | null => {
    const v = m.get(k);
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  return {
    habilitado: m.get('ads_telegram_enabled') === true,
    token: cadena('ads_telegram_bot_token'),
    chatId: cadena('ads_telegram_chat_id'),
  };
}

/** El error de Telegram en una línea, SIN el token (la respuesta no lo trae). */
function describirErrorTelegram(body: unknown): string {
  const b = body as { description?: string } | null;
  if (b?.description) return b.description;
  return 'la API de Telegram no devolvió ok';
}

/**
 * Manda por Telegram. Nunca tira: un aviso que falla no puede tumbar el worker.
 *
 * Si `ads_telegram_enabled` es `false` o falta el token o el chat id, devuelve
 * `{ enviado: false, error: null }` sin llamar a nada. No es un error: es la
 * configuración por defecto (D-A12).
 */
export async function avisar(m: MensajeAviso): Promise<{ enviado: boolean; error: string | null }> {
  let cfg: ConfigTelegram;
  try {
    cfg = await leerConfig();
  } catch (e) {
    // La base no respondió: se loguea y se sigue. Nunca tumbar el tick por esto.
    console.error('[reglas] no se pudo leer la config de Telegram:', e instanceof Error ? e.message : e);
    return { enviado: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!cfg.habilitado || !cfg.token || !cfg.chatId) {
    return { enviado: false, error: null };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: m.texto, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!res.ok || body?.ok !== true) {
      return { enviado: false, error: `HTTP ${res.status}: ${describirErrorTelegram(body)}` };
    }
    return { enviado: true, error: null };
  } catch (e) {
    return { enviado: false, error: e instanceof Error ? e.message : String(e) };
  }
}
