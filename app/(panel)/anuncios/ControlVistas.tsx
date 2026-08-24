'use client';

/**
 * ControlVistas (task 20.2): crear, renombrar, sobrescribir, borrar (previa
 * confirmación explícita) y marcar la Vista_Por_Defecto (R3 c6), más la marca
 * visible de cambios sin guardar (R3 c13) y el aviso de que las Vistas son
 * globales del panel (R3 c11).
 *
 * El control es tonto: recibe el repo y emite el repo nuevo por
 * `onCambiarRepo` — el Gestor es quien persiste contra el Endpoint_Vistas y
 * aplica los errores. La marca de cambios sin guardar sale de `hayCambios` y
 * por eso se quita sola (≤1 s) cuando la configuración en pantalla vuelve a
 * coincidir con la Vista aplicada (R3 c13).
 */

import { useMemo, useState } from 'react';
import { Check, FloppyDisk, PencilSimple, Plus, Star, Trash, X } from '@phosphor-icons/react';
import { hayCambios, type Orden, type RepoVistas, type Vista } from '@/lib/ads/vistas';
import { MAX_VISTAS } from '@/lib/ads/vistas';
import type { ColumnaVisible } from '@/lib/ads/catalogo';
import { ConfiguradorColumnas } from './ConfiguradorColumnas';

export function ControlVistas({
  repo,
  vistaAplicada,
  columnas,
  orden,
  ignoradas,
  errorRepo,
  onCambiarRepo,
  onAplicarVista,
  onColumnas,
  onNotificar,
}: {
  repo: RepoVistas | null;
  vistaAplicada: Vista | null;
  columnas: ColumnaVisible[];
  orden: Orden;
  /** Columnas que la Vista aplicada nombró y el catálogo ya no declara (R3 c10). */
  ignoradas: string[];
  errorRepo: string | null;
  onCambiarRepo: (repo: RepoVistas) => void;
  onAplicarVista: (vista: Vista) => void;
  /** Cambia las columnas en pantalla. El configurador vive dentro de este panel. */
  onColumnas: (columnas: ColumnaVisible[]) => void;
  onNotificar: (msg: string) => void;
}): JSX.Element {
  const [abierto, setAbierto] = useState(false);
  const [nombreNuevo, setNombreNuevo] = useState('');
  const [renombrando, setRenombrando] = useState<string | null>(null);
  const [nombreRenombre, setNombreRenombre] = useState('');
  const [borrando, setBorrando] = useState<string | null>(null);

  const sucio = useMemo(
    () => hayCambios(columnas, orden, vistaAplicada),
    [columnas, orden, vistaAplicada],
  );

  if (!abierto) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAbierto(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-overlay/6 focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60"
        >
          <Star size={13} weight={vistaAplicada ? 'fill' : 'regular'} />
          Vistas y columnas {vistaAplicada ? `· ${vistaAplicada.nombre}` : ''}
          {sucio && <span className="h-2 w-2 rounded-full bg-warn-400" title="Cambios sin guardar" />}
        </button>
        {ignoradas.length > 0 && (
          <span className="text-xs text-warn-300" title={`Se ignoraron ${ignoradas.length} columnas que el catálogo ya no declara (${ignoradas.join(', ')})`}>
            Vista con {ignoradas.length} columna(s) ignorada(s)
          </span>
        )}
      </div>
    );
  }

  const vistas = repo?.vistas ?? [];

  const crear = (): void => {
    const nombre = nombreNuevo.trim();
    if (!nombre || nombre.length > 60) {
      onNotificar('El nombre de la Vista tiene que tener entre 1 y 60 caracteres');
      return;
    }
    if (vistas.some((v) => v.nombre.trim().toLowerCase() === nombre.toLowerCase())) {
      onNotificar('Ya existe una Vista con ese nombre');
      return;
    }
    if (vistas.length >= MAX_VISTAS) {
      onNotificar(`No se pueden guardar más de ${MAX_VISTAS} Vistas`);
      return;
    }
    const nueva: Vista = {
      id: crypto.randomUUID(),
      nombre,
      columnas: columnas.map((c) => ({ ...c })),
      orden: { ...orden },
    };
    onCambiarRepo({ v: 1, vistas: [...vistas, nueva], porDefecto: repo?.porDefecto ?? null });
    setNombreNuevo('');
    onNotificar(`Vista «${nombre}» creada`);
  };

  const sobrescribir = (vista: Vista): void => {
    onCambiarRepo({
      v: 1,
      vistas: vistas.map((v) =>
        v.id === vista.id ? { ...v, columnas: columnas.map((c) => ({ ...c })), orden: { ...orden } } : v,
      ),
      porDefecto: repo?.porDefecto ?? null,
    });
    onNotificar(`Vista «${vista.nombre}» sobrescrita con la configuración en pantalla`);
  };

  const confirmarRenombre = (vista: Vista): void => {
    const nombre = nombreRenombre.trim();
    if (!nombre || nombre.length > 60) {
      onNotificar('El nombre tiene que tener entre 1 y 60 caracteres');
      return;
    }
    if (
      vistas.some(
        (v) => v.id !== vista.id && v.nombre.trim().toLowerCase() === nombre.toLowerCase(),
      )
    ) {
      onNotificar('Ya existe una Vista con ese nombre');
      return;
    }
    onCambiarRepo({
      v: 1,
      vistas: vistas.map((v) => (v.id === vista.id ? { ...v, nombre } : v)),
      porDefecto: repo?.porDefecto ?? null,
    });
    setRenombrando(null);
  };

  const borrar = (vista: Vista): void => {
    if (borrando !== vista.id) {
      setBorrando(vista.id);
      return;
    }
    onCambiarRepo({
      v: 1,
      vistas: vistas.filter((v) => v.id !== vista.id),
      porDefecto: repo?.porDefecto === vista.id ? null : repo?.porDefecto ?? null,
    });
    setBorrando(null);
    onNotificar(`Vista «${vista.nombre}» borrada`);
  };

  return (
    <div className="rounded-xl border border-border-strong bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-200">Vistas guardadas</span>
        <button
          type="button"
          onClick={() => setAbierto(false)}
          aria-label="Cerrar el control de Vistas"
          className="rounded p-1 text-neutral-500 hover:bg-overlay/6 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60"
        >
          <X size={14} weight="bold" />
        </button>
      </div>

      <p className="mb-2 text-xs text-neutral-500">
        Las Vistas son globales del panel: cualquiera que entre con la contraseña compartida ve y
        modifica las mismas Vistas, porque el panel se autentica sin usuarios.
      </p>

      {errorRepo && (
        <p className="mb-2 text-xs text-warn-400">No se pudieron cargar las Vistas: {errorRepo}</p>
      )}

      <ul className="space-y-1">
        {vistas.map((v) => {
          const esDefault = repo?.porDefecto === v.id;
          const aplicada = vistaAplicada?.id === v.id;
          return (
            <li key={v.id} className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-overlay/4">
              <button
                type="button"
                onClick={() => onAplicarVista(v)}
                className={`flex-1 truncate text-left text-xs ${aplicada ? 'font-semibold text-good-300' : 'text-neutral-300 hover:text-neutral-100'}`}
                title={aplicada ? 'Vista aplicada' : 'Aplicar esta Vista'}
              >
                {v.nombre}
              </button>
              {esDefault && (
                <span className="text-xs text-neutral-500" title="Vista por defecto">
                  <Star size={12} weight="fill" />
                </span>
              )}
              {aplicada && sucio && (
                <button
                  type="button"
                  onClick={() => sobrescribir(v)}
                  className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-neutral-300 hover:bg-overlay/6"
                  title="Sobrescribir esta Vista con la configuración en pantalla"
                >
                  <FloppyDisk size={12} />
                </button>
              )}
              {!esDefault && (
                <button
                  type="button"
                  onClick={() => onCambiarRepo({ v: 1, vistas, porDefecto: v.id })}
                  className="rounded px-1 py-0.5 text-neutral-500 hover:text-good-300"
                  aria-label={`Marcar «${v.nombre}» como Vista por defecto`}
                  title="Marcar como Vista por defecto"
                >
                  <Star size={12} />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setRenombrando(v.id);
                  setNombreRenombre(v.nombre);
                }}
                className="rounded px-1 py-0.5 text-neutral-500 hover:text-neutral-200"
                aria-label={`Renombrar «${v.nombre}»`}
                title="Renombrar"
              >
                <PencilSimple size={12} />
              </button>
              <button
                type="button"
                onClick={() => borrar(v)}
                className={`rounded px-1 py-0.5 ${borrando === v.id ? 'text-bad-300' : 'text-neutral-500 hover:text-bad-300'}`}
                aria-label={borrando === v.id ? `Confirmar el borrado de «${v.nombre}»` : `Borrar «${v.nombre}»`}
                title={borrando === v.id ? '¿Borrar definitivamente? (click de nuevo)' : 'Borrar'}
              >
                {borrando === v.id ? <Check size={12} weight="bold" /> : <Trash size={12} />}
              </button>
            </li>
          );
        })}
        {vistas.length === 0 && <li className="px-2 py-1 text-xs text-neutral-500">No hay Vistas guardadas.</li>}
      </ul>

      {renombrando && (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            type="text"
            value={nombreRenombre}
            maxLength={60}
            onChange={(e) => setNombreRenombre(e.target.value)}
            className="flex-1 rounded border border-border-strong bg-overlay/4 px-2 py-1 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-good-500/50"
            aria-label="Nuevo nombre de la Vista"
          />
          <button
            type="button"
            onClick={() => confirmarRenombre(vistas.find((v) => v.id === renombrando)!)}
            className="rounded border border-border-strong px-2 py-1 text-xs font-semibold text-neutral-200 hover:bg-overlay/6"
          >
            Guardar
          </button>
        </div>
      )}

      {/* El configurador de columnas vive ACÁ dentro, no suelto en la pantalla.
          Cambiar columnas marca la Vista como modificada vía `hayCambios`, así
          que el botón de sobrescribir aparece solo. */}
      <div className="mt-3 border-t border-border-subtle pt-3">
        <p className="mb-2 text-xs font-semibold text-neutral-200">Columnas de esta vista</p>
        <ConfiguradorColumnas columnas={columnas} onColumnas={onColumnas} />
      </div>

      <div className="mt-3 flex items-center gap-1.5 border-t border-border-subtle pt-3">
        <input
          type="text"
          value={nombreNuevo}
          maxLength={60}
          placeholder="Nombre de la Vista nueva"
          onChange={(e) => setNombreNuevo(e.target.value)}
          className="flex-1 rounded border border-border-strong bg-overlay/4 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-good-500/50"
          aria-label="Nombre de la Vista nueva"
        />
        <button
          type="button"
          onClick={crear}
          className="inline-flex items-center gap-1 rounded border border-border-strong px-2 py-1 text-xs font-semibold text-neutral-200 hover:bg-overlay/6"
        >
          <Plus size={12} weight="bold" /> Crear con lo de pantalla
        </button>
      </div>
    </div>
  );
}
