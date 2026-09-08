'use client';

/**
 * UsuariosSection — Config → Sistema → Usuarios (T04 §6).
 *
 * Crear usuarios, activarlos/desactivarlos, resetear su clave y prender/apagar
 * sus 8 pestañas con switches. El admin ve todo y no se puede tocar (D11).
 *
 * Los datos se leen client-side (`GET /api/usuarios`) al montar: esta sección no
 * puede alimentar `initial` desde el server component de Config (page.tsx no es
 * de esta task). El molde de estado/flash/busy es el de las otras secciones
 * (ProductosSection), con el `shell` del ConfigView.
 *
 * Los switches son `<input type="checkbox">` reales (no divs con onClick): un
 * switch que no es un checkbox no lo lee un lector de pantalla ni lo alcanza el
 * Tab. Guardar es EXPLÍCITO (botón), no auto-guarda al togglear.
 */

import { useEffect, useState } from 'react';
import { Badge, Banner, Card, Table, fmtDateTime } from '@/components/ui';
import type { Usuario } from '@/lib/queries/usuarios';
import { btnGhost, btnPrimary, inputCls, type ConfigShell } from '../kit';

/**
 * El vocabulario de las 8 pestañas, EN ORDEN. Se define acá y no se importa
 * `SECCIONES` de `@/lib/permisos` a propósito: ese módulo importa `next/headers`
 * (es server-only) y arrastrarlo a un componente `'use client'` rompe el build.
 * La validación de verdad —que estas 8 son EXACTAMENTE las de `SECCIONES`— vive
 * en el SERVER: el route valida `secciones` con `z.enum(SECCIONES)` (§5.6). Acá
 * es sólo la lista para pintar los checkboxes; si divergiera, el server rechaza.
 */
const LABEL_SECCION = {
  resumen: 'Resumen',
  embudo: 'Embudo',
  ventas: 'Ventas',
  anuncios: 'Anuncios',
  finanzas: 'Finanzas',
  leads: 'Leads',
  config: 'Config',
  tareas: 'Tareas',
} as const;

type Seccion = keyof typeof LABEL_SECCION;
const SECCIONES = Object.keys(LABEL_SECCION) as Seccion[];

export function UsuariosSection({ shell }: { shell: ConfigShell }): JSX.Element {
  const { api, show, busy, setBusy } = shell;

  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [cargando, setCargando] = useState(true);
  // El estado editable de los switches, por usuario. Se inicializa desde lo que
  // viene de la base y sólo se persiste al apretar Guardar (no auto-guarda).
  const [borrador, setBorrador] = useState<Record<number, Set<Seccion>>>({});
  const [alta, setAlta] = useState({ usuario: '', nombre: '' });

  async function refetch() {
    const res = await api<{ usuarios: Usuario[] }>('/api/usuarios');
    setUsuarios(res.usuarios);
    // El borrador arranca del estado real de cada usuario.
    const b: Record<number, Set<Seccion>> = {};
    for (const u of res.usuarios) b[u.id] = new Set(u.secciones);
    setBorrador(b);
  }

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const res = await api<{ usuarios: Usuario[] }>('/api/usuarios');
        if (!vivo) return;
        setUsuarios(res.usuarios);
        const b: Record<number, Set<Seccion>> = {};
        for (const u of res.usuarios) b[u.id] = new Set(u.secciones);
        setBorrador(b);
      } catch (err) {
        if (vivo) show('bad', err instanceof Error ? err.message : 'No se pudieron cargar los usuarios');
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => {
      vivo = false;
    };
    // Sólo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(userId: number, seccion: Seccion) {
    setBorrador((prev) => {
      const set = new Set(prev[userId] ?? []);
      if (set.has(seccion)) set.delete(seccion);
      else set.add(seccion);
      return { ...prev, [userId]: set };
    });
  }

  async function crear() {
    setBusy(true);
    try {
      await api('/api/usuarios', {
        method: 'POST',
        body: JSON.stringify({ usuario: alta.usuario.trim().toLowerCase(), nombre: alta.nombre.trim() }),
      });
      setAlta({ usuario: '', nombre: '' });
      await refetch();
      // La clave inicial es 123456 (D8): se dice para que el admin la pase.
      show('good', 'Usuario creado con la clave inicial 123456. Al entrar va a tener que cambiarla.');
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error al crear');
    } finally {
      setBusy(false);
    }
  }

  async function guardarSecciones(u: Usuario) {
    setBusy(true);
    try {
      // El PATCH manda el ESTADO FINAL de los 8 switches (no un diff): el orden
      // no importa, la capa reemplaza el conjunto entero.
      const secciones = SECCIONES.filter((s) => borrador[u.id]?.has(s));
      await api('/api/usuarios', {
        method: 'PATCH',
        body: JSON.stringify({ id: u.id, secciones }),
      });
      await refetch();
      show('good', `Secciones de ${u.usuario} guardadas`);
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActivo(u: Usuario) {
    setBusy(true);
    try {
      await api('/api/usuarios', {
        method: 'PATCH',
        body: JSON.stringify({ id: u.id, activo: !u.activo }),
      });
      await refetch();
      show('good', u.activo ? `${u.usuario} desactivado` : `${u.usuario} reactivado`);
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'No se pudo cambiar el estado');
    } finally {
      setBusy(false);
    }
  }

  async function resetear(u: Usuario) {
    if (!window.confirm(`¿Resetear la contraseña de "${u.usuario}" a 123456? Va a tener que cambiarla al entrar.`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ claveNueva: string }>('/api/usuarios/clave', {
        method: 'POST',
        body: JSON.stringify({ id: u.id, resetear: true }),
      });
      await refetch();
      show('good', `Contraseña de ${u.usuario} reseteada a: ${res.claveNueva}`);
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'No se pudo resetear');
    } finally {
      setBusy(false);
    }
  }

  const hayPendientes = usuarios.some((u) => u.debeCambiarClave);

  return (
    <Card
      title="Usuarios y permisos"
      hint="Quién entra al panel y qué pestañas ve cada uno. Los permisos se leen de la base en cada request, así que prender o apagar una sección es instantáneo. No se borran usuarios: se desactivan."
    >
      {/* Banner info sobre P-01: el layout de widgets es compartido. */}
      <Banner tone="info" title="El layout de widgets es compartido">
        Resumen y Ventas guardan la disposición de sus widgets para TODO el panel,
        no por usuario. Si dos personas mueven un widget, gana el último que
        guarda y el otro va a ver cambiar su pantalla sin haberla tocado.
      </Banner>

      {/* Banner warn si alguien todavía tiene la clave por defecto (D8 visible). */}
      {hayPendientes && (
        <div className="mt-3">
          <Banner tone="warn" title="Hay contraseñas sin cambiar">
            Uno o más usuarios todavía tienen que cambiar su contraseña (siguen con
            la inicial 123456). Mientras no la cambien, cualquiera que sepa el
            usuario puede entrar. Pediles que entren y la cambien.
          </Banner>
        </div>
      )}

      <div className="mt-4">
        <Table
          rows={usuarios}
          empty={cargando ? 'Cargando…' : 'No hay usuarios'}
          columns={[
            {
              key: 'usuario',
              header: 'Usuario',
              render: (u) => <code className="rounded bg-overlay/10 px-1 text-neutral-300">{u.usuario}</code>,
            },
            { key: 'nombre', header: 'Nombre', render: (u) => <span className="text-neutral-300">{u.nombre}</span> },
            {
              key: 'rol',
              header: 'Rol',
              render: (u) => (u.esAdmin ? <Badge tone="good">admin</Badge> : <Badge tone="neutral">usuario</Badge>),
            },
            {
              key: 'estado',
              header: 'Estado',
              render: (u) =>
                u.activo ? <Badge tone="info">activo</Badge> : <Badge tone="bad">desactivado</Badge>,
            },
            {
              key: 'ultimo',
              header: 'Último ingreso',
              render: (u) => (
                <span className="text-neutral-400">{u.ultimoLoginAt ? fmtDateTime(u.ultimoLoginAt) : 'nunca'}</span>
              ),
            },
            {
              key: 'secciones',
              header: 'Secciones',
              render: (u) => {
                // La fila del admin: los 8 en ON y DESHABILITADOS, con title que
                // explica por qué (D11). Deshabilitados y no escondidos:
                // escondidos parecería un bug.
                const esAdmin = u.esAdmin;
                const tituloAdmin =
                  'El admin ve todo; si pudiera apagarse una sección se quedaría afuera de esta pantalla (D11).';
                return (
                  <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                    {SECCIONES.map((s) => {
                      const marcado = esAdmin ? true : borrador[u.id]?.has(s) ?? false;
                      return (
                        <label
                          key={s}
                          className={`flex items-center gap-1.5 text-xs ${esAdmin ? 'text-neutral-500' : 'text-neutral-300'}`}
                          title={esAdmin ? tituloAdmin : undefined}
                        >
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-border-strong bg-canvas/60 accent-good-500 disabled:opacity-60"
                            checked={marcado}
                            disabled={esAdmin || busy}
                            onChange={() => toggle(u.id, s)}
                            aria-label={`${LABEL_SECCION[s]} para ${u.usuario}`}
                          />
                          {LABEL_SECCION[s]}
                        </label>
                      );
                    })}
                  </div>
                );
              },
            },
            {
              key: 'acciones',
              header: '',
              render: (u) => (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {/* Guardar explícito, sólo para no-admin (el admin no tiene
                      secciones editables). */}
                  {!u.esAdmin && (
                    <button type="button" className={btnPrimary} onClick={() => guardarSecciones(u)} disabled={busy}>
                      Guardar
                    </button>
                  )}
                  <button type="button" className={btnGhost} onClick={() => resetear(u)} disabled={busy}>
                    Resetear clave
                  </button>
                  {/* No hay "Borrar": sólo "Desactivar"/"Reactivar" (D8). */}
                  <button type="button" className={btnGhost} onClick={() => toggleActivo(u)} disabled={busy}>
                    {u.activo ? 'Desactivar' : 'Reactivar'}
                  </button>
                </div>
              ),
            },
          ]}
        />
      </div>

      {/* Alta de un usuario nuevo. */}
      <div className="mt-4 border-t border-border-subtle pt-4">
        <p className="mb-3 text-sm font-semibold text-neutral-200">
          Crear usuario <span className="font-normal text-neutral-500">— nace con la clave 123456 y sin ninguna sección</span>
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Usuario
            <input
              className={inputCls}
              value={alta.usuario}
              onChange={(e) => setAlta({ ...alta, usuario: e.target.value })}
              placeholder="nahuel"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Nombre
            <input
              className={inputCls}
              value={alta.nombre}
              onChange={(e) => setAlta({ ...alta, nombre: e.target.value })}
              placeholder="Nahuel"
            />
          </label>
        </div>
        <button
          type="button"
          className={`${btnPrimary} mt-3`}
          onClick={crear}
          disabled={busy || alta.usuario.trim() === '' || alta.nombre.trim() === ''}
        >
          Crear usuario
        </button>
      </div>
    </Card>
  );
}
