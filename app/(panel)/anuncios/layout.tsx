import { Suspense } from 'react';
import { requerirSeccion } from '@/lib/permisos';
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
export default async function AnunciosLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<JSX.Element> {
  // Guard de permiso de /anuncios (D4). Las otras siete secciones lo tienen en
  // un layout nuevo de tres líneas; ésta ya tenía layout, así que el guard va
  // adentro. El chequeo de `debeCambiarClave` lo hace el layout general (D8).
  await requerirSeccion('anuncios');
  return (
    <div className="space-y-4">
      {/* El título y el subtítulo los pone el Shell (EncabezadoPagina): acá
          queda sólo la SubNav, que es propia de esta sección. Va a la izquierda
          y no a la derecha del título, como en la captura de referencia. */}
      <Suspense fallback={<div className="h-[38px]" aria-hidden />}>
        <SubNav />
      </Suspense>
      {children}
    </div>
  );
}
