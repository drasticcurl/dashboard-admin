import { Suspense } from 'react';
import { SubNav } from './SubNav';

/**
 * Layout de la sección Anuncios.
 *
 * El encabezado (título + SubNav) vive ACÁ y no dentro de cada vista. Antes cada
 * una lo renderizaba por su cuenta y con layouts distintos: `GestorAnuncios` lo
 * ponía a la derecha del título en un `justify-between`, mientras `ReglasView` e
 * `HistorialView` lo ponían DEBAJO del título y alineado a la izquierda. El
 * resultado era que el switch de pestañas saltaba de lugar al cambiar de
 * pestaña, que es exactamente lo que esto cierra.
 *
 * El título dice "Anuncios" en las tres. Cuál estás viendo ya lo comunica la
 * pestaña activa; un <h1> que además cambia de texto es parte de lo que hacía
 * sentir que se movía toda la pantalla.
 *
 * `SubNav` usa `useSearchParams`, así que va dentro de un `Suspense` con un
 * fallback de la misma altura: sin eso el primer render deja el hueco vacío y
 * vuelve a haber salto de layout.
 */
export default function AnunciosLayout({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-neutral-50">Anuncios</h1>
        <Suspense fallback={<div className="h-[34px]" aria-hidden />}>
          <SubNav />
        </Suspense>
      </div>
      {children}
    </div>
  );
}
