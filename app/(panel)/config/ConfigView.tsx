'use client';

/**
 * ConfigView — el shell de la pantalla de Configuración (T07 §3).
 *
 * Antes era un solo archivo de 1.528 líneas con nueve secciones apiladas: el
 * usuario la describió como "una verga". Ahora cada sección vive en su
 * propio archivo bajo sections/, y acá queda la navegación interna por
 * grupos (la sección activa viaja en `?s=`, D-R14: sobrevive al refresh y se
 * puede compartir por link) y el estado compartido (funnels, flash, busy).
 *
 * Los datos iniciales llegan del server (page.tsx). Cada mutación pega al
 * /api/config/* correspondiente y refetchea su sección. El servidor es la
 * única fuente de verdad — acá no se reimplementa nada de la lógica de
 * resolución.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  GearSix,
  ChartLineUp,
  Coins,
  Megaphone,
} from '@phosphor-icons/react';
import type { Funnel, FunnelStep } from '@/lib/funnels';
import type { CommissionRule } from '@/lib/commissions';
import type { FunnelStageRow } from '@/lib/queries/funnel';
import type {
  FxRateRow,
  PanelSettings,
  ProductMapping,
  ShopMapping,
  SystemStatus,
  UnknownStepWarning,
  UnmappedProduct,
} from '@/app/api/config/_lib';
import { Banner } from '@/components/ui';
import type { ConfigShell, Flash } from './kit';
import { FunnelsSection } from './sections/FunnelsSection';
import { PasosSection } from './sections/PasosSection';
import { EtapasSection } from './sections/EtapasSection';
import { PublicidadSection } from './sections/PublicidadSection';
import { ComisionesSection } from './sections/ComisionesSection';
import { ProductosSection } from './sections/ProductosSection';
import { TiendasSection } from './sections/TiendasSection';
import { AjustesSection } from './sections/AjustesSection';
import { CotizacionesSection } from './sections/CotizacionesSection';
import { SaludSection } from './sections/SaludSection';
import { UsuariosSection } from './sections/UsuariosSection';

export type ConfigInitial = {
  funnels: Funnel[];
  steps: FunnelStep[];
  stages: FunnelStageRow[];
  unknownSteps: UnknownStepWarning[];
  mappings: ProductMapping[];
  unmapped: UnmappedProduct[];
  shops: ShopMapping[];
  settings: PanelSettings;
  fx: FxRateRow[];
  system: SystemStatus;
  commissions: CommissionRule[];
};

type SeccionId =
  | 'funnels'
  | 'pasos'
  | 'etapas'
  | 'publicidad'
  | 'comisiones'
  | 'productos'
  | 'tiendas'
  | 'ajustes'
  | 'cotizaciones'
  | 'salud'
  | 'usuarios';

// Cuatro grupos en vez de diez pestañas: el criterio es "qué busca el
// usuario cuando entra", no qué tabla toca cada sección (T07 §3).
const GRUPOS: { id: string; label: string; icon: JSX.Element; secciones: { id: SeccionId; label: string }[] }[] = [
  {
    id: 'funnels',
    label: 'Funnels',
    icon: <ChartLineUp size={14} weight="bold" />,
    secciones: [
      { id: 'funnels', label: 'Funnels' },
      { id: 'pasos', label: 'Pasos del quiz' },
      { id: 'etapas', label: 'Etapas del embudo' },
    ],
  },
  {
    id: 'dinero',
    label: 'Dinero',
    icon: <Coins size={14} weight="bold" />,
    secciones: [
      { id: 'comisiones', label: 'Comisiones' },
      { id: 'productos', label: 'Productos' },
      { id: 'cotizaciones', label: 'Cotizaciones' },
    ],
  },
  {
    id: 'fuentes',
    label: 'Fuentes',
    icon: <Megaphone size={14} weight="bold" />,
    secciones: [
      { id: 'publicidad', label: 'Publicidad' },
      { id: 'tiendas', label: 'Tiendas' },
    ],
  },
  {
    id: 'sistema',
    label: 'Sistema',
    icon: <GearSix size={14} weight="bold" />,
    secciones: [
      { id: 'ajustes', label: 'Ajustes' },
      { id: 'salud', label: 'Salud del sistema' },
      { id: 'usuarios', label: 'Usuarios' },
    ],
  },
];

const SECCIONES_VALIDAS = new Set<string>(GRUPOS.flatMap((g) => g.secciones.map((s) => s.id)));

export function ConfigView({
  funnel,
  initial,
}: {
  funnel: Funnel;
  initial: ConfigInitial;
}): JSX.Element {
  const searchParams = useSearchParams();
  const sRaw = searchParams.get('s');
  const seccion: SeccionId = sRaw && SECCIONES_VALIDAS.has(sRaw) ? (sRaw as SeccionId) : 'funnels';

  const [funnels, setFunnels] = useState(initial.funnels);
  const [steps, setSteps] = useState(initial.steps);
  const [stages, setStages] = useState(initial.stages);
  const [unknownSteps, setUnknownSteps] = useState(initial.unknownSteps);
  const [mappings, setMappings] = useState(initial.mappings);
  const [unmapped, setUnmapped] = useState(initial.unmapped);
  const [shops, setShops] = useState(initial.shops);
  const [settings, setSettings] = useState(initial.settings);
  const [fx, setFx] = useState(initial.fx);
  const [system] = useState(initial.system);
  const [commissions, setCommissions] = useState(initial.commissions);
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);

  const show = useCallback((tone: 'good' | 'bad', text: string) => {
    setFlash({ tone, text });
  }, []);

  async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return body;
  }

  const shell: ConfigShell = { api, show, busy, setBusy };

  // El link de cada sección preserva TODO el query string (funnel, rango) y
  // cambia sólo `s` — igual que el Nav del panel.
  function hrefDe(s: SeccionId): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set('s', s);
    return `/config?${params.toString()}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-neutral-50">Configuración</h1>
        {busy && <span className="text-xs text-neutral-500">Guardando…</span>}
      </div>

      {flash && (
        <Banner tone={flash.tone} title={flash.tone === 'good' ? 'Listo' : 'No se pudo'}>
          {flash.text}
        </Banner>
      )}

      <nav aria-label="Secciones de Configuración" className="flex flex-col gap-2 rounded-2xl border border-border-subtle bg-surface p-2">
        {GRUPOS.map((g) => (
          <div key={g.id} className="flex flex-wrap items-center gap-1">
            <span className="flex w-24 shrink-0 items-center gap-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {g.icon} {g.label}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              {g.secciones.map((s) => {
                const active = s.id === seccion;
                return (
                  <Link
                    key={s.id}
                    href={hrefDe(s.id)}
                    aria-current={active ? 'page' : undefined}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50 ${
                      active
                        ? 'bg-overlay/8 text-neutral-50'
                        : 'text-neutral-400 hover:bg-overlay/5 hover:text-neutral-200'
                    }`}
                  >
                    {s.label}
                  </Link>
                );
              })}
            </span>
          </div>
        ))}
      </nav>

      {seccion === 'funnels' && <FunnelsSection funnels={funnels} setFunnels={setFunnels} shell={shell} />}
      {seccion === 'pasos' && (
        <PasosSection
          funnel={funnel}
          steps={steps}
          setSteps={setSteps}
          unknownSteps={unknownSteps}
          setUnknownSteps={setUnknownSteps}
          shell={shell}
        />
      )}
      {seccion === 'etapas' && (
        <EtapasSection funnel={funnel} steps={steps} stages={stages} setStages={setStages} shell={shell} />
      )}
      {seccion === 'publicidad' && <PublicidadSection funnels={funnels} shell={shell} />}
      {seccion === 'comisiones' && (
        <ComisionesSection
          funnels={funnels}
          commissions={commissions}
          setCommissions={setCommissions}
          shell={shell}
        />
      )}
      {seccion === 'productos' && (
        <ProductosSection
          funnel={funnel}
          funnels={funnels}
          mappings={mappings}
          setMappings={setMappings}
          unmapped={unmapped}
          setUnmapped={setUnmapped}
          shell={shell}
        />
      )}
      {seccion === 'tiendas' && (
        <TiendasSection funnel={funnel} funnels={funnels} shops={shops} setShops={setShops} shell={shell} />
      )}
      {seccion === 'ajustes' && <AjustesSection settings={settings} setSettings={setSettings} shell={shell} />}
      {seccion === 'cotizaciones' && <CotizacionesSection fx={fx} setFx={setFx} shell={shell} />}
      {seccion === 'salud' && <SaludSection initialSystem={system} shell={shell} />}
      {seccion === 'usuarios' && <UsuariosSection shell={shell} />}
    </div>
  );
}
