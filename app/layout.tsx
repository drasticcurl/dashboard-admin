import './globals.css';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';

export const metadata = {
  /*
    `template` hace que cada sección pueda poner su propio título y el sufijo
    lo agregue el layout. `robots: noindex` se queda: esto es un panel privado
    y no tiene nada que hacer en un buscador (por eso tampoco lleva og:image ni
    tags de compartir en redes: no hay nada que compartir).
  */
  title: { default: 'Panel · Hilvan', template: '%s · Panel' },
  description: 'Panel interno de métricas, ventas y anuncios.',
  robots: { index: false, follow: false },
};

/*
  El color de la barra del navegador en móvil. Sin esto, iOS y Android pintan la
  barra de un gris claro arriba de un panel oscuro y se ve como si la página
  estuviera cortada.
*/
export const viewport = {
  themeColor: '#08090d',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
