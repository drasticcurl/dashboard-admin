'use client';

/**
 * CreativosView — la pantalla de /creativos.
 *
 * Molde: `app/(panel)/config/sections/ComisionesSection.tsx` (tabla + un
 * formulario de alta/edición debajo, sin modal, `confirm()` para borrar). No se
 * usó el `Modal` de finanzas porque acá no hace falta: es un solo formulario
 * corto (tres campos) y no una sección que se abre y cierra sobre una pantalla
 * más grande.
 *
 * Sin dueño por fila (a propósito, ver el docblock de la migración 034):
 * cualquiera con la sección puede editar o borrar cualquier creativo, así que
 * no hay lógica de "es mío vs es de otro" acá — a diferencia de TableroView.
 */

import { useState } from 'react';
import { Badge, Banner, Card, Table, fmtDateTime } from '@/components/ui';
import { btnGhost, btnPrimary, inputCls } from '@/app/(panel)/config/kit';
// SÓLO tipos de la capa de datos: `lib/queries/creativos.ts` importa `lib/db.ts`
// (pg, server-only). `RENDIMIENTOS` como valor y las funciones de color/etiqueta
// viven en `./rendimiento.ts`, un módulo puro (ver su docblock).
import type { Creativo, Rendimiento } from '@/lib/queries/creativos';
import { RENDIMIENTOS, tonoDeRendimiento, etiquetaDeRendimiento } from './rendimiento';

type Respuesta<K extends string, V> = { ok: boolean; error?: string; detail?: string } & {
  [key in K]?: V;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

const FORM_VACIO = { nombre: '', link: '', rendimiento: 'medio' as Rendimiento };

export function CreativosView({ initial }: { initial: Creativo[] }): JSX.Element {
  const [creativos, setCreativos] = useState<Creativo[]>(initial);
  const [form, setForm] = useState(FORM_VACIO);
  const [editId, setEditId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  function show(tone: 'good' | 'bad', text: string): void {
    setFlash({ tone, text });
  }

  function cancelarEdicion(): void {
    setEditId(null);
    setForm(FORM_VACIO);
  }

  async function guardar(): Promise<void> {
    if (busy) return;
    const nombre = form.nombre.trim();
    const link = form.link.trim();
    if (nombre === '' || link === '') return;

    setBusy(true);
    setFlash(null);
    try {
      if (editId === null) {
        const data = await api<Respuesta<'creativo', Creativo>>('/api/creativos', {
          method: 'POST',
          body: JSON.stringify({ nombre, link, rendimiento: form.rendimiento }),
        });
        setCreativos((prev) => [data.creativo!, ...prev]);
        show('good', 'Creativo agregado');
      } else {
        const data = await api<Respuesta<'creativo', Creativo>>('/api/creativos', {
          method: 'PATCH',
          body: JSON.stringify({ id: editId, nombre, link, rendimiento: form.rendimiento }),
        });
        setCreativos((prev) => prev.map((c) => (c.id === editId ? data.creativo! : c)));
        show('good', 'Cambios guardados');
      }
      cancelarEdicion();
    } catch (e) {
      show('bad', `No se pudo guardar: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function editar(c: Creativo): void {
    setEditId(c.id);
    setForm({ nombre: c.nombre, link: c.link, rendimiento: c.rendimiento });
  }

  async function borrar(c: Creativo): Promise<void> {
    if (busy) return;
    if (!confirm(`¿Borrar "${c.nombre}"?`)) return;

    setBusy(true);
    setFlash(null);
    try {
      await api(`/api/creativos?id=${c.id}`, { method: 'DELETE' });
      setCreativos((prev) => prev.filter((x) => x.id !== c.id));
      if (editId === c.id) cancelarEdicion();
      show('good', 'Creativo borrado');
    } catch (e) {
      show('bad', `No se pudo borrar: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Creativos"
      hint="Registrá cómo le fue a cada video: un nombre o nota corta, el link y el rendimiento (alto, medio o bajo)."
    >
      {flash && (
        <div className="mb-4">
          <Banner tone={flash.tone}>{flash.text}</Banner>
        </div>
      )}

      <Table
        rows={creativos}
        empty="Todavía no hay creativos cargados."
        columns={[
          {
            key: 'nombre',
            header: 'Nombre / nota',
            render: (c) => <span className="text-neutral-200">{c.nombre}</span>,
          },
          {
            key: 'link',
            header: 'Link',
            render: (c) => (
              <a
                href={c.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-info-400 underline-offset-2 hover:underline"
              >
                Ver video
              </a>
            ),
          },
          {
            key: 'rendimiento',
            header: 'Rendimiento',
            render: (c) => (
              <Badge tone={tonoDeRendimiento(c.rendimiento)}>{etiquetaDeRendimiento(c.rendimiento)}</Badge>
            ),
          },
          {
            key: 'creado_por',
            header: 'Cargado por',
            render: (c) => <span className="text-neutral-500">{c.creadoPorNombre ?? '—'}</span>,
          },
          {
            key: 'created_at',
            header: 'Fecha',
            render: (c) => <span className="text-neutral-500">{fmtDateTime(c.createdAt)}</span>,
          },
          {
            key: 'acciones',
            header: '',
            align: 'right',
            render: (c) => (
              <span className="flex justify-end gap-2">
                <button type="button" className={btnGhost} disabled={busy} onClick={() => editar(c)}>
                  Editar
                </button>
                <button type="button" className={btnGhost} disabled={busy} onClick={() => borrar(c)}>
                  Borrar
                </button>
              </span>
            ),
          },
        ]}
      />

      <div className="mt-4 rounded-xl border border-border-subtle bg-overlay/2 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {editId === null ? 'Agregar creativo' : 'Editar creativo'}
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-neutral-500 lg:col-span-2">
            Nombre o nota
            <input
              className={inputCls}
              placeholder="Testimonio Marta v2"
              value={form.nombre}
              onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 lg:col-span-2">
            Link del video
            <input
              className={inputCls}
              placeholder="https://…"
              value={form.link}
              onChange={(e) => setForm({ ...form, link: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Rendimiento
            <select
              className={inputCls}
              value={form.rendimiento}
              onChange={(e) => setForm({ ...form, rendimiento: e.target.value as Rendimiento })}
            >
              {RENDIMIENTOS.map((r) => (
                <option key={r} value={r}>
                  {etiquetaDeRendimiento(r)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className={btnPrimary}
            disabled={busy || form.nombre.trim() === '' || form.link.trim() === ''}
            onClick={guardar}
          >
            {busy ? 'Guardando…' : editId === null ? 'Agregar' : 'Guardar cambios'}
          </button>
          {editId !== null && (
            <button type="button" className={btnGhost} disabled={busy} onClick={cancelarEdicion}>
              Cancelar
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
