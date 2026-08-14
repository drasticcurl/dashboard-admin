import type { Config } from 'tailwindcss';

/**
 * Tokens del rediseño (D-R13): la paleta del panel vive acá, no hardcodeada
 * en las vistas. Los nombres dicen QUÉ es, no de qué color es: `surface`
 * sobrevive a un cambio de paleta, `gris-oscuro` no.
 *
 * El día 1 no cambia nada visualmente: canvas, surface y surface-raised son
 * exactamente los hex que ya estaban (#0a0a0f, #13131a, #1b1b24), los bordes
 * son los white/6% y white/10% de siempre, y los tonos good/warn/bad/info son
 * la paleta emerald/amber/rose/sky que ya usaba `components/ui.tsx`.
 *
 * `panelColors` es la misma paleta como valores JS, para recharts: los
 * gráficos reciben strings, no clases de Tailwind. Hoy los literales
 * (#10b981, #f43f5e, #a1a1aa) están duplicados a mano en dos vistas; la
 * fuente de verdad es esta.
 */

export const panelColors = {
  canvas: '#0a0a0f',
  surface: '#13131a',
  surfaceRaised: '#1b1b24',
  /** El color de los ticks de eje y textos suaves de los gráficos. */
  axis: '#a1a1aa',
  good: '#10b981',
  warn: '#f59e0b',
  bad: '#f43f5e',
  info: '#0ea5e9',
};

export default {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: panelColors.canvas,
        surface: panelColors.surface,
        'surface-raised': panelColors.surfaceRaised,
        // Blanco puro pensado para usarse con modificador de alfa
        // (bg-overlay/4, border-overlay/20): los fills translúcidos del panel.
        overlay: '#ffffff',
        'border-subtle': 'rgba(255, 255, 255, 0.06)',
        'border-strong': 'rgba(255, 255, 255, 0.10)',
        good: {
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: panelColors.good,
        },
        warn: {
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: panelColors.warn,
        },
        bad: {
          200: '#fecdd3',
          300: '#fda4af',
          400: '#fb7185',
          500: panelColors.bad,
        },
        info: {
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: panelColors.info,
        },
      },
      /**
       * La escala de opacidad del panel.
       *
       * Tailwind SÓLO genera los modificadores de alfa que están en esta
       * escala, y su default arranca en 5 y salta a 10. Los fills del panel
       * son mucho más sutiles que eso (2%, 4%, 6%, 8%), así que sin estos
       * valores `bg-overlay/4` no emite NADA de CSS y el elemento se queda
       * sin fondo. No falla la build, no avisa nadie: simplemente no hay
       * regla. Eran 58 usos muertos, y se veía de dos formas:
       *
       *   - los <select> y <input> (bg-overlay/4) quedaban con el fondo por
       *     defecto del navegador, o sea BLANCO en un panel oscuro;
       *   - la tab activa del Nav (bg-overlay/8) no tenía fondo, así que
       *     "dónde estoy parado" se reducía al color de la letra.
       *
       * Si agregás un fill nuevo, el valor va acá primero.
       */
      opacity: {
        2: '0.02',
        3: '0.03',
        4: '0.04',
        6: '0.06',
        7: '0.07',
        8: '0.08',
        12: '0.12',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        'inset-highlight': '0 1px 0 0 rgba(255, 255, 255, 0.03) inset',
        card: '0 1px 0 0 rgba(255, 255, 255, 0.03) inset, 0 8px 24px -12px rgba(0, 0, 0, 0.6)',
      },
    },
  },
  plugins: [],
} satisfies Config;
