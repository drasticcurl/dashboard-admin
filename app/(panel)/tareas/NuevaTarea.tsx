'use client';

/**
 * NuevaTarea — el modal para crear una tarjeta (falta de T06: la pantalla
 * tenía el drag & drop y el detalle, pero ningún botón que llamara a
 * `POST /api/tareas`. El endpoint y `crearTarea` funcionan desde T05/T02; lo
 * que faltaba era la UI).
 *
 * Mismo Modal reusado de finanzas/ que DetalleTarea, mismo estilo de formulario
 * (labelCls + inputCls/btnPrimary de config/kit) y mismo patrón de fetch con
 * manejo de error que el resto de la pantalla.
 *
 * Reglas de §4 del plan (T05): un no-admin puede crear una tarjeta asignada a
 * CUALQUIERA — crear no está restringido a la propia persona, sólo editar lo
 * está. Por eso el select de "Asignar a" lista a todos los usuarios activos,
 * no sólo a `yo`.
 */

import { useState } from 'react';
import { Modal } from '@/app/(panel)/finanzas/Modal';
import { Banner } from '@/components/ui';
import { btnGhost, btnPrimary, inputCls } from '@/app/(panel)/config/kit';
import type { Prioridad, Tarea } from '@/lib/queries/tareas';
import type { Usuario } from '@/lib/queries/usuarios';
import { PRIORIDADES, etiquetaDePrioridad } from './prioridad';
import type { Yo } from './TableroView';

const labelCls = 'flex flex-col gap-1 text-xs text-neutral-500';

export function NuevaTarea({
  yo,
  usuarios,
  onCerrar,
  onCreada,
}: {
  yo: Yo;
  usuarios: Usuario[];
  onCerrar: () => void;
  onCreada: (t: Tarea) => void;
}): JSX.Element {
  const [titulo, setTitulo] = useState('');
  // Por defecto se asigna a quien la crea: es el caso más común (una nota para
  // uno mismo) y no le impide a nadie reasignarla a otro antes de guardar.
  const [asignadoA, setAsignadoA] = useState(yo.id);
  const [prioridad, setPrioridad] = useState<Prioridad>('media');
  const [venceEl, setVenceEl] = useState('');
  const [notas, setNotas] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function crear(): Promise<void> {
    if (busy || titulo.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/tareas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          titulo: titulo.trim(),
          asignadoA,
          prioridad,
          venceEl: venceEl === '' ? undefined : venceEl,
          notas: notas.trim() === '' ? undefined : notas.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        tarea?: Tarea;
      };
      if (!res.ok || data.ok === false || !data.tarea) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onCreada(data.tarea);
      onCerrar();
    } catch (e) {
      setError(`No se pudo crear la tarea: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    /*
      `ancho="md"` (max-w-xl, 576px) y no `lg`: es el contrato que declara el
      propio Modal —`lg` es para las secciones con TABLA, `md` para un formulario
      solo—. Con `lg` esto eran 896px de modal para cinco campos, un cuadro
      medio vacío que en PC ocupaba dos tercios de la pantalla. El detalle sí se
      queda en `lg` porque abajo lleva las listas de enlaces y comentarios.
    */
    <Modal titulo="Nueva tarea" onCerrar={onCerrar} ancho="md">
      {error && (
        <div className="mb-3">
          <Banner tone="bad">{error}</Banner>
        </div>
      )}

      {/*
        Orden: Título → los tres campos cortos → Notas. Notas estaba SEGUNDO y es
        el único opcional y el más alto de todos: empujaba "Asignar a",
        "Prioridad", "Vence el" y los botones abajo del pliegue, así que en un
        laptop se abría el modal y lo único que se veía era un título y un cuadro
        de texto grande. Lo opcional va al final.
      */}
      <div className="grid gap-4 md:grid-cols-2">
        <label className={`${labelCls} md:col-span-2`}>
          Título
          <input
            className={inputCls}
            value={titulo}
            autoFocus
            onChange={(e) => setTitulo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) crear();
            }}
          />
        </label>

        <label className={labelCls}>
          Asignar a
          <select
            className={inputCls}
            value={asignadoA}
            onChange={(e) => setAsignadoA(Number(e.target.value))}
          >
            {usuarios.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nombre}
                {u.id === yo.id ? ' (yo)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className={labelCls}>
          Prioridad
          <select
            className={inputCls}
            value={prioridad}
            onChange={(e) => setPrioridad(e.target.value as Prioridad)}
          >
            {PRIORIDADES.map((p) => (
              <option key={p} value={p}>
                {etiquetaDePrioridad(p)}
              </option>
            ))}
          </select>
        </label>

        {/* Media columna y no `col-span-2`: un `input type="date"` estirado a
            todo el ancho del modal se ve como un error. La media fila vacía al
            lado es lo normal en un formulario; un campo de fecha de 536px no. */}
        <label className={labelCls}>
          Vence el (opcional)
          <input
            type="date"
            className={inputCls}
            value={venceEl}
            onChange={(e) => setVenceEl(e.target.value)}
          />
        </label>

        <label className={`${labelCls} md:col-span-2`}>
          Notas (opcional)
          <textarea
            className={`${inputCls} min-h-[4rem] resize-y`}
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
          />
        </label>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btnGhost} disabled={busy} onClick={onCerrar}>
          Cancelar
        </button>
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || titulo.trim() === ''}
          onClick={crear}
        >
          {busy ? 'Creando…' : 'Crear tarea'}
        </button>
      </div>
    </Modal>
  );
}
