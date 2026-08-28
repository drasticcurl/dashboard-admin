// Lo monta T06 en FinanzasView.tsx. Hasta entonces nadie lo importa, a propósito.
'use client';

/**
 * CuentasSection — alta, edición, cierre y borrado de las cuentas donde vive la
 * plata (plan `tasks/saldo-cuentas/00-PLAN-SALDO.md` §6, T04 §5).
 *
 * Mismo patrón que `config/sections/ComisionesSection.tsx`: tabla arriba,
 * formulario de alta/edición abajo, y cada mutación seguida de `onCambio()` para
 * que la página vuelva a bajar props frescas.
 *
 * LO QUE HACE DISTINTA A ESTA SECCIÓN: acá hay tres acciones que REESCRIBEN EL
 * PATRIMONIO HISTÓRICO, y ninguna lo parece.
 *
 *  · **Borrar** se lleva los saldos en cascada (D10): días que estaban completos
 *    pasan a tener una cuenta menos y su total baja. Por eso la acción principal
 *    es CERRAR, que no destruye nada y se puede deshacer.
 *  · **Cambiar el `kind`** cambia el SIGNO con el que la cuenta entró a todos sus
 *    días: pasar una cuenta de `dinero` a `deuda` no resta una vez, resta el
 *    doble en cada día que tenga saldo. Es igual de destructivo que borrar y
 *    mucho menos obvio.
 *  · **Mover `opened_on` hacia atrás** hace que los días anteriores empiecen a
 *    esperar esta cuenta, y por D5 un día al que le falta una cuenta deja de
 *    tener patrimonio: el gráfico pierde esos puntos sin que nada los borre.
 *
 * Las tres avisan antes, y las dos que el route sabe medir (`saldosBorrados`,
 * `saldosAfectados`) informan el número REAL después.
 */

import { useState } from 'react';
import type { AccountKind, FinanceAccount } from '@/lib/queries/saldo';
import { Badge, Banner, Card, IconButton, Table } from '@/components/ui';
import { btnGhost, btnPrimary, inputCls } from '../config/kit';
import { etiquetaDia, pedir } from './serie';

const KINDS: AccountKind[] = ['dinero', 'retenido', 'deuda'];

const KIND_LABEL: Record<AccountKind, string> = {
  dinero: 'Dinero',
  retenido: 'Retenido',
  deuda: 'Deuda',
};

const KIND_TONE: Record<AccountKind, 'good' | 'info' | 'bad'> = {
  dinero: 'good',
  retenido: 'info',
  deuda: 'bad',
};

const KIND_HINT: Record<AccountKind, string> = {
  dinero: 'plata disponible: suma al patrimonio',
  retenido: 'plata que es nuestra pero todavía no se puede usar: suma al patrimonio',
  deuda: 'lo que debemos: se RESTA del patrimonio. El saldo se escribe en positivo',
};

type Form = {
  name: string;
  kind: AccountKind;
  openedOn: string;
  closedOn: string;
  sortOrder: string;
};

const FORM_VACIO: Form = { name: '', kind: 'dinero', openedOn: '', closedOn: '', sortOrder: '0' };

export function CuentasSection({
  cuentas,
  onCambio,
}: {
  /** Todas, incluidas las cerradas. */
  cuentas: FinanceAccount[];
  onCambio: () => void;
}): JSX.Element {
  const [form, setForm] = useState<Form>(FORM_VACIO);
  const [editId, setEditId] = useState<number | null>(null);
  /** true cuando el formulario se abrió desde «Cerrar»: cambia el copy y el foco. */
  const [cerrando, setCerrando] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const original = editId === null ? null : (cuentas.find((c) => c.id === editId) ?? null);

  async function conBusy(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setBusy(false);
    }
  }

  function cancelar(): void {
    setEditId(null);
    setCerrando(false);
    setForm(FORM_VACIO);
  }

  function editar(c: FinanceAccount, paraCerrar = false): void {
    setEditId(c.id);
    setCerrando(paraCerrar);
    setError(null);
    setOk(null);
    setForm({
      name: c.name,
      kind: c.kind,
      openedOn: c.openedOn,
      // Al abrir desde «Cerrar» el campo arranca VACÍO a propósito: el día en
      // que la cuenta dejó de usarse lo sabe el usuario, y no se puede poner
      // "hoy" por default porque este componente no recibe el `hoy` del server
      // (en DASHBOARD_TZ) y `new Date()` del browser es el bug de la TZ que el
      // resto del módulo evita. Ver la nota en el §10 del plan.
      closedOn: paraCerrar ? '' : (c.closedOn ?? ''),
      sortOrder: String(c.sortOrder),
    });
  }

  function faltaParaGuardar(): string | null {
    if (form.name.trim().length === 0) return 'falta el nombre de la cuenta';
    if (form.openedOn !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(form.openedOn)) {
      return 'la fecha de apertura está incompleta';
    }
    if (form.closedOn !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(form.closedOn)) {
      return 'la fecha de cierre está incompleta';
    }
    if (form.closedOn !== '' && form.openedOn !== '' && form.closedOn < form.openedOn) {
      return 'la fecha de cierre no puede ser anterior a la de apertura';
    }
    if (cerrando && form.closedOn === '') return 'elegí el día en que la cuenta dejó de usarse';
    return null;
  }

  const falta = faltaParaGuardar();

  async function guardar(): Promise<void> {
    await conBusy(async () => {
      // La validación va DENTRO del try, así el error se ve en pantalla en lugar
      // de terminar como unhandled rejection en la consola.
      const problema = faltaParaGuardar();
      if (problema !== null) throw new Error(problema);

      const sortOrder = Number(form.sortOrder);
      if (!Number.isInteger(sortOrder)) throw new Error('el orden tiene que ser un número entero');

      if (editId === null) {
        await pedir('/api/finanzas/cuentas', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name.trim(),
            kind: form.kind,
            // Vacío = que lo resuelva la base. Mandar una fecha del browser acá
            // es lo que metería el corrimiento de zona horaria.
            ...(form.openedOn === '' ? {} : { openedOn: form.openedOn }),
            sortOrder,
          }),
        });
        setOk(
          `Cuenta «${form.name.trim()}» creada. Desde su día de apertura se le pide saldo, y hasta que la cargues ese día queda incompleto.`,
        );
      } else {
        const cambiaKind = original !== null && original.kind !== form.kind;
        if (cambiaKind && !confirm(avisoDeKind(original!, form.kind))) return;

        const res = await pedir<{ saldosAfectados?: number }>('/api/finanzas/cuentas', {
          method: 'PATCH',
          body: JSON.stringify({
            id: editId,
            name: form.name.trim(),
            kind: form.kind,
            openedOn: form.openedOn === '' ? undefined : form.openedOn,
            // `null` REABRE la cuenta. Es distinto de no mandar el campo, y por
            // eso viaja explícito: en el UPDATE de la base, "no vino" y "vino
            // null" tienen que poder decir cosas distintas.
            closedOn: form.closedOn === '' ? null : form.closedOn,
            sortOrder,
          }),
        });
        // El número real llega recién en la respuesta: el route cuenta los
        // saldos que quedaron afectados y la UI lo informa después de aplicar.
        setOk(
          typeof res.saldosAfectados === 'number' && res.saldosAfectados > 0
            ? `Cuenta actualizada. Cambió el signo con el que entra a ${res.saldosAfectados} saldo${
                res.saldosAfectados === 1 ? '' : 's'
              } ya cargado${res.saldosAfectados === 1 ? '' : 's'}: revisá el patrimonio de esos días.`
            : form.closedOn !== ''
              ? `Cuenta cerrada el ${form.closedOn}. Desde el día siguiente ya no se le pide saldo, y su historial queda intacto.`
              : 'Cuenta actualizada.',
        );
      }
      cancelar();
      onCambio();
    });
  }

  async function reabrir(c: FinanceAccount): Promise<void> {
    await conBusy(async () => {
      // Reabrir no necesita ninguna fecha, así que no toca el problema de la TZ.
      await pedir('/api/finanzas/cuentas', {
        method: 'PATCH',
        body: JSON.stringify({ id: c.id, closedOn: null }),
      });
      setOk(
        `«${c.name}» vuelve a estar vigente. Desde hoy se le pide saldo otra vez, así que los días sin cargar de esta cuenta quedan incompletos.`,
      );
      onCambio();
    });
  }

  async function borrar(c: FinanceAccount): Promise<void> {
    /*
      El `confirm()` no puede decir el número de saldos que se van: el conteo lo
      devuelve el DELETE, o sea después de borrar (T03 §3). Así que el aviso
      nombra la CONSECUENCIA completa y el número real se informa al volver.
      Está anotado en el §10 del plan: con un GET que traiga el conteo por cuenta
      —o un `?dryRun=1`— el confirm podría decirlo antes.
    */
    const aviso =
      `Borrar «${c.name}» borra TAMBIÉN todos los saldos que tenga cargados, y con eso el ` +
      `patrimonio de esos días CAMBIA: días que estaban completos van a quedar con una cuenta ` +
      `menos y su total va a bajar.\n\n` +
      `Si la cuenta dejó de usarse, lo correcto es CERRARLA: conserva el historial y se puede ` +
      `reabrir.\n\n¿Borrar igual?`;
    if (!confirm(aviso)) return;

    await conBusy(async () => {
      const res = await pedir<{ saldosBorrados?: number }>(
        `/api/finanzas/cuentas?id=${c.id}`,
        { method: 'DELETE' },
      );
      const n = res.saldosBorrados ?? 0;
      setOk(
        n > 0
          ? `Cuenta «${c.name}» borrada, y con ella ${n} saldo${n === 1 ? '' : 's'} cargado${
              n === 1 ? '' : 's'
            }. El patrimonio de esos días ya no es el mismo.`
          : `Cuenta «${c.name}» borrada. No tenía ningún saldo cargado, así que no cambió ningún patrimonio.`,
      );
      if (editId === c.id) cancelar();
      onCambio();
    });
  }

  const vigentes = cuentas.filter((c) => c.closedOn === null).length;

  return (
    <Card
      title="Cuentas"
      hint="Donde vive la plata. El patrimonio es la suma de estos saldos: dinero + retenido − deuda. Cerrar una cuenta conserva su historial; borrarla lo reescribe."
    >
      {error && (
        <div className="mb-3">
          <Banner tone="bad" title="No se pudo">
            {error}
          </Banner>
        </div>
      )}
      {ok && (
        <div className="mb-3">
          <Banner tone="good" title="Listo">
            {ok}
          </Banner>
        </div>
      )}

      <p className="mb-3 text-xs text-neutral-500">
        {vigentes === 0
          ? 'No hay ninguna cuenta vigente, así que ningún día puede estar completo y el patrimonio no se puede medir.'
          : `Hoy se piden ${vigentes} saldo${vigentes === 1 ? '' : 's'} por día. Si falta uno, ese día no tiene patrimonio y no aparece en el gráfico.`}
      </p>

      <Table
        rows={cuentas}
        empty="Todavía no hay cuentas. Creá la primera abajo."
        columns={[
          {
            key: 'name',
            header: 'Cuenta',
            render: (c) => (
              <span className="flex items-center gap-2">
                <span className={c.closedOn === null ? 'text-neutral-200' : 'text-neutral-500'}>
                  {c.name}
                </span>
                {/* Una cuenta cerrada NO se esconde de la lista: una cuenta que
                    desaparece es una cuenta que el usuario cree que perdió. */}
                {c.closedOn !== null && <Badge tone="neutral">Cerrada</Badge>}
              </span>
            ),
          },
          {
            key: 'kind',
            header: 'Tipo',
            render: (c) => <Badge tone={KIND_TONE[c.kind]}>{KIND_LABEL[c.kind]}</Badge>,
          },
          {
            key: 'vigencia',
            header: 'Vigencia',
            render: (c) => (
              <span className="whitespace-nowrap text-xs text-neutral-400">
                desde {etiquetaDia(c.openedOn)}/{c.openedOn.slice(0, 4)}
                {c.closedOn !== null && (
                  <> · hasta {etiquetaDia(c.closedOn)}/{c.closedOn.slice(0, 4)}</>
                )}
              </span>
            ),
          },
          {
            key: 'sortOrder',
            header: 'Orden',
            align: 'right',
            render: (c) => <span className="tabular-nums">{c.sortOrder}</span>,
          },
          {
            key: 'acciones',
            header: '',
            align: 'right',
            render: (c) => (
              <span className="flex justify-end gap-1.5">
                <button
                  type="button"
                  className={btnGhost}
                  disabled={busy}
                  onClick={() => editar(c)}
                >
                  Editar
                </button>
                {/* La acción principal es CERRAR, no borrar (D10). */}
                {c.closedOn === null ? (
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={busy}
                    onClick={() => editar(c, true)}
                  >
                    Cerrar
                  </button>
                ) : (
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={busy}
                    onClick={() => reabrir(c)}
                  >
                    Reabrir
                  </button>
                )}
                <IconButton
                  label={`Borrar la cuenta ${c.name} y todos sus saldos`}
                  onClick={() => borrar(c)}
                  disabled={busy}
                >
                  <span aria-hidden>✕</span>
                </IconButton>
              </span>
            ),
          },
        ]}
      />

      <div className="mt-4 rounded-xl border border-border-subtle bg-overlay/2 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {editId === null
            ? 'Agregar cuenta'
            : cerrando
              ? `Cerrar «${original?.name ?? ''}»`
              : `Editar «${original?.name ?? ''}»`}
        </p>

        {cerrando && (
          <div className="mb-3">
            <Banner tone="info" title="Cerrar no borra nada">
              Elegí el día en que la cuenta dejó de usarse. Desde el día siguiente ya no se le pide
              saldo, y todos los días anteriores conservan el suyo. Se puede reabrir cuando quieras.
            </Banner>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Nombre
            <input
              className={inputCls}
              maxLength={120}
              placeholder="Mercado Pago"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Tipo
            <select
              className={inputCls}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as AccountKind })}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Apertura {editId === null && <span className="text-neutral-600">(vacío = hoy)</span>}
            <input
              className={inputCls}
              type="date"
              value={form.openedOn}
              onChange={(e) => setForm({ ...form, openedOn: e.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Cierre <span className="text-neutral-600">(vacío = vigente)</span>
            <input
              className={inputCls}
              type="date"
              value={form.closedOn}
              onChange={(e) => setForm({ ...form, closedOn: e.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Orden en la lista
            <input
              className={inputCls}
              inputMode="numeric"
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
            />
          </label>
        </div>

        <p className="mt-2 max-w-[80ch] text-pretty text-xs leading-relaxed text-neutral-500">
          {KIND_LABEL[form.kind]}: {KIND_HINT[form.kind]}.
        </p>

        {/* La apertura no es auditoría, es aritmética (D6): decide desde qué día
            se le pide saldo a esta cuenta. Ponerla antes de hoy vuelve
            incompletos días que ya estaban completos, y el gráfico pierde esos
            puntos sin que nada los haya borrado. */}
        <p className="mt-1 max-w-[80ch] text-pretty text-xs leading-relaxed text-neutral-500">
          La fecha de apertura decide desde cuándo se le pide saldo a esta cuenta. Si la pones
          antes de hoy, los días anteriores pasan a esperar esta cuenta: los que ya estaban
          completos quedan incompletos y desaparecen del gráfico hasta que les cargues el saldo.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={btnPrimary} disabled={busy} onClick={guardar}>
            {editId === null ? 'Agregar' : cerrando ? 'Cerrar la cuenta' : 'Guardar cambios'}
          </button>
          {editId !== null && (
            <button type="button" className={btnGhost} disabled={busy} onClick={cancelar}>
              Cancelar
            </button>
          )}
          {/* El botón se deshabilita SÓLO mientras hay un pedido en vuelo; lo que
              falta se dice acá al lado. Un botón gris sin motivo es un callejón
              sin salida (registro.md, 2026-08-24). */}
          {!busy && falta !== null && (
            <span className="text-xs text-warn-300" aria-live="polite">
              {falta}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

/** El aviso de cambiar el `kind`: nombra el signo, que es lo que en realidad cambia. */
function avisoDeKind(original: FinanceAccount, nuevo: AccountKind): string {
  const signo = (k: AccountKind): string => (k === 'deuda' ? 'se RESTA' : 'SUMA');
  return (
    `«${original.name}» pasa de ${KIND_LABEL[original.kind]} a ${KIND_LABEL[nuevo]}.\n\n` +
    `Eso cambia el signo con el que entra al patrimonio en TODOS los días que tenga saldo ` +
    `cargado: hasta ahora ${signo(original.kind)}, de ahora en más ${signo(nuevo)}. ` +
    `El patrimonio histórico se reescribe, igual que si borraras la cuenta, pero sin que ` +
    `desaparezca nada.\n\n¿Seguir?`
  );
}
