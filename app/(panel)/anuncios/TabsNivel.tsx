'use client';

/**
 * TabsNivel (task 20.1): las tres pestañas del Gestor_Anuncios (R1 c1, c2, c3,
 * c15). En el borde superior, con ícono, visibles sin desplazamiento ni
 * interacción previa. La del Nivel_Activo lleva color de rótulo distinto,
 * subrayado y `aria-current="page"`; las otras dos, nada de eso. Activar la
 * pestaña vigente no dispara ningún pedido (lo decide el llamador: no cambia
 * nada y por eso no llama).
 */

import { Funnel, Images, Megaphone } from '@phosphor-icons/react';
import type { NivelAds } from '@/lib/ads/tipos';

const TABS: { nivel: NivelAds; rotulo: string; Icono: typeof Megaphone }[] = [
  { nivel: 'campaign', rotulo: 'Campañas', Icono: Megaphone },
  { nivel: 'adset', rotulo: 'Conjuntos', Icono: Funnel },
  { nivel: 'ad', rotulo: 'Anuncios', Icono: Images },
];

export function TabsNivel({
  nivel,
  onNivel,
}: {
  nivel: NivelAds;
  onNivel: (nivel: NivelAds) => void;
}): JSX.Element {
  return (
    <div role="tablist" aria-label="Nivel de la jerarquía" className="flex items-end gap-1">
      {TABS.map(({ nivel: n, rotulo, Icono }) => {
        const activa = n === nivel;
        return (
          <button
            key={n}
            type="button"
            role="tab"
            aria-selected={activa}
            aria-current={activa ? 'page' : undefined}
            onClick={() => onNivel(n)}
            className={`flex items-center gap-2 rounded-t-lg border-x border-t px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60 ${
              activa
                ? 'border-border-subtle border-b-transparent bg-surface text-good-300'
                : 'border-transparent text-neutral-500 hover:text-neutral-300'
            } ${activa ? 'shadow-[inset_0_-2px_0_var(--tw-shadow-color)] shadow-good-500' : ''}`}
          >
            <Icono size={16} weight={activa ? 'fill' : 'regular'} aria-hidden="true" />
            {rotulo}
          </button>
        );
      })}
    </div>
  );
}
