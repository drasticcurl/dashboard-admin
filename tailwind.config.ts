import type { Config } from 'tailwindcss';

/**
 * Tokens del panel: la paleta vive acá, no hardcodeada en las vistas. Los
 * nombres dicen QUÉ es, no de qué color es: `surface` sobrevive a un cambio de
 * paleta, `gris-oscuro` no.
 *
 * ── Rediseño "vidrio líquido" ──────────────────────────────────────────────
 *
 * Este archivo es la palanca del rediseño: cambiar un token acá repinta las 8
 * pantallas sin tocar un solo call site. Tres decisiones concentran casi todo
 * el cambio visual, y las tres viven en este archivo:
 *
 *   1. UN acento, no dos. Antes había un degradado violeta→esmeralda en el
 *      logo y en el glow del layout, y al mismo tiempo `good` (verde) en los
 *      botones, los focus ring y la tab activa. Dos identidades peleando. El
 *      violeta se fue: el acento del panel es `good`, que es el que ya usaban
 *      los controles. Los otros tres tonos (warn/bad/info) NO son acentos,
 *      son semántica —verde bien, rojo mal— y por eso sobreviven.
 *
 *   2. Los grises del texto se retiñeron. `neutral` de Tailwind es un gris
 *      PURO (#737373) y el canvas del panel tiene tinte azul: mezclar los dos
 *      es mezclar familias de gris, que es lo que hacía ver la UI "sucia".
 *      Acá `neutral` se sobreescribe con un grafito frío del mismo hue que el
 *      canvas. Son ~500 usos de `text-neutral-*` que se corrigen solos.
 *      Los tonos apagados (400/500) quedaron MÁS claros que los de Tailwind,
 *      no más oscuros: `text-neutral-500` sobre `surface` pasa de ~4.0:1 a
 *      ~4.6:1 de contraste. El rediseño no se paga con accesibilidad.
 *
 *   3. La escala de radios se corrió hacia arriba en lugar de cambiar los 174
 *      `rounded-*` del repo. `rounded-lg` pasa de 8px a 12px, `rounded-2xl` de
 *      16px a 22px. Es el cambio con mejor relación impacto/riesgo de todo el
 *      rediseño: toca 0 call sites y es lo que hace que el panel "se sienta"
 *      iOS. Los radios siguen escalonados a propósito (más chico adentro, más
 *      suave afuera), no uniformes.
 *
 * `panelColors` es la misma paleta como valores JS, para recharts: los
 * gráficos reciben strings, no clases de Tailwind. La fuente de verdad es
 * esta; si un gráfico repite un literal, está desincronizado.
 */

export const panelColors = {
  /**
   * El fondo del panel. Casi negro pero NO #000: negro puro sobre un panel
   * de datos aplasta el contraste de las tarjetas y hace ver los bordes como
   * suciedad. Este lleva un tinte azul mínimo que es el hue del que salen
   * todos los grises y todas las sombras.
   */
  canvas: '#08090d',
  surface: '#111219',
  surfaceRaised: '#191b24',
  /** Un peldaño más arriba, para popovers y modales sobre `surfaceRaised`. */
  surfaceOverlay: '#21242f',
  /** El color de los ticks de eje y textos suaves de los gráficos. */
  axis: '#8c8f9c',
  /** Texto sobre relleno claro (etiquetas dentro de una barra). */
  ink: '#0e1015',
  /** Texto sobre el canvas, en SVG donde no llegan las clases. */
  inkOnDark: '#d7dae2',
  /** El relleno "sin severidad" del embudo: neutral-700. */
  muted: '#3c414e',
  good: '#22c58a',
  warn: '#e8a33d',
  bad: '#ec5a63',
  info: '#4a9ae8',
  /**
   * Los tonos -400 como valores JS. Existen porque el mix por tier de Ventas
   * necesita CINCO series distinguibles y sólo hay cuatro tonos semánticos:
   * antes los dos que faltaban eran literales (#38bdf8, #fb7185) escritos a
   * mano justo debajo de un comentario que juraba que no había literales.
   */
  infoLight: '#6cb0ee',
  badLight: '#f47178',
  /** Cromo de los gráficos: hoy duplicado como literal en 5 archivos. */
  grid: 'rgba(255, 255, 255, 0.05)',
  axisLine: 'rgba(255, 255, 255, 0.10)',
  cursor: 'rgba(255, 255, 255, 0.04)',
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
        'surface-overlay': panelColors.surfaceOverlay,
        // Blanco puro pensado para usarse con modificador de alfa
        // (bg-overlay/4, border-overlay/20): los fills translúcidos del panel.
        overlay: '#ffffff',
        'border-subtle': 'rgba(255, 255, 255, 0.06)',
        'border-strong': 'rgba(255, 255, 255, 0.10)',
        /**
         * El grafito frío que reemplaza al `neutral` puro de Tailwind (ver
         * decisión 2 arriba). Mismo hue que el canvas para que texto y fondo
         * pertenezcan a la misma familia.
         */
        neutral: {
          50: '#f7f8fa',
          100: '#eceef3',
          200: '#d7dae2',
          300: '#b4b9c5',
          400: '#8e93a3',
          500: '#787e8e',
          600: '#565c6b',
          700: '#3c414e',
          800: '#282c37',
          900: '#191c24',
          950: '#0e1015',
        },
        good: {
          200: '#a8f2d7',
          300: '#6fe7bd',
          400: '#3ed7a0',
          500: panelColors.good,
          600: '#16a372',
        },
        warn: {
          200: '#fbe0b4',
          300: '#f8cc86',
          400: '#f2b757',
          500: panelColors.warn,
          600: '#c2822a',
        },
        bad: {
          200: '#fcc3c6',
          300: '#f9979c',
          400: '#f47178',
          500: panelColors.bad,
          600: '#c93f47',
        },
        info: {
          200: '#c6e1fa',
          300: '#9bcaf5',
          400: '#6cb0ee',
          500: panelColors.info,
          600: '#2f7cc4',
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
        1: '0.01',
        2: '0.02',
        3: '0.03',
        4: '0.04',
        6: '0.06',
        7: '0.07',
        8: '0.08',
        9: '0.09',
        11: '0.11',
        12: '0.12',
        14: '0.14',
        16: '0.16',
        18: '0.18',
        22: '0.22',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      /**
       * Radios corridos hacia arriba (decisión 3). Los nombres son los de
       * Tailwind a propósito: así los 174 `rounded-*` que ya existen heredan
       * la curva nueva sin editarse.
       */
      borderRadius: {
        DEFAULT: '0.5rem',
        sm: '0.3125rem',
        md: '0.625rem',
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.375rem',
        '3xl': '1.75rem',
      },
      /**
       * Sombras TEÑIDAS con el hue del canvas, no negro puro. Una sombra
       * `rgba(0,0,0,.6)` sobre un fondo azulado se lee como un agujero gris;
       * teñida se lee como profundidad.
       *
       * Todas arrancan con el mismo highlight interno de 1px arriba: es el
       * reflejo especular del borde superior, la pieza que hace que una
       * superficie parezca vidrio y no un rectángulo pintado. La dirección de
       * la luz es UNA sola en todo el panel: desde arriba.
       */
      boxShadow: {
        'inset-highlight': 'inset 0 1px 0 0 rgba(255, 255, 255, 0.05)',
        card:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.05), 0 1px 2px -1px rgba(4, 6, 14, 0.7), 0 10px 28px -14px rgba(4, 6, 14, 0.75)',
        'card-hover':
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.08), 0 2px 4px -2px rgba(4, 6, 14, 0.7), 0 18px 44px -18px rgba(4, 6, 14, 0.85)',
        /** Vidrio: highlight arriba + refracción en el borde + sombra teñida. */
        glass:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.07), inset 0 0 0 1px rgba(255, 255, 255, 0.04), 0 12px 32px -16px rgba(4, 6, 14, 0.8)',
        /** Popovers y modales: la misma luz, más caída. */
        float:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.06), 0 24px 60px -20px rgba(4, 6, 14, 0.9)',
        /** La pastilla activa de un control segmentado (Nav, toggles). */
        lozenge:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.11), 0 1px 2px 0 rgba(4, 6, 14, 0.6), 0 4px 12px -6px rgba(4, 6, 14, 0.7)',
        /** Halo del acento, para el logo y el estado activo. */
        'glow-good': '0 6px 20px -6px rgba(34, 197, 138, 0.45)',
      },
      transitionTimingFunction: {
        /**
         * La curva del panel. `spring` sobrepasa un poco el destino y vuelve:
         * es lo que hace que un hover se sienta con peso en lugar de lineal.
         * `smooth` es para lo que no debe rebotar (opacidad, color).
         */
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        smooth: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      transitionDuration: {
        250: '250ms',
      },
      keyframes: {
        /**
         * Entrada de las tarjetas: sube y aparece. Nunca todo junto.
         *
         * Termina en `transform: none` y NO en `translate3d(0,0,0)`, que sería
         * lo natural de escribir. La razón es que la animación corre con
         * `fill-mode: both`, así que el último keyframe queda aplicado para
         * siempre — y un `transform` permanente en un ancestro convierte a ese
         * ancestro en el bloque contenedor de sus descendientes `position:
         * fixed`. Con `translate3d(0,0,0)` los modales del panel (que son
         * `fixed inset-0`) quedarían encerrados dentro de la tarjeta en lugar
         * de cubrir la pantalla. Con `none` no queda transform y no hay bloque
         * contenedor.
         */
        'rise-in': {
          from: { opacity: '0', transform: 'translate3d(0, 10px, 0)' },
          to: { opacity: '1', transform: 'none' },
        },
        /**
         * El aro que late alrededor del botón «Cargar saldo de hoy» cuando el
         * saldo del día todavía no se cargó. Es un recordatorio, no un estado
         * de carga.
         *
         * Va por `box-shadow` y NO por `opacity` (que es lo que hace
         * `animate-pulse`): un botón que se desvanece y vuelve se lee como
         * "deshabilitado, intermitente" —el mismo motivo por el que el Skeleton
         * de este panel descartó `animate-pulse`— mientras que un aro que se
         * expande alrededor de un botón sólido se lee como "acá, tocá esto".
         *
         * 2.4s y no 1s: a un segundo el latido compite con el contenido y
         * cansa. Y el aro NUNCA llega a opacidad 0 en el keyframe intermedio,
         * porque un borde que desaparece del todo hace parpadear el layout
         * óptico del botón.
         *
         * Se apaga sola con `prefers-reduced-motion` (regla de @layer base, que
         * fuerza `animation-iteration-count: 1`), así que el botón queda
         * amarillo y quieto: el color sigue diciendo lo mismo sin el
         * movimiento.
         */
        latido: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(232, 163, 61, 0.45)' },
          '50%': { boxShadow: '0 0 0 6px rgba(232, 163, 61, 0)' },
        },
        /**
         * Barrido del skeleton: reemplaza al `animate-pulse` plano. Arranca
         * FUERA de la caja por la izquierda; sin el `from` explícito el brillo
         * aparece de la nada en el medio en el primer ciclo.
         */
        shimmer: {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'rise-in': 'rise-in 420ms cubic-bezier(0.32, 0.72, 0, 1) both',
        shimmer: 'shimmer 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        latido: 'latido 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
