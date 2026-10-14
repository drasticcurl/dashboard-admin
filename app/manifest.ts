import type { MetadataRoute } from 'next';
import { PANEL_BRAND } from '@/lib/brand';

/*
  Manifest de la PWA. Next lo sirve en /manifest.webmanifest y agrega el <link>.

  `display: standalone` no es cosmético: en iOS las notificaciones push SÓLO
  funcionan con el panel agregado a la pantalla de inicio como app (Safari
  16.4+), y eso exige el manifest con standalone.

  El nombre sale de PANEL_BRAND: dos instancias deployan de este repo y cada una
  se instala con su nombre.
*/
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `Panel · ${PANEL_BRAND}`,
    short_name: PANEL_BRAND,
    description: 'Panel interno de métricas, ventas y anuncios.',
    start_url: '/resumen',
    scope: '/',
    display: 'standalone',
    background_color: '#0c0b14',
    theme_color: '#0c0b14',
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
