'use client';

/**
 * DetalleTarea — el modal de detalle de una tarjeta (T06 §5).
 *
 * ── Por qué el Modal se importa desde finanzas/ ─────────────────────────────
 *
 * `app/(panel)/finanzas/Modal.tsx` es el ÚNICO modal accesible del repo: Escape,
 * click en el fondo por onMouseDown (con onClick, arrastrar para seleccionar un
 * texto de adentro y soltar afuera cerraba el modal y perdía lo tipeado), foco
 * que entra y VUELVE al botón que lo abrió (con `?.` porque ese botón pudo
 * desaparecer del DOM), trampa de foco Tab/Shift+Tab, scroll del fondo bloqueado
 * y role="dialog" aria-modal.
 *
 * Se REUSA donde está, no se muda ni se copia (T06 §3):
 *  1. Mudarlo a components/Modal.tsx obliga a editar FinanzasView.tsx y sus
 *     secciones para el nuevo import, y esos archivos no son de este task.
 *  2. FinanzasView.tsx está modificado sin commitear: tocar sus imports no se
 *     revierte limpio.
 *  3. Copiarlo crea dos focus traps que divergen en tres meses y uno queda sin
 *     la corrección del otro — y este trae cinco decisiones que son cinco bugs
 *     que ya pasaron.
 * La deuda (mudarlo cuando finanzas/ esté limpio) queda anotada en §11 del plan.
 */

import { useState } from 'react';
import { Plus, Trash, X } from '@phosphor-icons/react';
import { Modal } from '@/app/(panel)/finanzas/Modal';
import { Banner } from '@/components/ui';
import { btnGhost, btnPrimary, inputCls } from '@/app/(panel)/config/kit';
import type { Columna, Prioridad, Tarea } from '@/lib/queries/tareas';
import type { Usuario } from '@/lib/queries/usuarios';
import { ETIQUETA_COLUMNA, ORDEN_COLUMNAS, puedeEditar, type Yo } from './TableroView';
import { PRIORIDADES, etiquetaDePrioridad } from './prioridad';

/** El DELETE de T05 devuelve cuántos comentarios se van con la tarjeta. Campo
 *  opcional: si T05 todavía no mergeó, la respuesta no lo trae y no rompe. */
type RespuestaBorrado = { ok: boolean; comentariosBorrados?: number };

const labelCls = 'flex flex-col gap-1 text-xs text-neutral-500';

export function DetalleTarea({
  tarea,
  yo,
  usuarios,
  onCerrar,
  onActualizada,
  onBorrada,
  onMover,
}: {
  tarea: Tarea;
  yo: Yo;
  usuarios: Usuario[];
  onCerrar: () => void;
  onActualizada: (t: Tarea) => void;
  onBorrada: (id: number) => void;
  /** Cambio de columna desde el select: lo maneja TableroView, que tiene el
   *  estado del tablero para reescribir el orden de la columna destino (D12).
   *  Lanza si el POST a /api/tareas/mover falla, para que `guardar` lo muestre. */
  onMover: (id: number, columna: Columna) => Promise<void>;
}): JSX.Element {
  const editable = puedeEditar(yo, tarea);
  const dueno = usuarios.find((u) => u.id === tarea.asignadoA);
  const nombreDueno = tarea.asignadoNombre || dueno?.nombre || 'otra persona';

  const [titulo, setTitulo] = useState(tarea.titulo);
  const [notas, setNotas] = useState(tarea.notas ?? '');
  const [asignadoA, setAsignadoA] = useState(tarea.asignadoA);
  const [prioridad, setPrioridad] = useState<Prioridad>(tarea.prioridad);
  const [columna, setColumna] = useState<Columna>(tarea.columna);
  const [venceEl, setVenceEl] = useState(tarea.venceEl ?? '');

  const [links, setLinks] = useState(tarea.links);
  const [comentarios, setComentarios] = useState(tarea.comentarios);

  const [nuevaUrl, setNuevaUrl] = useState('');
  const [nuevaEtiqueta, setNuevaEtiqueta] = useState('');
  const [nuevoComentario, setNuevoComentario] = useState('');

  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirmandoBorrado, setConfirmandoBorrado] = useState(false);

  async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      ...init,
    });
    const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async function guardar(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFlash(null);
    try {
      // notas vacía va como null, no como '': el PATCH distingue "borrar" de "no
      // tocar" con null vs ausente. `columna` NO va en el PATCH: el contrato de
      // §6 mueve de columna por /api/tareas/mover (reescribe el orden entero,
      // D12), no por el PATCH — que ni siquiera acepta el campo.
      const cambios = {
        id: tarea.id,
        titulo: titulo.trim(),
        notas: notas.trim() === '' ? null : notas.trim(),
        asignadoA,
        prioridad,
        venceEl: venceEl === '' ? null : venceEl,
      };
      const { tarea: actualizada } = await api<{ tarea: Tarea }>('/api/tareas', {
        method: 'PATCH',
        body: JSON.stringify(cambios),
      });
      // Primero el resultado del PATCH (títulos, notas, etc.), DESPUÉS el
      // movimiento de columna si lo hubo: así la columna+posicion que escribe
      // moverDesdeDetalle quedan como estado final y no las pisa la posicion
      // vieja que trae el PATCH.
      onActualizada(actualizada);
      if (columna !== tarea.columna) {
        await onMover(tarea.id, columna);
      }
      setFlash({ tone: 'good', text: 'Guardado.' });
    } catch (e) {
      setFlash({ tone: 'bad', text: `No se pudo guardar: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function agregarLink(): Promise<void> {
    if (busy || nuevaUrl.trim() === '') return;
    setBusy(true);
    setFlash(null);
    try {
      const { link } = await api<{ link: Tarea['links'][number] }>('/api/tareas/links', {
        method: 'POST',
        body: JSON.stringify({
          tareaId: tarea.id,
          url: nuevaUrl.trim(),
          etiqueta: nuevaEtiqueta.trim() === '' ? undefined : nuevaEtiqueta.trim(),
        }),
      });
      const proximos = [...links, link];
      setLinks(proximos);
      setNuevaUrl('');
      setNuevaEtiqueta('');
      onActualizada({ ...tarea, links: proximos, comentarios });
    } catch (e) {
      setFlash({ tone: 'bad', text: `No se pudo agregar el enlace: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function borrarLink(id: number): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFlash(null);
    try {
      await api(`/api/tareas/links?id=${id}`, { method: 'DELETE' });
      const proximos = links.filter((l) => l.id !== id);
      setLinks(proximos);
      onActualizada({ ...tarea, links: proximos, comentarios });
    } catch (e) {
      setFlash({ tone: 'bad', text: `No se pudo borrar el enlace: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function comentar(): Promise<void> {
    if (busy || nuevoComentario.trim() === '') return;
    setBusy(true);
    setFlash(null);
    try {
      const { comentario } = await api<{ comentario: Tarea['comentarios'][number] }>(
        '/api/tareas/comentarios',
        {
          method: 'POST',
          body: JSON.stringify({ tareaId: tarea.id, cuerpo: nuevoComentario.trim() }),
        },
      );
      const proximos = [...comentarios, comentario];
      setComentarios(proximos);
      setNuevoComentario('');
      onActualizada({ ...tarea, comentarios: proximos, links });
    } catch (e) {
      setFlash({ tone: 'bad', text: `No se pudo comentar: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function borrarTarea(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFlash(null);
    try {
      const data = await api<RespuestaBorrado>(`/api/tareas?id=${tarea.id}`, { method: 'DELETE' });
      // El número que mostró la confirmación (`comentarios.length`, estado
      // local) y el que el server realmente borró (`comentariosBorrados`)
      // deberían coincidir siempre: el modal mantiene `comentarios` sincronizado
      // con cada alta en tiempo real. Si divergen —otra persona comentó esta
      // misma tarjeta mientras el modal estaba abierto— avisamos con el número
      // real en vez de quedarnos callados, porque ya no hay vuelta atrás.
      if (
        typeof data.comentariosBorrados === 'number' &&
        data.comentariosBorrados !== comentarios.length
      ) {
        // eslint-disable-next-line no-console -- visibilidad de una divergencia real, no un error de la app
        console.warn(
          `Tarea ${tarea.id}: se esperaban ${comentarios.length} comentarios borrados y el server borró ${data.comentariosBorrados}.`,
        );
      }
      onBorrada(tarea.id);
      onCerrar();
    } catch (e) {
      setFlash({ tone: 'bad', text: `No se pudo borrar: ${(e as Error).message}` });
      setBusy(false);
    }
  }

  return (
    <Modal titulo="Detalle de la tarea" onCerrar={onCerrar} ancho="lg">
      {flash && (
        <div className="mb-3">
          <Banner tone={flash.tone}>{flash.text}</Banner>
        </div>
      )}

      {!editable && (
        <div className="mb-3">
          {/* Deshabilitados y VISIBLES, no escondidos: escondidos parece que la
              tarjeta está rota. Comentar sí se puede (queda habilitado). */}
          <Banner tone="neutral">
            Esta tarea está asignada a {nombreDueno}. No la podés editar, pero sí comentar.
          </Banner>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <label className={`${labelCls} md:col-span-2`}>
          Título
          <input
            className={inputCls}
            value={titulo}
            disabled={!editable}
            onChange={(e) => setTitulo(e.target.value)}
          />
        </label>

        <label className={`${labelCls} md:col-span-2`}>
          Notas
          <textarea
            className={`${inputCls} min-h-[5rem] resize-y`}
            value={notas}
            disabled={!editable}
            onChange={(e) => setNotas(e.target.value)}
          />
        </label>

        <label className={labelCls}>
          Asignada a
          <select
            className={inputCls}
            value={asignadoA}
            disabled={!editable}
            onChange={(e) => setAsignadoA(Number(e.target.value))}
          >
            {usuarios.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nombre}
              </option>
            ))}
          </select>
        </label>

        <label className={labelCls}>
          Prioridad
          <select
            className={inputCls}
            value={prioridad}
            disabled={!editable}
            onChange={(e) => setPrioridad(e.target.value as Prioridad)}
          >
            {PRIORIDADES.map((p) => (
              <option key={p} value={p}>
                {etiquetaDePrioridad(p)}
              </option>
            ))}
          </select>
        </label>

        <label className={labelCls}>
          Columna
          <select
            className={inputCls}
            value={columna}
            disabled={!editable}
            onChange={(e) => setColumna(e.target.value as Columna)}
          >
            {ORDEN_COLUMNAS.map((c) => (
              <option key={c} value={c}>
                {ETIQUETA_COLUMNA[c]}
              </option>
            ))}
          </select>
        </label>

        <label className={labelCls}>
          Vence el
          <input
            type="date"
            className={inputCls}
            value={venceEl}
            disabled={!editable}
            onChange={(e) => setVenceEl(e.target.value)}
          />
        </label>
      </div>

      {editable && (
        <div className="mt-4 flex justify-end">
          <button type="button" className={btnPrimary} disabled={busy} onClick={guardar}>
            {busy ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      )}

      {/* ── Enlaces ─────────────────────────────────────────────────────── */}
      <section className="mt-6 border-t border-border-subtle pt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Enlaces
        </h3>
        {links.length === 0 && <p className="text-xs text-neutral-600">Sin enlaces.</p>}
        <ul className="flex flex-col gap-1">
          {links.map((l) => (
            <li key={l.id} className="flex items-center gap-2 text-sm">
              <a
                href={l.url}
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 flex-1 truncate text-info-300 hover:underline"
              >
                {l.etiqueta || l.url}
              </a>
              {editable && (
                <button
                  type="button"
                  onClick={() => borrarLink(l.id)}
                  disabled={busy}
                  aria-label={`Borrar el enlace ${l.etiqueta || l.url}`}
                  className="shrink-0 rounded p-1 text-neutral-500 hover:text-bad-400"
                >
                  <X size={14} weight="bold" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {editable && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className={`${labelCls} flex-1`}>
              URL
              <input
                className={inputCls}
                placeholder="https://…"
                value={nuevaUrl}
                onChange={(e) => setNuevaUrl(e.target.value)}
              />
            </label>
            <label className={labelCls}>
              Etiqueta (opcional)
              <input
                className={inputCls}
                value={nuevaEtiqueta}
                onChange={(e) => setNuevaEtiqueta(e.target.value)}
              />
            </label>
            <button
              type="button"
              className={btnGhost}
              disabled={busy || nuevaUrl.trim() === ''}
              onClick={agregarLink}
            >
              <Plus size={14} weight="bold" className="mr-1 inline" />
              Agregar
            </button>
          </div>
        )}
      </section>

      {/* ── Comentarios ─────────────────────────────────────────────────── */}
      <section className="mt-6 border-t border-border-subtle pt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Comentarios
        </h3>
        {comentarios.length === 0 && <p className="text-xs text-neutral-600">Sin comentarios.</p>}
        <ul className="flex flex-col gap-3">
          {comentarios.map((c) => (
            <li key={c.id} className="rounded-lg bg-overlay/4 p-2">
              <div className="mb-0.5 flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-neutral-200">{c.usuarioNombre}</span>
                <span className="text-[11px] text-neutral-500">
                  {new Date(c.createdAt).toLocaleString('es-AR', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-neutral-200">{c.cuerpo}</p>
            </li>
          ))}
        </ul>
        {/* El campo de comentario queda habilitado SIEMPRE, incluso sin permiso
            de edición: comentar puede cualquiera (T05 §4). */}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className={`${labelCls} flex-1`}>
            Nuevo comentario
            <textarea
              className={`${inputCls} min-h-[3rem] resize-y`}
              value={nuevoComentario}
              onChange={(e) => setNuevoComentario(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={btnGhost}
            disabled={busy || nuevoComentario.trim() === ''}
            onClick={comentar}
          >
            Comentar
          </button>
        </div>
      </section>

      {/* ── Borrar ──────────────────────────────────────────────────────── */}
      {editable && (
        <section className="mt-6 border-t border-border-subtle pt-4">
          {!confirmandoBorrado ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs font-medium text-bad-400 hover:text-bad-300"
              onClick={() => setConfirmandoBorrado(true)}
            >
              <Trash size={14} weight="bold" />
              Borrar esta tarea
            </button>
          ) : (
            <div className="rounded-lg border border-bad-500/22 bg-bad-500/[0.09] p-3">
              <p className="mb-2 text-sm text-bad-200">
                Se borra la tarjeta
                {comentarios.length > 0
                  ? ` y sus ${comentarios.length} ${
                      comentarios.length === 1 ? 'comentario' : 'comentarios'
                    }`
                  : ''}
                . No se puede deshacer.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="press rounded-lg bg-bad-500 px-3 py-1.5 text-xs font-semibold text-canvas hover:bg-bad-400 disabled:opacity-40"
                  disabled={busy}
                  onClick={borrarTarea}
                >
                  {busy ? 'Borrando…' : 'Sí, borrar'}
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={busy}
                  onClick={() => setConfirmandoBorrado(false)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </Modal>
  );
}
