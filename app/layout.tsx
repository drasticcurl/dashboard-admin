import './globals.css';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Bricolage_Grotesque } from 'next/font/google';
import { PANEL_TITLE } from '@/lib/brand';

export const metadata = {
  /*
    `template` hace que cada sección pueda poner su propio título y el sufijo
    lo agregue el layout. `robots: noindex` se queda: esto es un panel privado
    y no tiene nada que hacer en un buscador (por eso tampoco lleva og:image ni
    tags de compartir en redes: no hay nada que compartir).

    El nombre sale de `PANEL_BRAND` (lib/brand.ts): varias instancias deployan
    de este mismo repo y cada una tiene que decir el nombre de su proyecto.
  */
  title: { default: PANEL_TITLE, template: '%s · Panel' },
  description: 'Panel interno de métricas, ventas y anuncios.',
  robots: { index: false, follow: false },
};

/*
  La fuente display del panel (D6): SOLO títulos. Variable y sin `weight`, así
  un solo archivo cubre el semibold del h1 y el medium de las tarjetas.

  `axes: ['opsz']` suma el eje de tamaño óptico (12 a 96): Bricolage dibuja
  un corte distinto a tamaño de título que a tamaño de texto, y el navegador
  lo elige solo con `font-optical-sizing: auto`, que es el default. Sin el
  eje, next/font sirve únicamente el corte por defecto (opsz 14) y el h1 de
  26px sale con el dibujo pensado para texto chico.

  `next/font` la baja en el BUILD y la sirve desde el propio dominio: no hay
  request a Google en runtime.
*/
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  axes: ['opsz'],
});

/*
  El color de la barra del navegador en móvil. Sin esto, iOS y Android pintan la
  barra de un gris claro arriba de un panel oscuro y se ve como si la página
  estuviera cortada.
*/
export const viewport = {
  themeColor: '#0c0b14',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={`${GeistSans.variable} ${GeistMono.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
