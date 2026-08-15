'use client';

/**
 * GestorAnuncios (task 20.4): el ÚNICO componente con estado de la pantalla
 * /anuncios. Reemplaza a AnunciosView en un swap atómico (AnunciosView.tsx se
 * elimina en esta task). Todo lo demás recibe props y emite callbacks.
 *
 * El estado es: Nivel_Activo, Seleccion_Activa, Filtro_Cascada, columnas en
 * pantalla, Orden_Tabla y página. Las transiciones de nivel, filtro y cascada
 * se delegan a `lib/ads/seleccion.ts` (la misma máquina de estados que verifica
 * la Property 8). La URL refleja el Nivel_Activo y la lista completa de ids de
 * la cascada (R8 c7), y al cargar con esos parámetros la tabla abre ya filtrada
 * sin intervención del usuario (R8 c13).
 *
 * Después de una Accion_Lote se vuelven a pedir las filas y se dibuja SOLO lo
 * que devolvió ese pedido, descartando todo valor optimista (R16 c6); si ese
 * pedido falla o tarda más de 10 s, el detalle de resultados queda visible, se
 * avisa que la tabla puede no reflejar el servidor y se ofrece reintentar
 * (R16 c7). El toggle de una fila no confirmada queda en el valor del servidor
 * (R16 c10).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { FrescuraAds } from '@/lib/ads/live';
import type {
  AccionAds,
  ClaveOrden,
  MetricasObjeto,
  NivelAds,
  PeriodoAds,
  ResultadoMetricas,
} from '@/lib/ads/tipos';
import type { CuentaAds } from './page';
import { SubNav } from './SubNav';
import { TabsNivel } from './TabsNivel';
import { BarraFrescura } from './BarraFrescura';
import { BarraFiltros } from './BarraFiltros';
import { ChipCascada } from './ChipCascada';
import { ControlVistas } from './ControlVistas';
import { ConfiguradorColumnas } from './ConfiguradorColumnas';
import { TablaAds, type FilaEnProceso } from './TablaAds';
import { Paginacion } from './Paginacion';
import { BarraSeleccion } from './BarraSeleccion';
import { DialogoConfirmacion } from './DialogoConfirmacion';
import { FormularioPresupuesto } from './FormularioPresupuesto';
import { FormularioDuplicar } from './FormularioDuplicar';
import { FormularioRenombrar, modoDeFormulario, type ModoFormulario } from './FormularioRenombrar';
import { FormularioProgramar } from './FormularioProgramar';
import { isoConOffset, mananaMedianocheLocal } from './zonaHoraria';
import { ResultadosLote, type RespuestaLote } from './ResultadosLote';
import { Banner, Card, EmptyState, Skeleton, StatCard, fmtInt, fmtMoney } from '@/components/ui';
import {
  aplicarEvento,
  estadoInicial,
  type Cascada,
  type EstadoSeleccion,
  type EventoSeleccion,
  MAX_CASCADA,
  MAX_SELECCION,
} from '@/lib/ads/seleccion';
import {
  calcularPrevisualizacion,
  type ParametrosAccion,
  type Previsualizacion as Previa,
} from '@/lib/ads/previsualizacion';
import {
  columnasParaRender,
  CATALOGO_METRICAS,
  type ColumnaVisible,
} from '@/lib/ads/catalogo';
import {
  parseRepoVistas,
  resolverVista,
  type Orden,
  type RepoVistas,
  type Vista,
} from '@/lib/ads/vistas';
import { siguienteOrden, ORDEN_DEFAULT, type EstadoOrden } from '@/lib/ads/orden';

type Respuesta = ResultadoMetricas & {
  adsFreshness?: FrescuraAds;
  maxDailyBudgetEur?: number;
  maxDeltaPorTickEur?: number;
  alcanceError?: string | null;
  avisoCuenta?: string | null;
  sinCuentas?: boolean;
};

const NIVEL_LABEL: Record<NivelAds, string> = {
  campaign: 'Campañas',
  adset: 'Conjuntos',
  ad: 'Anuncios',
};

function money(n: number): string {
  return fmtMoney(n, 'EUR');
}

const TOPES_ABORTO = 10_000; // R16 c7: 10 s para el refetch posterior a un lote

export function GestorAnuncios({
  cuentas,
  initialData,
  adsFreshness,
  nivelInicial,
  filtrosIniciales,
  vistaPorDefecto,
  desalineada,
  nombresCascada,
  avisoCuentaInicial,
}: {
  cuentas: CuentaAds[];
  initialData: ResultadoMetricas;
  adsFreshness: FrescuraAds;
  nivelInicial: NivelAds;
  filtrosIniciales: {
    period: PeriodoAds;
    status: 'active' | 'paused' | 'any';
    account: string;
    nombre?: string;
    campaignIds?: string[];
    adsetIds?: string[];
  };
  vistaPorDefecto: Vista | null;
  desalineada: { funnelSlug: string; cuentaFunnel: string | null } | null;
  /** id → nombre de los ids de la cascada de la URL, para el ChipCascada (R8 c4). */
  nombresCascada: Record<string, string>;
  avisoCuentaInicial: string | null;
}): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [nivel, setNivel] = useState<NivelAds>(nivelInicial);
  const [period, setPeriod] = useState<PeriodoAds>(filtrosIniciales.period);
  const [status, setStatus] = useState<'active' | 'paused' | 'any'>(filtrosIniciales.status);
  const [account, setAccount] = useState(filtrosIniciales.account);
  const [nombre, setNombre] = useState(filtrosIniciales.nombre ?? '');

  const [estadoSel, setEstadoSel] = useState<EstadoSeleccion>(
    estadoInicial(nivelInicial),
  );
  const [cascada, setCascada] = useState<Cascada | null>(() => {
    const ids = nivelInicial === 'adset'
      ? filtrosIniciales.campaignIds
      : nivelInicial === 'ad'
        ? filtrosIniciales.adsetIds
        : undefined;
    return ids && ids.length > 0
      ? { nivel: nivelInicial === 'ad' ? 'adset' : 'campaign', ids: ids.slice(0, MAX_CASCADA), descartados: Math.max(0, ids.length - MAX_CASCADA), motivo: ids.length > MAX_CASCADA ? 'tope' : null }
      : null;
  });

  // Vista aplicada y columnas en pantalla (R3 c8: la Vista_Por_Defecto llega
  // del server component en el primer render, sin salto visual).
  const [repo, setRepo] = useState<RepoVistas | null>(null);
  const [errorRepo, setErrorRepo] = useState<string | null>(null);
  const [vistaAplicada, setVistaAplicada] = useState<Vista | null>(vistaPorDefecto);
  const [ignoradas, setIgnoradas] = useState<string[]>([]);

  const [columnas, setColumnas] = useState<ColumnaVisible[]>(() =>
    vistaPorDefecto
      ? resolverVista(vistaPorDefecto).columnas
      : columnasParaRender(
          CATALOGO_METRICAS.filter((e) => e.base).map((e) => ({
            clave: e.clave,
            ancho: e.clave === 'nombre' ? 0 : 100, // 0 = sin declarar → 25 % en TablaAds (R5 c8)
          })),
        ),
  );
  const [ordenEstado, setOrdenEstado] = useState<EstadoOrden>(
    vistaPorDefecto
      ? { ...resolverVista(vistaPorDefecto).orden, pagina: 1 }
      : { ...ORDEN_DEFAULT, pagina: 1 },
  );

  const [data, setData] = useState<Respuesta>(initialData);
  const [frescura, setFrescura] = useState<FrescuraAds>(adsFreshness);
  const [maxPresupuesto, setMaxPresupuesto] = useState(200);
  const [maxDelta, setMaxDelta] = useState(300);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const [refrescando, setRefrescando] = useState(false);
  const [frenoSegundos, setFrenoSegundos] = useState<number | null>(null);
  const ultimoRefresco = useRef<number>(0);

  const [confirmacion, setConfirmacion] = useState<{
    accion: AccionAds;
    previa: Previa;
    params: ParametrosAccion;
    ids: string[];
  } | null>(null);
  const [dialogoPresupuesto, setDialogoPresupuesto] = useState('');
  const [dialogoDuplicar, setDialogoDuplicar] = useState({
    copias: 1,
    presupuesto: '',
    fecha: '',
    hora: '00:00',
  });
  const [dialogoRenombrar, setDialogoRenombrar] = useState<{
    modo: ModoFormulario;
    prefijo: string;
    sufijo: string;
    buscar: string;
    poner: string;
    nombreExacto: string;
  }>({ modo: 'prefijo', prefijo: '', sufijo: '', buscar: '', poner: '', nombreExacto: '' });
  const [dialogoProgramar, setDialogoProgramar] = useState({ fecha: '', hora: '00:00' });
  const [desglose, setDesglose] = useState<Map<string, { conjuntos: number; anuncios: number }> | null>(null);
  const [ejecutando, setEjecutando] = useState(false);
  const [resultados, setResultados] = useState<RespuestaLote | null>(null);
  const [avisoTablaVieja, setAvisoTablaVieja] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // Filas fantasma de las copias en creación (R18 c4, c9): estado SEPARADO de
  // data.filas, se vacían completas cuando el Endpoint_Acciones responde.
  const [enProceso, setEnProceso] = useState<FilaEnProceso[]>([]);

  const firstRun = useRef(true);

  // ── La cuenta y el aviso de R1 c12 ──
  const [avisoCuenta, setAvisoCuenta] = useState<string | null>(avisoCuentaInicial);

  // ── Pedido de filas ──────────────────────────────────────────────────────
  const construirUrl = useCallback(
    (extra?: { forzar?: boolean }): string => {
      const params = new URLSearchParams();
      params.set('level', nivel);
      params.set('period', period);
      params.set('status', status);
      params.set('account', account);
      if (nombre) params.set('nombre', nombre);
      if (cascada && cascada.ids.length > 0) {
        for (const id of cascada.ids) params.append(cascada.nivel === 'campaign' ? 'campaignIds' : 'adsetIds', id);
      }
      params.set('orderBy', ordenEstado.clave);
      params.set('orderDir', ordenEstado.dir);
      params.set('page', String(ordenEstado.pagina));
      if (columnas.length > 0) params.set('columnas', columnas.map((c) => c.clave).join(','));
      if (extra?.forzar) params.set('forzar', '1');
      return `/api/data/ads?${params.toString()}`;
    },
    [nivel, period, status, account, nombre, cascada, ordenEstado, columnas],
  );

  const pedirFilas = useCallback(
    async (opts?: { forzar?: boolean; timeoutMs?: number }) => {
      const ctrl = new AbortController();
      const alarma = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 30_000);
      const res = await fetch(construirUrl({ forzar: opts?.forzar }), {
        signal: ctrl.signal,
        cache: 'no-store',
      });
      clearTimeout(alarma);
      const body = (await res.json()) as Respuesta & { ok: boolean; error?: string };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    },
    [construirUrl],
  );

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setLoading(true);
    setError(null);
    pedirFilas()
      .then((body) => {
        setData(body);
        if (body.adsFreshness) setFrescura(body.adsFreshness);
        if (typeof body.maxDailyBudgetEur === 'number') setMaxPresupuesto(body.maxDailyBudgetEur);
        if (typeof body.maxDeltaPorTickEur === 'number') setMaxDelta(body.maxDeltaPorTickEur);
        if (body.avisoCuenta !== undefined) setAvisoCuenta(body.avisoCuenta);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setError('el pedido de filas no respondió en 30 segundos');
        } else {
          setError(err instanceof Error ? err.message : 'Error de red');
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nivel, period, status, account, nombre, cascada, ordenEstado.clave, ordenEstado.dir, ordenEstado.pagina, retryTick]);

  // ── La URL refleja nivel y cascada (R8 c7) ──
  const escribirUrl = useCallback(
    (nuevoNivel: NivelAds, nuevaCascada: { nivel: 'campaign' | 'adset'; ids: readonly string[] } | null, extra?: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('level', nuevoNivel);
      params.delete('campaignIds');
      params.delete('adsetIds');
      if (nuevaCascada && nuevaCascada.ids.length > 0) {
        const clave = nuevaCascada.nivel === 'campaign' ? 'campaignIds' : 'adsetIds';
        for (const id of nuevaCascada.ids) params.append(clave, id);
      }
      for (const [k, v] of Object.entries(extra ?? {})) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      router.replace(`/anuncios?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // ── Transiciones de selección y cascada (la máquina de seleccion.ts) ─────
  const evento = useCallback(
    (ev: EventoSeleccion): EstadoSeleccion => {
      const siguiente = aplicarEvento(estadoSel, ev);
      setEstadoSel(siguiente);
      setCascada(siguiente.cascada && siguiente.cascada.ids.length > 0 ? siguiente.cascada : null);
      return siguiente;
    },
    [estadoSel],
  );

  const cambiarNivel = (nuevoNivel: NivelAds): void => {
    if (nuevoNivel === nivel) return; // R1 c15
    const siguiente = evento({
      tipo: 'cambiar_nivel',
      nivel: nuevoNivel,
      idsEnOrdenDeTabla: data.filas.map((f) => f.objectId),
      idsDeLaCuenta: new Set(estadoSel.cascada?.ids ?? []),
    });
    setNivel(nuevoNivel);
    escribirUrl(
      nuevoNivel,
      siguiente.cascada && siguiente.cascada.ids.length > 0 ? siguiente.cascada : null,
    );
  };

  const cambiarFiltro = (cambios: { period?: PeriodoAds; status?: 'active' | 'paused' | 'any'; account?: string; nombre?: string }): void => {
    // R9 c6: la selección se vacía, la cascada se conserva
    evento({ tipo: 'cambiar_filtro' });
    if (cambios.period !== undefined) setPeriod(cambios.period);
    if (cambios.status !== undefined) setStatus(cambios.status);
    if (cambios.account !== undefined) setAccount(cambios.account);
    if (cambios.nombre !== undefined) setNombre(cambios.nombre);
    const params = new URLSearchParams(searchParams.toString());
    if (cambios.period !== undefined) params.set('period', cambios.period);
    if (cambios.status !== undefined) params.set('status', cambios.status);
    if (cambios.account !== undefined) params.set('account', cambios.account);
    if (cambios.nombre !== undefined) {
      if (cambios.nombre) params.set('nombre', cambios.nombre);
      else params.delete('nombre');
    }
    router.replace(`/anuncios?${params.toString()}`, { scroll: false });
  };

  const limpiarCascada = (): void => {
    evento({ tipo: 'limpiar_cascada' });
    const params = new URLSearchParams(searchParams.toString());
    params.delete('campaignIds');
    params.delete('adsetIds');
    router.replace(`/anuncios?${params.toString()}`, { scroll: false });
  };

  const bajarNivel = (fila: MetricasObjeto): void => {
    if (fila.level === 'ad') return;
    // R8 c12: click en el nombre → nivel de abajo con ese id como ÚNICA cascada.
    const nivelAbajo: NivelAds = fila.level === 'campaign' ? 'adset' : 'ad';
    const nuevaCascada: Cascada = {
      nivel: fila.level,
      ids: [fila.objectId],
      descartados: 0,
      motivo: null,
    };
    setEstadoSel(estadoInicial(nivelAbajo));
    setCascada(nuevaCascada);
    setNivel(nivelAbajo);
    escribirUrl(nivelAbajo, nuevaCascada);
  };

  const tildar = (id: string): void => {
    if (estadoSel.seleccion.ids.includes(id)) evento({ tipo: 'destildar', id });
    else evento({ tipo: 'tildar', id });
  };

  // ── Vista por defecto y repo (R3 c8, c9) ──
  useEffect(() => {
    fetch('/api/config/vistas-ads', { cache: 'no-store' })
      .then(async (res) => {
        const body = (await res.json()) as { ok: boolean; repo: RepoVistas | null };
        if (!res.ok || body.ok === false) throw new Error('sin respuesta');
        return body.repo;
      })
      .then((leido) => {
        setRepo(leido);
        if (vistaAplicada === null) {
          if (leido?.porDefecto) {
            const porDefecto = leido.vistas.find((v) => v.id === leido.porDefecto) ?? null;
            if (porDefecto) aplicarVista(porDefecto);
          } else if (leido !== null && leido.vistas.length === 0) {
            // repo guardado sin Vistas: se respeta (R3 c9), no hay nada que aplicar
          } else {
            setErrorRepo('no hay Vista por defecto: se usa la configuración de las doce columnas');
          }
        }
      })
      .catch(() => setErrorRepo('no se pudieron cargar las Vistas'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const aplicarVista = (vista: Vista): void => {
    const resuelta = resolverVista(vista);
    setColumnas(resuelta.columnas);
    setOrdenEstado({ clave: resuelta.orden.clave, dir: resuelta.orden.dir, pagina: 1 });
    setVistaAplicada(vista);
    setIgnoradas(resuelta.ignoradas);
  };

  const guardarRepo = async (nuevo: RepoVistas): Promise<void> => {
    const res = await fetch('/api/config/vistas-ads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: nuevo }),
    });
    const body = (await res.json()) as { ok: boolean; detail?: string };
    if (!res.ok || body.ok === false) {
      setAviso(`No se pudo guardar la Vista: ${body.detail ?? `HTTP ${res.status}`}`);
      return;
    }
    setRepo(nuevo);
  };

  // ── Orden y columnas ──
  const onOrden = (clave: ClaveOrden): void => {
    setOrdenEstado((prev) => siguienteOrden(prev, clave));
  };
  const onAncho = (clave: string, ancho: number): void => {
    setColumnas((prev) => prev.map((c) => (c.clave === clave ? { ...c, ancho } : c)));
  };
  const onReordenar = (clave: string, posicion: number): void => {
    setColumnas((prev) => {
      const sin = prev.filter((c) => c.clave !== clave);
      const movida = prev.find((c) => c.clave === clave)!;
      const insertar = Math.max(2, Math.min(posicion, sin.length));
      const out = [...sin];
      out.splice(insertar, 0, { ...movida });
      return out;
    });
  };

  // ── Boton_Actualizar (R1 c7..c11) ──
  const actualizar = (): void => {
    const ahora = Date.now();
    const desdeUltimo = ahora - ultimoRefresco.current;
    if (desdeUltimo < 10_000) {
      setFrenoSegundos(Math.ceil((10_000 - desdeUltimo) / 1000));
      return;
    }
    ultimoRefresco.current = ahora;
    setFrenoSegundos(null);
    setRefrescando(true);
    pedirFilas({ forzar: true, timeoutMs: 60_000 })
      .then((body) => {
        setData(body);
        if (body.adsFreshness) setFrescura(body.adsFreshness);
      })
      .catch((err: unknown) => {
        // R1 c9: filas guardadas y marca anterior, sin modificar
        setAviso(
          `El refresco de gasto falló: ${err instanceof Error ? err.message : 'sin respuesta'} — se muestran las filas guardadas.`,
        );
      })
      .finally(() => {
        setRefrescando(false);
        setTimeout(() => setFrenoSegundos(null), 10_000);
      });
  };

  const edadGasto = ((): string => {
    if (frescura.error) return 'sync con error';
    const s = frescura.ageSeconds;
    if (s === null) return 'nunca sincronizado';
    if (s < 3600) return `hace ${Math.max(0, Math.floor(s / 60))} min`;
    return `hace ${Math.floor(s / 3600)} h`;
  })();

  // ── Acciones ─────────────────────────────────────────────────────────────
  const toggleEstado = async (fila: MetricasObjeto): Promise<void> => {
    const destino = fila.status === 'PAUSED' ? 'activate' : 'pause';
    // optimista (R14 c11: sin diálogo); el refetch posterior pinta la verdad
    setData((prev) => ({
      ...prev,
      filas: prev.filas.map((r) =>
        r.objectId === fila.objectId ? { ...r, status: destino === 'pause' ? 'PAUSED' : 'ACTIVE' } : r,
      ),
    }));
    try {
      const res = await fetch('/api/ads/acciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: fila.level, accountId: fila.accountId, action: destino, objectIds: [fila.objectId] }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        resultados?: { estado: string; mensaje: string | null }[];
      };
      if (!res.ok || body.ok === false || (body.resultados?.[0] && body.resultados[0].estado !== 'confirmado')) {
        throw new Error(body.resultados?.[0]?.mensaje ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setAviso(e instanceof Error ? e.message : String(e));
    } finally {
      setRetryTick((x) => x + 1); // R16 c6/c10: el server decide el valor final
    }
  };

  const editarPresupuesto = (fila: MetricasObjeto, eur: number): void => {
    abrirConfirmacion('budget_set', { budgetEur: eur });
  };

  const abrirConfirmacion = (accion: AccionAds, params: ParametrosAccion = {}, idsOverride?: string[]): void => {
    setDialogoPresupuesto('');
    const ids = idsOverride ?? [...estadoSel.seleccion.ids];
    const previa = calcularPrevisualizacion(
      accion,
      nivel,
      data.filas,
      ids,
      params,
      { techoEur: maxPresupuesto, topeLoteEur: maxDelta, minimoDiarioEur: null },
    );
    setConfirmacion({ accion, previa, params, ids });

    if (accion === 'duplicate') {
      // El desglose de descendientes viene de lecturas a /api/data/ads (R14 c5):
      // cero llamadas a Meta, cero llamadas al Endpoint_Acciones.
      setDialogoDuplicar({
        copias: 1,
        presupuesto: '',
        fecha: mananaMedianocheLocal(data.rango.timezone),
        hora: '00:00',
      });
      setDesglose(null);
      void cargarDesglose(ids);
    }
    if (accion === 'rename') {
      const unica = ids.length === 1 ? data.filas.find((f) => f.objectId === ids[0]) : undefined;
      setDialogoRenombrar({
        modo: unica ? 'exacto' : 'prefijo',
        prefijo: '',
        sufijo: '',
        buscar: '',
        poner: '',
        nombreExacto: unica?.objectName ?? '',
      });
    }
    if (accion === 'schedule') {
      setDialogoProgramar({ fecha: mananaMedianocheLocal(data.rango.timezone), hora: '00:00' });
    }
  };

  const cargarDesglose = async (ids: string[]): Promise<void> => {
    const qs = new URLSearchParams();
    for (const id of ids) qs.append('campaignIds', id);
    try {
      const [setsRes, adsRes] = await Promise.all([
        fetch(`/api/data/ads?level=adset&account=${account}&${qs.toString()}&limit=1000`, { cache: 'no-store' }),
        fetch(`/api/data/ads?level=ad&account=${account}&${qs.toString()}&limit=1000`, { cache: 'no-store' }),
      ]);
      const sets = (await setsRes.json()) as { filas?: MetricasObjeto[] };
      const ads = (await adsRes.json()) as { filas?: MetricasObjeto[] };
      const mapa = new Map<string, { conjuntos: number; anuncios: number }>();
      for (const id of ids) mapa.set(id, { conjuntos: 0, anuncios: 0 });
      for (const f of sets.filas ?? []) {
        const x = mapa.get(f.campaignId) ?? { conjuntos: 0, anuncios: 0 };
        mapa.set(f.campaignId, { conjuntos: x.conjuntos + 1, anuncios: x.anuncios });
      }
      for (const f of ads.filas ?? []) {
        const x = mapa.get(f.campaignId) ?? { conjuntos: 0, anuncios: 0 };
        mapa.set(f.campaignId, { conjuntos: x.conjuntos, anuncios: x.anuncios + 1 });
      }
      setDesglose(mapa);
    } catch {
      setDesglose(null); // R14 c12: la previa queda incompleta y no se ejecuta
    }
  };

  const cerrarConfirmacion = (): void => {
    // R14 c8: la Seleccion_Activa se conserva intacta, cero llamadas
    setConfirmacion(null);
    setEjecutando(false);
  };

  const ejecutarLote = async (): Promise<void> => {
    if (!confirmacion) return;
    // R9 c12: si la selección no corresponde al nivel vigente, no se llama
    if (estadoSel.seleccion.nivel !== nivel) {
      setAviso('La selección no corresponde al nivel vigente: no se ejecutó nada.');
      setEstadoSel(estadoInicial(nivel));
      cerrarConfirmacion();
      return;
    }
    const ids = confirmacion.ids;
    setEjecutando(true);
    try {
      const body: Record<string, unknown> = {
        level: nivel,
        accountId: account,
        action: confirmacion.accion,
        objectIds: ids,
      };
      if (confirmacion.accion === 'budget_set') body.budgetEur = confirmacion.params.budgetEur;
      if (confirmacion.accion === 'duplicate') {
        const n = Number(dialogoDuplicar.presupuesto);
        body.copias = dialogoDuplicar.copias;
        body.inicio = isoConOffset(data.rango.timezone, dialogoDuplicar.fecha, dialogoDuplicar.hora);
        if (dialogoDuplicar.presupuesto !== '' && Number.isFinite(n)) body.budgetEur = n;
      }
      if (confirmacion.accion === 'rename') {
        const modo = modoDeFormulario(dialogoRenombrar.modo, dialogoRenombrar);
        if (!modo) throw new Error('el modo de renombrado está incompleto');
        body.modo = modo;
      }
      if (confirmacion.accion === 'schedule') {
        body.inicio = isoConOffset(data.rango.timezone, dialogoProgramar.fecha, dialogoProgramar.hora);
      }
      // R18 c4: las filas de creación en proceso aparecen en ≤2 s de la
      // confirmación, sin recargar y sin esperar al cron.
      if (confirmacion.accion === 'duplicate') {
        const k = dialogoDuplicar.copias;
        const filasEnProceso: FilaEnProceso[] = [];
        for (const f of data.filas) {
          if (!ids.includes(f.objectId)) continue;
          for (let n = 1; n <= k; n++) {
            filasEnProceso.push({
              clave: `${f.objectId}#${n}`,
              nombrePlanificado: `${f.objectName ?? f.objectId} - Copia ${n}`,
              origenId: f.objectId,
              nivel,
            });
          }
        }
        setEnProceso(filasEnProceso);
      }
      const res = await fetch('/api/ads/acciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        // R18 c6: si el lote asíncrono no responde en 300 s, se vacía el estado
        // en proceso y se informa qué se aplicó y qué no.
        signal: AbortSignal.timeout(confirmacion.accion === 'duplicate' ? 300_000 : 60_000),
      });
      const respuesta = (await res.json()) as RespuestaLote & { ok: boolean; error?: string; detail?: string };
      // R16 c6 / R18 c9: las filas fantasma se VACÍAN completas al responder y
      // se dibuja sólo lo que devuelve el servidor.
      setEnProceso([]);
      if (!res.ok || (respuesta as { ok: boolean }).ok === false) {
        setAviso((respuesta as { detail?: string }).detail ?? (respuesta as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      setResultados(respuesta);
      setConfirmacion(null);
      setEstadoSel(estadoInicial(nivel));
      // R16 c6: dibujar SOLO lo que devuelve el servidor
      try {
        await pedirFilas({ timeoutMs: TOPES_ABORTO }).then(setData);
        setAvisoTablaVieja(false);
      } catch {
        setAvisoTablaVieja(true); // R16 c7
      }
    } catch (e) {
      // Timeout de 300 s o red: las filas en proceso se vacían igual (R18 c6);
      // los objetos ya creados quedan pausados y sin borrar, y NO hay reintento
      // automático. Las filas de ad_actions abiertas quedan indeterminadas y
      // las cierra la reconciliación.
      setEnProceso([]);
      setAviso(
        `El lote no respondió a tiempo: ${e instanceof Error ? e.message : String(e)}. ` +
          'Lo que haya quedado creado está pausado; los resultados sin confirmar se definen cuando corra la reconciliación.',
      );
      setAvisoTablaVieja(true);
    } finally {
      setEjecutando(false);
    }
  };

  // ── Totales de la barra de KPIs ──
  const filas = data.filas;
  const totGasto = filas.reduce((a, r) => a + r.spendEur, 0);
  const totIngresos = filas.reduce((a, r) => a + r.revenueEur, 0);
  const totGanancia = filas.reduce((a, r) => a + r.profitEur, 0);
  const totNeto = filas.reduce((a, r) => a + r.netEur, 0);
  const totRoi = totGasto > 0 ? totNeto / totGasto : null;
  const sinAtribuirPct =
    data.sinAtribuir.sales > 0
      ? data.sinAtribuir.sales / Math.max(1, data.sinAtribuir.sales + filas.reduce((a, r) => a + r.sales, 0))
      : 0;

  const previaConPresupuesto = useMemo(() => {
    if (!confirmacion || confirmacion.accion !== 'budget_set') return confirmacion?.previa ?? null;
    const n = Number(dialogoPresupuesto);
    const params: ParametrosAccion =
      dialogoPresupuesto !== '' && Number.isFinite(n) ? { budgetEur: n } : {};
    return calcularPrevisualizacion(
      'budget_set',
      nivel,
      data.filas,
      confirmacion.ids,
      params,
      { techoEur: maxPresupuesto, topeLoteEur: maxDelta, minimoDiarioEur: null },
    );
  }, [confirmacion, dialogoPresupuesto, nivel, data.filas, maxPresupuesto, maxDelta]);

  const previaDuplicar = useMemo(() => {
    if (!confirmacion || confirmacion.accion !== 'duplicate') return null;
    const n = Number(dialogoDuplicar.presupuesto);
    const params: ParametrosAccion = {
      copias: dialogoDuplicar.copias,
      desglose: desglose ? { porObjeto: desglose } : undefined,
      budgetEur: dialogoDuplicar.presupuesto !== '' && Number.isFinite(n) ? n : undefined,
      inicio: isoConOffset(data.rango.timezone, dialogoDuplicar.fecha, dialogoDuplicar.hora),
    };
    return calcularPrevisualizacion(
      'duplicate',
      nivel,
      data.filas,
      confirmacion.ids,
      params,
      { techoEur: maxPresupuesto, topeLoteEur: maxDelta, minimoDiarioEur: null },
    );
  }, [confirmacion, dialogoDuplicar, desglose, nivel, data.filas, maxPresupuesto, maxDelta, data.rango.timezone]);

  const previaRenombrar = useMemo(() => {
    if (!confirmacion || confirmacion.accion !== 'rename') return null;
    const modo = modoDeFormulario(dialogoRenombrar.modo, dialogoRenombrar);
    return calcularPrevisualizacion(
      'rename',
      nivel,
      data.filas,
      confirmacion.ids,
      { modo: modo ?? undefined },
      { techoEur: maxPresupuesto, topeLoteEur: maxDelta, minimoDiarioEur: null },
    );
  }, [confirmacion, dialogoRenombrar, nivel, data.filas, maxPresupuesto, maxDelta]);

  const previaProgramar = useMemo(() => {
    if (!confirmacion || confirmacion.accion !== 'schedule') return null;
    return calcularPrevisualizacion(
      'schedule',
      nivel,
      data.filas,
      confirmacion.ids,
      { inicio: isoConOffset(data.rango.timezone, dialogoProgramar.fecha, dialogoProgramar.hora) },
      { techoEur: maxPresupuesto, topeLoteEur: maxDelta, minimoDiarioEur: null },
    );
  }, [confirmacion, dialogoProgramar, nivel, data.filas, maxPresupuesto, maxDelta, data.rango.timezone]);

  const destinoPresupuesto = useMemo((): 'campaña (CBO)' | 'cada conjunto (ABO)' | 'mixto' | null => {
    if (nivel !== 'campaign' && nivel !== 'adset') return null;
    const niveles = new Set(
      data.filas
        .filter((f) => estadoSel.seleccion.ids.includes(f.objectId))
        .map((f) => f.budgetLevel),
    );
    if (niveles.size === 0) return null;
    if (niveles.has(null)) return 'mixto';
    if (niveles.size > 1) return 'mixto';
    return niveles.has('campaign') ? 'campaña (CBO)' : 'cada conjunto (ABO)';
  }, [nivel, data.filas, estadoSel.seleccion.ids]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-neutral-50">Anuncios</h1>
          {loading && <span className="text-xs text-neutral-500">Actualizando…</span>}
        </div>
        <SubNav />
      </div>

      <TabsNivel nivel={nivel} onNivel={cambiarNivel} />

      <div className="flex flex-wrap items-center justify-end gap-3">
        <BarraFrescura
          edad={edadGasto}
          error={frescura.error}
          refrescando={refrescando}
          segundosRestantes={frenoSegundos}
          onActualizar={actualizar}
        />
      </div>

      <BarraFiltros
        period={period}
        rango={data.rango}
        status={status}
        cuenta={account}
        nombre={nombre}
        cuentas={cuentas}
        cascada={
          cascada ? (
            <ChipCascada cascada={cascada} nombres={new Map(Object.entries(nombresCascada))} onLimpiar={limpiarCascada} />
          ) : null
        }
        onPeriodo={(p) => cambiarFiltro({ period: p })}
        onStatus={(s) => cambiarFiltro({ status: s })}
        onCuenta={(id) => cambiarFiltro({ account: id })}
        onNombre={(n) => cambiarFiltro({ nombre: n })}
      />

      <ControlVistas
        repo={repo}
        vistaAplicada={vistaAplicada}
        columnas={columnas}
        orden={{ clave: ordenEstado.clave, dir: ordenEstado.dir }}
        ignoradas={ignoradas}
        errorRepo={errorRepo}
        onCambiarRepo={(r) => void guardarRepo(r)}
        onAplicarVista={aplicarVista}
        onNotificar={setAviso}
      />

      <ConfiguradorColumnas columnas={columnas} onColumnas={setColumnas} />

      {(error || aviso || avisoCuenta || avisoTablaVieja) && (
        <Banner tone="bad" title="Aviso">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {error && (
              <span>
                No se pudieron cargar las filas: {error}
                <button
                  type="button"
                  onClick={() => setRetryTick((x) => x + 1)}
                  className="ml-3 rounded-md border border-border-strong px-2 py-1 font-semibold text-neutral-200 hover:bg-overlay/6"
                >
                  Reintentar
                </button>
              </span>
            )}
            {aviso && <span>{aviso}</span>}
            {avisoCuenta && <span>{avisoCuenta}</span>}
            {avisoTablaVieja && (
              <span>
                La tabla puede no reflejar el estado del servidor.
                <button
                  type="button"
                  onClick={() => setRetryTick((x) => x + 1)}
                  className="ml-3 rounded-md border border-border-strong px-2 py-1 font-semibold text-neutral-200 hover:bg-overlay/6"
                >
                  Reintentar
                </button>
              </span>
            )}
          </span>
        </Banner>
      )}

      {resultados && <ResultadosLote respuesta={resultados} />}

      {desalineada && (
        <Banner tone="warn" title="La cuenta que ves no es la del funnel elegido arriba">
          {desalineada.cuentaFunnel
            ? `Arriba está elegido "${desalineada.funnelSlug}", pero esta cuenta se imputa a "${desalineada.cuentaFunnel}". Cambiá la cuenta en los filtros, o el funnel arriba.`
            : `Arriba está elegido "${desalineada.funnelSlug}" y esta cuenta no tiene funnel imputado. Asignáselo en Config → Publicidad y el selector de arriba la va a elegir sola.`}
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Gasto" value={money(totGasto)} sub={edadGasto} tone="warn" />
        <StatCard label="Ingresos" value={money(totIngresos)} sub="bruto aprobado" />
        <StatCard label="Ganancia" value={money(totGanancia)} sub="neto − gasto" tone={totGanancia < 0 ? 'bad' : 'good'} />
        <StatCard label="ROI" value={totRoi === null ? '—' : `${totRoi.toFixed(2)}×`} sub="neto ÷ gasto de ads" tone={totRoi === null ? 'neutral' : totRoi < 1 ? 'bad' : totRoi < 2 ? 'warn' : 'good'} />
      </div>

      {data.sinAtribuir.sales > 0 && (
        <Banner tone={sinAtribuirPct > 0.2 ? 'warn' : 'info'} title="Ventas sin atribuir a un anuncio">
          {fmtInt(data.sinAtribuir.sales)} ventas ({money(data.sinAtribuir.revenueEur)}) entraron en el período pero sus UTMs no
          matchean ningún {NIVEL_LABEL[nivel].toLowerCase()}. Es plata real que esta tabla no explica.
        </Banner>
      )}

      <BarraSeleccion
        nivel={nivel}
        cantidad={estadoSel.seleccion.ids.length}
        topeAlcanzado={estadoSel.seleccion.ids.length >= MAX_SELECCION}
        onAccion={(a) => {
          if (a === 'budget_set') abrirConfirmacion(a);
          else if (a === 'pause' || a === 'activate') abrirConfirmacion(a);
          else abrirConfirmacion(a); // duplicate / schedule / rename: sus formularios llegan en las tasks siguientes
        }}
      />

      {data.total > 1000 && (
        <Banner tone="info" title="Resultado acotado">
          Los filtros alcanzan {data.total} filas y se devuelven hasta 1000 por página (tope del contrato).
        </Banner>
      )}

      <Card title={NIVEL_LABEL[nivel]} hint={`viendo ${filas.length} de ${data.total} fila(s)`}>
        {loading && filas.length === 0 ? (
          <Skeleton variant="table" rows={8} />
        ) : filas.length === 0 ? (
          <EmptyState
            title={`Sin ${NIVEL_LABEL[nivel].toLowerCase()} en el rango`}
            hint="Probá otro período, otro estado u otra cuenta en los filtros de arriba."
          />
        ) : (
          <TablaAds
            filas={filas}
            columnas={columnas}
            orden={{ clave: ordenEstado.clave, dir: ordenEstado.dir }}
            seleccionados={new Set(estadoSel.seleccion.ids)}
            grilla
            onOrden={onOrden}
            onAncho={onAncho}
            onReordenar={onReordenar}
            onSeleccion={tildar}
            onSeleccionTodas={() =>
              evento({ tipo: 'tildar_todas', idsPagina: filas.map((f) => f.objectId) })
            }
            onBajarNivel={bajarNivel}
            onEditarPresupuesto={editarPresupuesto}
            onToggleEstado={(f) => void toggleEstado(f)}
            onRenombrarFila={(fila) => abrirConfirmacion('rename', {}, [fila.objectId])}
            enProceso={enProceso}
            zona={data.rango.timezone}
          />
        )}
        <Paginacion
          pagina={ordenEstado.pagina}
          totalPaginas={data.totalPaginas}
          onPagina={(p) => setOrdenEstado((prev) => ({ ...prev, pagina: p }))}
        />
      </Card>

      {confirmacion && (
        <DialogoConfirmacion
          previa={
            confirmacion.accion === 'budget_set' && previaConPresupuesto
              ? previaConPresupuesto
              : confirmacion.accion === 'duplicate' && previaDuplicar
                ? previaDuplicar
                : confirmacion.accion === 'rename' && previaRenombrar
                  ? previaRenombrar
                  : confirmacion.accion === 'schedule' && previaProgramar
                    ? previaProgramar
                    : confirmacion.previa
          }
          ejecutando={ejecutando}
          onConfirmar={() => void ejecutarLote()}
          onCancelar={cerrarConfirmacion}
        >
          {confirmacion.accion === 'budget_set' && (
            <FormularioPresupuesto
              techoEur={maxPresupuesto}
              valor={dialogoPresupuesto}
              onValor={setDialogoPresupuesto}
            />
          )}
          {confirmacion.accion === 'duplicate' && (
            <FormularioDuplicar
              zona={data.rango.timezone}
              copias={dialogoDuplicar.copias}
              presupuesto={dialogoDuplicar.presupuesto}
              fecha={dialogoDuplicar.fecha}
              hora={dialogoDuplicar.hora}
              destinoPresupuesto={destinoPresupuesto}
              onCopias={(copias) => setDialogoDuplicar((p) => ({ ...p, copias }))}
              onPresupuesto={(presupuesto) => setDialogoDuplicar((p) => ({ ...p, presupuesto }))}
              onFecha={(fecha) => setDialogoDuplicar((p) => ({ ...p, fecha }))}
              onHora={(hora) => setDialogoDuplicar((p) => ({ ...p, hora }))}
            />
          )}
          {confirmacion.accion === 'rename' && (
            <FormularioRenombrar
              modo={dialogoRenombrar.modo}
              prefijo={dialogoRenombrar.prefijo}
              sufijo={dialogoRenombrar.sufijo}
              buscar={dialogoRenombrar.buscar}
              poner={dialogoRenombrar.poner}
              nombreExacto={dialogoRenombrar.nombreExacto}
              onModo={(modo) => setDialogoRenombrar((p) => ({ ...p, modo }))}
              onPrefijo={(prefijo) => setDialogoRenombrar((p) => ({ ...p, prefijo }))}
              onSufijo={(sufijo) => setDialogoRenombrar((p) => ({ ...p, sufijo }))}
              onBuscar={(buscar) => setDialogoRenombrar((p) => ({ ...p, buscar }))}
              onPoner={(poner) => setDialogoRenombrar((p) => ({ ...p, poner }))}
              onNombreExacto={(nombreExacto) => setDialogoRenombrar((p) => ({ ...p, nombreExacto }))}
            />
          )}
          {confirmacion.accion === 'schedule' && (
            <FormularioProgramar
              zona={data.rango.timezone}
              fecha={dialogoProgramar.fecha}
              hora={dialogoProgramar.hora}
              onFecha={(fecha) => setDialogoProgramar((p) => ({ ...p, fecha }))}
              onHora={(hora) => setDialogoProgramar((p) => ({ ...p, hora }))}
            />
          )}
        </DialogoConfirmacion>
      )}
    </div>
  );
}
