// Lo monta T06 en FinanzasView.tsx. Hasta entonces nadie lo importa, a propósito.
'use client';

/**
 * CargaDiaria — el formulario con el que el patrimonio se MIDE
 * (plan `tasks/saldo-cuentas/00-PLAN-SALDO.md` §6, T04 §4).
 *
 * UN formulario, UNA fila por cuenta vigente, UN botón. No cuatro formularios:
 * el usuario carga una vez al día y, por D5, cargar 3 de 4 no le sirve de nada
 * (un día al que le falta una cuenta no tiene patrimonio). El botón manda TODAS
 * las cuentas en un solo `POST /api/finanzas/saldos`, que es una transacción: si
 * la tercera falla no puede quedar un día a medio guardar mientras el usuario ya
 * cree que guardó.
 *
 * Las tres reglas que parecen cosméticas y no lo son:
 *
 *  1. **El día arranca en `hoy`, que viene del server** (resuelto en
 *     `DASHBOARD_TZ`), nunca en `new Date()`. Un saldo cargado de noche quedaría
 *     con el día de mañana según la TZ del browser — es el mismo bug que ya se
 *     arregló en el formulario de movimientos.
 *  2. **Un campo vacío es `null` y BORRA el saldo; un `0` tipeado es un saldo de
 *     cero.** Son dos cosas distintas y la base las distingue: "no hay fila" es
 *     un día incompleto, "una fila en 0" es una cuenta vacía. Por eso el parseo
 *     va con `parsearSaldo` (que acepta el cero) y no con `parsearMonto`.
 *  3. **Una cuenta `deuda` pide el número POSITIVO** ("cuánto debemos") y el `−`
 *     se muestra AFUERA del input. Nunca se le pide a la persona escribir un
 *     negativo: el signo lo pone el `kind` al leer (D4).
 */

import { useEffect, useMemo, useState } from 'react';
import { formatearMontoParaInput } from '@/lib/monto';
import type { AccountWithBalance } from '@/lib/queries/saldo';
import { Badge, Banner, EmptyState, Spinner, fmtMoney } from '@/components/ui';
import { btnGhost, btnPrimary, inputCls } from '../config/kit';
import { Modal } from './Modal';
import {
  leerPatrimonio,
  parsearSaldo,
  pedir,
  signoDeSaldo,
  totalTipeado,
  type FilaTipeada,
} from './serie';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';

const KIND_LABEL: Record<AccountWithBalance['kind'], string> = {
  dinero: 'Dinero',
  retenido: 'Retenido',
  deuda: 'Deuda',
};

const KIND_TONE: Record<AccountWithBalance['kind'], 'good' | 'info' | 'bad'> = {
  dinero: 'good',
  retenido: 'info',
  deuda: 'bad',
};

/** El texto de los campos, uno por `accountId`. `''` = sin cargar. */
type Valores = Record<number, string>;

/**
 * Con qué arrancan los campos.
 *
 * Sólo se precargan cuando el día elegido es HOY, porque las props traen el
 * saldo de hoy y nada más: no hay endpoint que devuelva los saldos de un día
 * arbitrario (T03 expone `POST /saldos`, no un GET). Precargar los números de
 * hoy en el formulario de otro día sería peor que dejarlo vacío — copiaría el
 * saldo de hoy a un día del pasado sin que nada lo diga.
 */
function valoresIniciales(cuentas: AccountWithBalance[], esHoy: boolean): Valores {
  const out: Valores = {};
  for (const c of cuentas) {
    out[c.id] = esHoy && c.amountEur !== null ? formatearMontoParaInput(c.amountEur) : '';
  }
  return out;
}

export function CargaDiaria({
  cuentas,
  hoy,
  onGuardado,
  onCerrar,
}: {
  /** Las vigentes hoy, con el saldo de hoy si ya está cargado. */
  cuentas: AccountWithBalance[];
  /** 'YYYY-MM-DD' en DASHBOARD_TZ, resuelto en el server. */
  hoy: string;
  /** T06 pasa el `router.refresh()`. */
  onGuardado: () => void;
  /**
   * Cierra el modal. El componente monta su propio `<Modal>` desde el rediseño
   * v3 y no lo recibe como envoltorio: el pie con el resumen y los botones
   * necesita el `total` y el `guardar()` que viven acá, y pasarlos para arriba
   * significaba duplicar el estado del formulario en FinanzasView.
   */
  onCerrar: () => void;
}): JSX.Element {
  const [day, setDay] = useState(hoy);
  const [valores, setValores] = useState<Valores>(() => valoresIniciales(cuentas, true));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const esHoy = day === hoy;

  // `onGuardado` es un `router.refresh()`, que re-ejecuta la página y baja
  // props nuevas: este efecto es el que las adopta. Mismo patrón que los tres
  // `useEffect` de FinanzasView. También corre al cambiar de día, y ahí el
  // baseline es "todo vacío" por el motivo de `valoresIniciales`.
  useEffect(() => {
    setValores(valoresIniciales(cuentas, day === hoy));
  }, [cuentas, day, hoy]);

  const filas: FilaTipeada[] = useMemo(
    () => cuentas.map((c) => ({ kind: c.kind, raw: valores[c.id] ?? '' })),
    [cuentas, valores],
  );

  // El total que va a quedar, con el signo de cada cuenta ya aplicado. Es la
  // única forma de que el usuario note que puso un número de más ANTES de
  // guardar.
  const total = totalTipeado(filas);

  /**
   * Qué le falta al formulario, en palabras. `null` cuando está listo.
   *
   * El botón NO se deshabilita con esto: se deshabilita sólo mientras hay un
   * pedido en vuelo. Un botón gris sin explicación fue el síntoma que se reportó
   * la última vez (registro.md, 2026-08-24), y la causa era exactamente esto:
   * un booleano que apagaba el botón sin decir por qué.
   */
  function faltaParaGuardar(): string | null {
    for (const c of cuentas) {
      const raw = valores[c.id] ?? '';
      if (raw.trim() === '') continue;
      const n = parsearSaldo(raw);
      if (!n.ok) return `${c.name}: ${n.error}`;
    }
    if (total.cargadas === 0) {
      return esHoy
        ? 'no escribiste ningún saldo (vaciar todos los campos borraría los de hoy)'
        : 'no escribiste ningún saldo';
    }
    return null;
  }

  const falta = faltaParaGuardar();

  async function guardar(): Promise<void> {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      // La validación va DENTRO del try: tirándola desde afuera, el error
      // terminaba como unhandled rejection en la consola del browser en lugar
      // de aparecer en pantalla (ya pasó en el formulario de movimientos).
      const payload: Array<{ accountId: number; amountEur: number | null; note?: string | null }> = [];
      for (const c of cuentas) {
        const raw = (valores[c.id] ?? '').trim();

        if (raw === '') {
          // Un campo vacío es `null`, que BORRA el saldo de esa cuenta ese día.
          // Pero eso sólo es una intención cuando estamos en HOY, que es el
          // único día cuyos saldos el formulario conoce: en otro día "vacío"
          // significa "no sé qué hay cargado" (ver `valoresIniciales`), así que
          // la fila se omite en lugar de mandar un borrado que nadie pidió.
          if (esHoy) payload.push({ accountId: c.id, amountEur: null });
          continue;
        }

        const n = parsearSaldo(raw);
        if (!n.ok) throw new Error(`${c.name}: ${n.error}`);
        payload.push({
          accountId: c.id,
          amountEur: n.valor,
          // El monto viaja SIEMPRE positivo: el signo lo pone el `kind` al leer
          // (D4). Acá no se aplica `signoDeSaldo` a propósito.
          //
          // La nota se reenvía tal como vino porque el upsert la sobreescribe
          // (`note = EXCLUDED.note`): sin esto, guardar los saldos borraría una
          // nota cargada por la API. Este formulario no tiene campo de nota, así
          // que sólo puede conservar la de hoy.
          note: esHoy ? c.note : undefined,
        });
      }

      if (payload.length === 0) throw new Error('no hay ningún saldo para guardar');

      // El route contesta el SOBRE `{ ok, patrimonio }`, no el patrimonio
      // pelado. `pedir<T>` no lo verifica (hace `body as T`), así que la forma
      // se lee con `leerPatrimonio`, que sí la chequea y tiene test. La primera
      // versión de esto pedía `pedir<{ totalEur, completo, faltan }>` y reventó
      // en producción con `undefined is not an object` — con los saldos ya
      // guardados y el usuario creyendo que no.
      const res = leerPatrimonio(
        await pedir('/api/finanzas/saldos', {
          method: 'POST',
          body: JSON.stringify({ day, saldos: payload }),
        }),
      );

      // El mensaje dice si el día quedó COMPLETO, y si no, qué falta. Guardar
      // parcial está permitido; lo que no está permitido es que el usuario crea
      // que el día ya cuenta cuando el gráfico todavía no lo va a dibujar (D5).
      setOk(
        res.completo && res.totalEur !== null
          ? `Guardado. El ${day} queda en ${fmtMoney(res.totalEur, MONEDA_REPORTE)}.`
          : `Guardado, pero el ${day} sigue incompleto: falta el saldo de ${res.faltan.join(', ')}. ` +
              'Hasta que estén todas, ese día no tiene patrimonio y no aparece en el gráfico.',
      );
      onGuardado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setBusy(false);
    }
  }

  if (cuentas.length === 0) {
    return (
      <Modal titulo="Corregir saldos" onCerrar={onCerrar}>
        <EmptyState
          title="Todavía no hay cuentas vigentes"
          hint="El patrimonio se mide sumando el saldo de cada cuenta, así que primero hay que crear las cuentas donde vive la plata. Se administran en «Cuentas»."
        />
      </Modal>
    );
  }

  /**
   * Cuántas cuentas cambian de número con lo que está escrito, para el resumen
   * del pie.
   *
   * Se cuenta contra el saldo REGISTRADO y no contra "el campo tiene algo":
   * reabrir el modal precarga los saldos de hoy, así que con el criterio ingenuo
   * el pie diría "6 ajustes" sin que el usuario haya tocado nada — y eso
   * convierte al resumen en ruido, que es lo mismo que no tenerlo.
   */
  const ajustes = esHoy
    ? cuentas.filter((c) => {
        const raw = (valores[c.id] ?? '').trim();
        if (raw === '') return c.amountEur !== null; // vaciar un saldo cargado ES un cambio
        const n = parsearSaldo(raw);
        return n.ok && n.valor !== c.amountEur;
      }).length
    : cuentas.filter((c) => (valores[c.id] ?? '').trim() !== '').length;

  const pie = (
    /*
      Compacto a propósito. Medido a 390px, la versión anterior de este pie medía
      195px de alto: con un encabezado de 125 y un viewport de 844, al cuerpo le
      quedaban 474px, o sea que el modal se leía como "la mitad de un cuadro" —
      que es exactamente cómo lo reportó el usuario.

      Ahora en mobile el total y los botones van en UNA fila (el total a la
      izquierda, los botones a la derecha) y el detalle de qué falta queda en una
      sola línea recortable. En desktop, donde hay lugar, se despliega en dos
      filas con la explicación completa.
    */
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] max-panel:text-xs font-medium text-neutral-400">
            {total.completo ? `Patrimonio del ${day}` : 'Suma parcial'}
          </p>
          <p
            className={`num font-mono text-lg font-medium leading-tight ${
              total.completo
                ? total.totalEur < 0
                  ? 'text-bad-400'
                  : 'text-neutral-50'
                : 'text-neutral-400'
            }`}
          >
            {fmtMoney(total.totalEur, MONEDA_REPORTE)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className={btnGhost} onClick={onCerrar} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={guardar}>
            {ajustes === 0 ? 'Guardar' : `Guardar ${ajustes}`}
          </button>
        </div>
      </div>

      {/* El estado, en una línea. `truncate` en mobile para que no empuje la
          altura del pie; el texto completo queda en el `title`. */}
      <p
        className="truncate text-[11px] max-panel:text-xs text-neutral-500 panel:whitespace-normal"
        aria-live="polite"
        title={
          busy
            ? 'Guardando…'
            : (falta ??
              (total.completo
                ? `Están las ${total.esperadas} cuentas: este día va a contar en el gráfico.`
                : `Faltan ${total.esperadas - total.cargadas} de ${total.esperadas} — así como está, este día NO tiene patrimonio y no se dibuja.`))
        }
      >
        {busy ? (
          <span className="flex items-center gap-2">
            <Spinner /> Guardando…
          </span>
        ) : falta !== null ? (
          <span className="text-warn-300">{falta}</span>
        ) : total.completo ? (
          `Están las ${total.esperadas} cuentas: este día va a contar en el gráfico.`
        ) : (
          `Faltan ${total.esperadas - total.cargadas} de ${total.esperadas}: se puede guardar, pero el día queda incompleto.`
        )}
      </p>
    </div>
  );

  return (
    <Modal
      titulo="Corregir saldos"
      descripcion="Una vez al día: mirá cada cuenta y escribí cuánto hay de verdad. El patrimonio es esta suma, no un cálculo. Un día cuenta sólo si están TODAS las cuentas."
      onCerrar={onCerrar}
      pie={pie}
    >
      {error && (
        <div className="mb-3">
          <Banner tone="bad" title="No se pudo guardar">
            {error}
          </Banner>
        </div>
      )}
      {ok && (
        <div className="mb-3">
          <Banner tone={ok.includes('incompleto') ? 'warn' : 'good'} title="Listo">
            {ok}
          </Banner>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Día de los saldos
          <input
            className={`${inputCls} h-11`}
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
        {esHoy ? (
          <p className="pb-3 text-xs text-neutral-500">Hoy, en la zona horaria del panel.</p>
        ) : (
          <button type="button" className={`${btnGhost} tap mb-1`} onClick={() => setDay(hoy)}>
            Volver a hoy ({hoy})
          </button>
        )}
      </div>

      {!esHoy && (
        <div className="mb-4">
          {/* Sin un GET de saldos por día, el formulario no puede saber qué hay
              cargado en otro día. Decirlo es la diferencia entre una limitación y
              un misterio. */}
          <Banner tone="info" title={`Estás cargando el ${day}, no hoy`}>
            Los campos arrancan vacíos porque el panel no puede leer qué está cargado en otro día.
            Lo que escribas REEMPLAZA el saldo de esa cuenta ese día; lo que dejes vacío queda
            como está (no se borra).
          </Banner>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {cuentas.map((c) => {
          const raw = valores[c.id] ?? '';
          const n = raw.trim() === '' ? null : parsearSaldo(raw);
          const yaCargado = esHoy && c.amountEur !== null;
          // La diferencia contra el saldo REGISTRADO, en vivo. Sólo tiene sentido
          // en hoy: en otro día el panel no sabe qué hay cargado (ver
          // `valoresIniciales`), así que compararlo sería inventar un baseline.
          const diferencia =
            esHoy && n !== null && n.ok && c.amountEur !== null ? n.valor - c.amountEur : null;

          return (
            <div
              key={c.id}
              className="grid items-center gap-x-3 gap-y-2 rounded-xl border border-border-subtle bg-overlay/2 p-3 panel:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <label
                  htmlFor={`saldo-${c.id}`}
                  className="truncate text-sm font-medium text-neutral-200"
                  title={c.name}
                >
                  {c.name}
                </label>
                <Badge tone={KIND_TONE[c.kind]}>{KIND_LABEL[c.kind]}</Badge>
                {/* `whitespace-nowrap`: "Falta hoy" partido en dos líneas dentro
                    de una fila de 44px de alto rompe la alineación de todas las
                    demás. */}
                {esHoy && c.amountEur === null && (
                  <span className="whitespace-nowrap rounded-md border border-good-700 px-1.5 py-0.5 text-[11px] max-panel:text-xs font-medium text-good-300">
                    Falta hoy
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 panel:justify-end">
                <div className="flex flex-col gap-0.5 text-right">
                  <span className="whitespace-nowrap text-[11px] max-panel:text-xs text-neutral-600">Registrado</span>
                  <span className="whitespace-nowrap font-mono text-xs tabular-nums text-neutral-500">
                    {c.amountEur === null || !esHoy
                      ? '—'
                      : fmtMoney(signoDeSaldo(c.kind, c.amountEur), MONEDA_REPORTE)}
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  {/* El `−` de la deuda va AFUERA del input: la persona escribe
                      cuánto debe, en positivo, y el signo se muestra para que no
                      haya dudas de cómo entra al total (D4). */}
                  <span
                    aria-hidden
                    className={`w-3 text-center font-mono text-sm ${
                      c.kind === 'deuda' ? 'text-bad-400' : 'text-neutral-600'
                    }`}
                  >
                    {c.kind === 'deuda' ? '−' : '+'}
                  </span>
                  {/* 44px de alto (h-11): es el mínimo táctil del handoff y este
                      es el campo que se tipea con el pulgar todos los días. */}
                  <input
                    id={`saldo-${c.id}`}
                    className={`${inputCls} h-11 w-28 text-right font-mono text-base tabular-nums`}
                    inputMode="decimal"
                    /* "sin cargar" y no "0.00": el placeholder es lo que
                       distingue un campo vacío (que no cuenta, y al guardar borra)
                       de un cero tipeado (que es una cuenta vacía, y sí cuenta). */
                    placeholder="sin cargar"
                    aria-label={`Saldo real de ${c.name}${c.kind === 'deuda' ? ' (cuánto se debe, en positivo)' : ''}`}
                    value={raw}
                    onChange={(e) => setValores({ ...valores, [c.id]: e.target.value })}
                  />
                </div>
              </div>

              {/* La diferencia en vivo, a todo el ancho de la fila. Es lo que
                  convierte "escribí un número" en "esto es el ajuste que estoy
                  haciendo": sin ella, corregir 4.812,30 a 4.821,30 se ve igual
                  que no cambiar nada. */}
              <div className="text-xs panel:col-span-2">
                {n !== null && !n.ok ? (
                  <span className="text-pretty text-warn-300" aria-live="polite">
                    {n.error}
                  </span>
                ) : diferencia !== null && diferencia !== 0 ? (
                  <span
                    className="font-mono tabular-nums text-good-400"
                    aria-live="polite"
                  >
                    Ajuste {diferencia > 0 ? '+' : '−'}
                    {fmtMoney(Math.abs(diferencia), MONEDA_REPORTE)}
                  </span>
                ) : diferencia === 0 ? (
                  <span className="text-neutral-600">Sin diferencia</span>
                ) : n === null ? (
                  <span className="text-neutral-600">
                    {yaCargado ? 'vaciar el campo BORRA este saldo' : 'sin cargar'}
                  </span>
                ) : (
                  <span className="font-mono tabular-nums text-neutral-400">
                    Queda en {fmtMoney(signoDeSaldo(c.kind, n.valor), MONEDA_REPORTE)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-xs text-neutral-500">
        Los decimales van con coma: <span className="text-neutral-400">1234,56</span>. Un{' '}
        <span className="text-neutral-400">0</span> es una cuenta vacía y cuenta como cargada; el
        campo en blanco es &laquo;sin cargar&raquo;.
      </p>
    </Modal>
  );
}
