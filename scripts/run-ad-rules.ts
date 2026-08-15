/**
 * `npm run ads:reglas` — el worker del motor de reglas (T18).
 *
 *   npm run ads:reglas                 un tick y sale (probar a mano / cron)
 *   npm run ads:reglas -- --daemon     loop infinito (el que corre bajo PM2)
 *   npm run ads:reglas -- --regla=7    una sola regla, un tick (debug)
 *   npm run ads:reglas -- --dry-run    fuerza sombra en este tick (sin tocar settings)
 *   npm run ads:reglas -- --health     verifica ads_worker_last_tick y avisa si cayó
 *
 * ESTE ARCHIVO ES CADENCIA, EXCLUSIÓN MUTUA, BACKOFF Y AVISOS.
 * No evalúa condiciones, no calcula presupuestos y no llama a Meta para
 * escribir: todo eso es de `lib/ads/reglas/ejecutor.ts`. Si te encontrás
 * escribiendo lógica de reglas acá, está en el archivo equivocado.
 *
 * EL ORDEN DEL TICK NO ES NEGOCIABLE (D-A12):
 *   1. LEER LOS INTERRUPTORES — si `ads_rules_enabled=false`, log y SALIR.
 *      Sin sync, sin insights, sin escrituras: CERO llamadas a Meta. Es el freno
 *      de mano que le permite al operador creer que apagar las reglas aísla Meta.
 *   2. tomar el lease (con dueño, §3)
 *   3. leer el backoff
 *   4. reconciliar()
 *   5. refrescar el gasto (syncAdSpend de hoy y ayer, con TTL)
 *   6. correrTodas()
 *   7. notificar por Telegram
 *   8. revisar el uso de la API → escribir backoff si hace falta
 *   9. liberar el lease (compare-and-set por dueño)
 *  10. marcar ads_worker_last_tick + imprimir contadorLlamadas()
 *
 * El paso 1 va PRIMERO. La versión anterior lo leía adentro del motor (después
 * del sync) y con el interruptor apagado el worker igual pedía insights a Meta
 * cada minuto. Con el interruptor apagado, `contadorLlamadas()` tiene que dar 0.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getPool, q, q1 } from '../lib/db';
import { contadorLlamadas, reiniciarContador, ultimoUso } from '../lib/ads/meta';
import { syncAdSpend } from '../lib/ads/sync';
import type { ResultadoSync } from '../lib/ads/sync';
import { rollupRange } from './rollup';
import { correrRegla, correrTodas, reconciliar } from '../lib/ads/reglas/ejecutor';
import type { ResultadoCorrida } from '../lib/ads/reglas/ejecutor';
import { acumuladorDe, crearAcumuladores } from '../lib/ads/reglas/acumuladores';
import * as repo from '../lib/ads/reglas/repo';
import { armarAviso, avisar } from '../lib/ads/notificar';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción viene
// de PM2/`--env-file` y no existe (process.loadEnvFile es de Node >= 20.12).
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const INTERVALO_BASE_MS = 60_000; // 1 minuto (D-A13)

// El dueño del lease se genera UNA vez al arrancar el proceso. El randomUUID no
// es paranoia: un PID reciclado después de un restart no tiene que heredar el
// lease de un proceso muerto (§3).
const OWNER = `${process.pid}-${randomUUID()}`;

function log(msg: string): void {
  console.log(`[reglas] ${msg}`);
}

/** "HH:MM" en es-AR (sistema), para los motivos de backoff que van al panel. */
function horaEsAr(fecha: Date): string {
  const fmt = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const partes = fmt.formatToParts(fecha);
  const hh = partes.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = partes.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hh}:${mm}`;
}

function logContador(): void {
  const c = contadorLlamadas();
  const porCuenta = Object.entries(c.porCuenta)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  log(`llamadas a meta: ${c.total}${porCuenta ? ` (${porCuenta})` : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lease (§3): tomar/renovar y liberar, con dueño
// ─────────────────────────────────────────────────────────────────────────────

/** Tomar o renovar. Devuelve true si este proceso quedó dueño del lease. */
async function tomarLease(owner: string): Promise<boolean> {
  const res = await getPool().query(
    `UPDATE settings
        SET value = jsonb_build_object('owner', $1::text,
                                       'expires_at', (now() + interval '3 minutes')::text)
      WHERE key = 'ads_worker_lease'
        AND (   value->>'owner' IS NULL                          -- libre
             OR value->>'owner' = $1::text                       -- soy el dueño: renuevo
             OR (value->>'expires_at')::timestamptz < now())      -- ajeno y vencido`,
    [owner],
  );
  return (res.rowCount ?? 0) === 1;
}

/** Liberar: compare-and-set por dueño, para no liberar el lease de otro. */
async function liberarLease(owner: string): Promise<void> {
  await getPool().query(
    `UPDATE settings SET value = '{}'::jsonb
      WHERE key = 'ads_worker_lease' AND value->>'owner' = $1::text`,
    [owner],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Backoff adaptativo (§4, D-A14) — estado persistido, nada en memoria
// ─────────────────────────────────────────────────────────────────────────────

/** El mismo INSERT ON CONFLICT que `setSetting`, sin importar app/api/config. */
async function setValor(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

async function leerBackoff(): Promise<{ until: Date | null; reason: string; failures: number; cleanTicks: number }> {
  const filas = await q<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings
      WHERE key IN ('ads_backoff_until', 'ads_backoff_reason', 'ads_backoff_failures', 'ads_backoff_clean_ticks')`,
  );
  const m = new Map<string, unknown>(filas.map((f) => [f.key, f.value]));
  const hasta = m.get('ads_backoff_until');
  const hastaStr = typeof hasta === 'string' && hasta.length > 0 ? hasta : null;
  return {
    until: hastaStr ? new Date(hastaStr) : null,
    reason: typeof m.get('ads_backoff_reason') === 'string' ? (m.get('ads_backoff_reason') as string) : '',
    failures: Number(m.get('ads_backoff_failures')) || 0,
    cleanTicks: Number(m.get('ads_backoff_clean_ticks')) || 0,
  };
}

async function escribirBackoff(e: {
  until: Date | null;
  reason: string;
  failures: number;
  cleanTicks: number;
}): Promise<void> {
  await setValor('ads_backoff_until', e.until ? e.until.toISOString() : '');
  await setValor('ads_backoff_reason', e.reason);
  await setValor('ads_backoff_failures', e.failures);
  await setValor('ads_backoff_clean_ticks', e.cleanTicks);
}

export type SenalesCuota = {
  /** Peor porcentaje de uso entre las tres métricas y todas las cuentas (0-100). */
  peorPorcentaje: number;
  /** El `regainAccessAt` más cercano en el futuro, o null. */
  regainAccessAt: Date | null;
  /** Se vio un error de cuota (code 17 o 613) en el tick. */
  huboErrorCuota: boolean;
  /** La cuenta con el peor uso, para el motivo en castellano. */
  cuentaPeor: string | null;
};

export type EstadoBackoff = {
  until: Date | null;
  reason: string;
  failures: number;
  cleanTicks: number;
};

/**
 * PURA: mapea las señales del tick + el estado persistido al estado nuevo.
 * Es lo que hace testeable la política de §4 sin una cuenta de Meta.
 *
 * Política:
 *   regainAccessAt      → frenado hasta ese instante, sin discutir
 *   error 17/613        → frenado 15 min, duplicado por reincidencia, tope 60
 *   uso ≥ 95%           → frenado 15 min
 *   uso ≥ 75%           → frenado corto (intervalo ×5)
 *   2 ticks < 50%       → baja failures (recuperación)
 */
export function calcularBackoff(
  senales: SenalesCuota,
  estado: { failures: number; cleanTicks: number },
  ahora: Date,
): EstadoBackoff {
  let failures = estado.failures;
  let clean = estado.cleanTicks;

  if (senales.regainAccessAt) {
    return {
      until: senales.regainAccessAt,
      reason: `Meta pidió esperar hasta las ${horaEsAr(senales.regainAccessAt)} (regainAccessAt) en la cuenta ${senales.cuentaPeor ?? '?'}.`,
      failures,
      cleanTicks: 0,
    };
  }

  if (senales.huboErrorCuota) {
    // El castigo se calcula sobre el escalón ACTUAL y recién después se
    // incrementa la reincidencia: la primera vez es 15 min, la siguiente 30,
    // la siguiente 60 (min(15 * 2^failures, 60)).
    const minutos = Math.min(15 * 2 ** failures, 60);
    failures += 1;
    return {
      until: new Date(ahora.getTime() + minutos * 60_000),
      reason: `Meta respondió un error de cuota (code 17/613). Pausado ${minutos} min (reincidencia ${failures}).`,
      failures,
      cleanTicks: 0,
    };
  }

  if (senales.peorPorcentaje >= 95) {
    const until = new Date(ahora.getTime() + 15 * 60_000);
    return {
      until,
      reason: `Meta avisó ${Math.round(senales.peorPorcentaje)}% de uso de cuota en la cuenta ${senales.cuentaPeor ?? '?'}. Pausado hasta las ${horaEsAr(until)}.`,
      failures,
      cleanTicks: 0,
    };
  }

  if (senales.peorPorcentaje >= 75) {
    return {
      until: new Date(ahora.getTime() + 5 * 60_000),
      reason: `Meta avisó ${Math.round(senales.peorPorcentaje)}% de uso de cuota en la cuenta ${senales.cuentaPeor ?? '?'}. Intervalo ×5.`,
      failures,
      cleanTicks: 0,
    };
  }

  if (senales.peorPorcentaje < 50) {
    clean += 1;
    if (clean >= 2) {
      failures = Math.max(0, failures - 1);
      clean = 0;
    }
  }

  return { until: null, reason: '', failures, cleanTicks: clean };
}

/** Revisa el uso informado por Meta y persiste el backoff si hace falta (§2 paso 8). */
async function revisarUso(resSync: ResultadoSync | null): Promise<void> {
  const c = contadorLlamadas();
  if (c.total === 0) return; // no hablamos con Meta: no hay señal que medir

  const cuentasTocadas = Object.keys(c.porCuenta).filter((k) => k !== '_app');

  let peor = 0;
  let cuentaPeor: string | null = null;
  let regain: Date | null = null;
  for (const cuenta of cuentasTocadas) {
    const u = ultimoUso(cuenta);
    if (!u) continue;
    const p = Math.max(u.callCount, u.totalTime, u.totalCPUTime);
    if (p > peor) {
      peor = p;
      cuentaPeor = cuenta;
    }
    if (u.regainAccessAt && (!regain || u.regainAccessAt.getTime() < regain.getTime())) {
      regain = u.regainAccessAt;
    }
  }

  // El error de cuota que Meta devuelve durante el sync queda como string en
  // ResultadoSync (sync.ts convierte MetaAdsError a "mensaje (code N)"). El
  // subcódigo no sobrevive a esa conversión, así que se matchea por code 17/613.
  let huboErrorCuota = false;
  if (resSync) {
    for (const cuenta of resSync.cuentas) {
      if (cuenta.error && (/\bcode 17\b/.test(cuenta.error) || /\bcode 613\b/.test(cuenta.error))) {
        huboErrorCuota = true;
      }
    }
  }

  const actual = await leerBackoff();
  const nuevo = calcularBackoff(
    { peorPorcentaje: peor, regainAccessAt: regain, huboErrorCuota, cuentaPeor },
    actual,
    new Date(),
  );
  await escribirBackoff(nuevo);

  if (nuevo.until) log(`backoff: ${nuevo.reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresco del gasto (§5): reusar syncAdSpend TAL CUAL
// ─────────────────────────────────────────────────────────────────────────────

async function ttlInsights(): Promise<number> {
  const r = await q1<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'ads_insights_ttl_seconds'`);
  const n = typeof r?.value === 'number' ? r.value : Number(r?.value);
  return Number.isFinite(n) && n > 0 ? n : 55;
}

/**
 * Sincroniza hoy y ayer si el último sync es más viejo que el TTL. Usa
 * `syncAdSpend` de lib/ads/sync.ts sin modificarla (es el camino por el que hoy
 * entra el gasto de Resumen y Ventas), y corre `rollupRange` después, igual que
 * `live.ts`: sin eso el gasto queda fresco en Anuncios y viejo en Resumen.
 */
async function refrescarGasto(): Promise<ResultadoSync | null> {
  const ttl = await ttlInsights();
  const frescura = await q1<{ age: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - min(last_sync_at)))::text AS age
       FROM ad_accounts WHERE active AND platform = 'meta'`,
  );
  const age = frescura?.age !== null && frescura?.age !== undefined ? Number(frescura.age) : null;
  if (age !== null && age < ttl) {
    // El worker ya refrescó hace menos de TTL segundos: se reusa el gasto de la
    // base. Si Meta aprieta, el usuario sube ads_insights_ttl_seconds desde el
    // panel sin desplegar.
    return null;
  }

  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  const r = await q<{ from: string; to: string }>(
    `SELECT ((now() AT TIME ZONE $1)::date - 1)::text AS from,
             (now() AT TIME ZONE $1)::date::text    AS to`,
    [tz],
  );
  const { from, to } = r[0]!;
  const res = await syncAdSpend({ from, to });
  await rollupRange({ from, to });
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Motor (§2 paso 6)
// ─────────────────────────────────────────────────────────────────────────────

type OptsMotor = { reglaId?: number; forzarSombra?: boolean };

/** Corre `correrTodas`, o una regla, o todo en sombra forzada, según los flags. */
async function correrMotor(opts: OptsMotor): Promise<ResultadoCorrida[]> {
  if (opts.reglaId != null) {
    const r = await repo.reglaPorId(opts.reglaId);
    if (!r) throw new Error(`no existe la regla ${opts.reglaId}`);
    const switches = await repo.interruptores();
    // El tope agregado por tick es POR CUENTA (D-A9c, spec
    // reglas-anuncios-por-cuenta): un acumulador por Cuenta_Activa y la regla
    // usa el de SU cuenta. Un solo acumulador compartido dejaría que una cuenta
    // agotada bloquee las subidas de la otra, que es justo el bug que arregló
    // la 021.
    const acumuladores = crearAcumuladores(await repo.cuentasActivas(), switches.maxDeltaPorTickEur);
    const acumulador = acumuladorDe(acumuladores, r.regla.accountId, switches.maxDeltaPorTickEur);
    return [await correrRegla(r, { switches, acumulador, forzarSombra: opts.forzarSombra ?? false })];
  }
  if (opts.forzarSombra) {
    // `correrTodas` no acepta forzar sombra, así que se replica su loop con
    // forzarSombra:true y los mismos acumuladores por cuenta del tope agregado
    // por tick (D-A9c): el --dry-run tiene que simular lo que hace el Tick real.
    const reglas = await repo.reglasActivas();
    const switches = await repo.interruptores();
    const acumuladores = crearAcumuladores(await repo.cuentasActivas(), switches.maxDeltaPorTickEur);
    const out: ResultadoCorrida[] = [];
    for (const r of reglas) {
      const acumulador = acumuladorDe(acumuladores, r.regla.accountId, switches.maxDeltaPorTickEur);
      out.push(await correrRegla(r, { switches, acumulador, forzarSombra: true }));
    }
    return out;
  }
  return correrTodas();
}

// ─────────────────────────────────────────────────────────────────────────────
// Avisos (§6): Telegram solo lo que amerita
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El resumen de modo sombra se agrupa por hora: no vibra el teléfono cada
 * minuto. Vive en memoria porque es cadencia de aviso, no estado del motor: un
 * restart de PM2 a lo sumo manda un resumen de más, nunca una acción de más.
 */
let ultimoResumenSombraAt: Date | null = null;

async function notificar(resultados: ResultadoCorrida[]): Promise<void> {
  const aviso = armarAviso(resultados);
  if (!aviso) return;

  // Todo en sombra → throttle a un resumen por hora. Si algo real pasó (o algo
  // falló), se manda siempre.
  const soloSombra = resultados.length > 0 && resultados.every((r) => !r.corrio || r.dryRun);
  if (soloSombra && ultimoResumenSombraAt) {
    if (Date.now() - ultimoResumenSombraAt.getTime() < 60 * 60 * 1000) return;
  }

  const r = await avisar(aviso);
  if (r.enviado) {
    if (soloSombra) ultimoResumenSombraAt = new Date();
  } else if (r.error) {
    log(`telegram: no se pudo avisar (${r.error})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// El tick
// ─────────────────────────────────────────────────────────────────────────────

async function tick(opts: OptsMotor): Promise<void> {
  reiniciarContador();
  const inicio = Date.now();

  // 1. INTERRUPTORES PRIMERO (D-A12). Con ads_rules_enabled=false no se llama a
  //    Meta para NADA: ni sync, ni insights, ni escrituras.
  const switches = await repo.interruptores();
  if (!switches.habilitado) {
    log('ads_rules_enabled=false → apagado, el tick no hace nada (sin sync, sin insights, sin escrituras)');
    logContador();
    // El worker sigue VIVO aunque esté apagado: se marca el tick para que el
    // --health del cron no dé un falso "worker caído" durante el modo apagado
    // (que es el estado por defecto y puede durar días).
    await setValor('ads_worker_last_tick', new Date().toISOString());
    return;
  }

  // 2. Lease. Si no lo conseguimos, otro proceso vigente lo tiene.
  if (!(await tomarLease(OWNER))) {
    log('no conseguí el lease (otro proceso lo tiene): tick descartado');
    return;
  }

  try {
    // 3. Backoff: si ads_backoff_until está en el futuro, el tick no corre.
    const backoff = await leerBackoff();
    if (backoff.until && backoff.until.getTime() > Date.now()) {
      log(`backoff activo hasta ${backoff.until.toISOString()} (${backoff.reason})`);
      logContador();
      return;
    }

    // 4. reconciliar: cerrar las mutaciones que quedaron colgadas (T16 §6b).
    const recon = await reconciliar();
    if (recon.revisadas > 0) {
      log(`reconciliación: ${recon.revisadas} revisadas, ${recon.confirmadas} confirmadas, ${recon.fallidas} fallidas, ${recon.sinResolver} sin resolver`);
    }

    // 5. refrescar el gasto (syncAdSpend + rollupRange).
    const resSync = await refrescarGasto();

    // 6. el motor de reglas.
    const resultados = await correrMotor(opts);

    // 7. Telegram.
    await notificar(resultados);

    // 8. revisar el uso de la API y escribir el backoff si hace falta.
    await revisarUso(resSync);
  } catch (e) {
    // Un tick que falla loguea y termina: NO mata el proceso. Con un error
    // determinístico, un `throw` acá sería un ciclo de reinicios de PM2 que
    // llena el disco de logs (§2).
    log(`tick falló: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // 9. liberar el lease al terminar, normal o con error (§3).
    await liberarLease(OWNER).catch(() => {});
  }

  // 10. last tick + contador de llamadas.
  await setValor('ads_worker_last_tick', new Date().toISOString());
  log(`tick completo en ${Date.now() - inicio} ms`);
  logContador();
}

// ─────────────────────────────────────────────────────────────────────────────
// Health check (cron de respaldo, §9)
// ─────────────────────────────────────────────────────────────────────────────

async function healthCheck(): Promise<number> {
  const r = await q1<{ age_min: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - (NULLIF(value #>> '{}', ''))::timestamptz))::int AS age_min
       FROM settings WHERE key = 'ads_worker_last_tick'`,
  );
  const age = r?.age_min ?? null;
  if (age === null) {
    log('ads_worker_last_tick vacío: el worker nunca marcó un tick');
    await avisar({ texto: 'Panel · reglas: el worker no tiene ningún tick registrado (ads_worker_last_tick vacío). Revisar pm2 logs panel-reglas.', urgente: true });
    return 1;
  }
  if (age > 300) {
    log(`el último tick fue hace ${age} s (> 5 min): el worker puede estar caído`);
    await avisar({ texto: `Panel · reglas: el último tick fue hace ${Math.round(age / 60)} min. El worker puede estar caído.`, urgente: true });
    return 1;
  }
  log(`worker sano: último tick hace ${age} s`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parsearArgs(argv: string[]): { daemon: boolean; health: boolean; reglaId?: number; forzarSombra: boolean } {
  const out = { daemon: false, health: false, forzarSombra: false, reglaId: undefined as number | undefined };
  for (const a of argv) {
    if (a === '--daemon') out.daemon = true;
    else if (a === '--health') out.health = true;
    else if (a === '--dry-run') out.forzarSombra = true;
    else if (a.startsWith('--regla=')) out.reglaId = Number(a.slice('--regla='.length));
    else throw new Error(`argumento desconocido: ${a}`);
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parsearArgs(process.argv.slice(2));

  if (opts.health) {
    process.exitCode = await healthCheck();
    await getPool().end().catch(() => {});
    return;
  }

  if (opts.daemon) {
    // setTimeout recursivo, NO setInterval: la próxima corrida arranca N
    // segundos DESPUÉS de que terminó la anterior, así un tick de 90 s no se
    // solapa con el siguiente (§2).
    let apagando = false;
    let tickEnCurso: Promise<void> | null = null;

    const apagar = async (): Promise<void> => {
      if (apagando) return;
      apagando = true;
      log('terminando: se espera el tick en curso y se libera el lease...');
      if (tickEnCurso) {
        await tickEnCurso.catch(() => {});
      }
      await liberarLease(OWNER).catch(() => {});
      await getPool().end().catch(() => {});
      process.exit(0);
    };
    process.on('SIGTERM', () => void apagar());
    process.on('SIGINT', () => void apagar());

    const loop = (): void => {
      // El catch va ADENTRO del loop: una excepción no manejada mataría el
      // proceso y PM2 lo reiniciaría, y un error determinístico en el primer
      // tick se convertiría en un ciclo que llena el disco de logs (§2).
      tickEnCurso = tick({ reglaId: opts.reglaId, forzarSombra: opts.forzarSombra })
        .catch((e) => {
          log(`error inesperado en el loop: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => {
          tickEnCurso = null;
          if (!apagando) setTimeout(loop, INTERVALO_BASE_MS);
        });
    };

    log(`worker arrancado (owner ${OWNER}), tick cada ${INTERVALO_BASE_MS / 1000} s`);
    loop();
    return; // el proceso sigue vivo por los setTimeout + listeners de señales
  }

  // Un tick y sale.
  await tick({ reglaId: opts.reglaId, forzarSombra: opts.forzarSombra });
  await getPool().end().catch(() => {});
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    console.error('run-ad-rules falló:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
