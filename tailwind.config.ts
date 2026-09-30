import type { Config } from 'tailwindcss';

/**
 * Tokens del panel: la paleta vive acá, no hardcodeada en las vistas. Los
 * nombres dicen QUÉ es, no de qué color es: `surface` sobrevive a un cambio de
 * paleta, `gris-oscuro` no.
 *
 * ── Rediseño "vidrio líquido" (v3) y rediseño "iris sobre tinta" ───────────
 *
 * Este archivo es la palanca del rediseño: cambiar un token acá repinta las 9
 * pantallas sin tocar un solo call site. Tres decisiones concentran casi todo
 * el cambio visual, y las tres viven en este archivo:
 *
 *   1. El acento NO es `good`. Hasta v3 el acento del panel era el verde de
 *      `good`, y eso hacía que un botón «Guardar» y una celda de ganancia
 *      fueran del MISMO color: en un panel de plata, el ojo no podía separar
 *      "tocá esto" de "esto salió bien", que es la lectura principal. Ahora la
 *      interfaz (botones, foco, selección, activo, logo) va en `acento`, un
 *      iris violáceo, y `good`/`warn`/`bad`/`info` quedan SOLO como semántica
 *      —verde bien, rojo mal—. Un verde en pantalla vuelve a querer decir algo.
 *
 *   2. Los grises del texto se retiñeron. `neutral` de Tailwind es un gris
 *      PURO (#737373) y el canvas del panel tiene tinte de tinta violácea:
 *      mezclar los dos es mezclar familias de gris, que es lo que hacía ver la
 *      UI "sucia". Acá `neutral` se sobreescribe con un grafito del MISMO hue
 *      que el canvas (retinteado de azul a violeta en el rediseño iris, junto
 *      con el canvas). Son ~800 usos de `neutral-*` que se corrigen solos.
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
   * suciedad. Este lleva un tinte de tinta violácea, el hue del que salen
   * todos los grises y todas las sombras: es el que hace que el iris del
   * acento se sienta de la casa y no pegado encima.
   */
  canvas: '#0c0b14',
  surface: '#15141f',
  surfaceRaised: '#1d1c2b',
  /** Un peldaño más arriba, para popovers y modales sobre `surfaceRaised`. */
  surfaceOverlay: '#252437',
  /** El color de los ticks de eje y textos suaves de los gráficos. */
  axis: '#9894ab',
  /** Texto sobre relleno claro (etiquetas dentro de una barra). */
  ink: '#0c0b14',
  /** Texto sobre el canvas, en SVG donde no llegan las clases. */
  inkOnDark: '#d8d6e4',
  /** El relleno "sin severidad" del embudo: neutral-700. */
  muted: '#3e3b4f',
  good: '#34d39a',
  warn: '#f0b04a',
  bad: '#ff6b72',
  info: '#5cb8ff',
  /**
   * Los tonos -400 como valores JS. Existen porque el mix por tier de Ventas
   * necesita CINCO series distinguibles y sólo hay cuatro tonos semánticos:
   * antes los dos que faltaban eran literales (#38bdf8, #fb7185) escritos a
   * mano justo debajo de un comentario que juraba que no había literales.
   */
  infoLight: '#7cc5ff',
  badLight: '#ff8388',
  /**
   * El acento como valor JS, para la serie principal "sin juicio" de un
   * gráfico (ventas, gasto, leads): D8. Pintarla de `good` hacía que un
   * gráfico de ventas se leyera como "todo bien" aunque se estuviera
   * perdiendo plata. `acentoLight` es la serie secundaria del mismo tono.
   */
  acento: '#8b7bff',
  acentoLight: '#b0a6ff',
  /** Cromo de los gráficos: hoy duplicado como literal en 5 archivos. */
  grid: 'rgba(255, 255, 255, 0.05)',
  axisLine: 'rgba(255, 255, 255, 0.10)',
  /**
   * La columna bajo el mouse, teñida del acento y no blanca: es "lo que estás
   * mirando", o sea interfaz, y un blanco translúcido sobre el canvas violáceo
   * se lee gris lavado.
   */
  cursor: 'rgba(139, 123, 255, 0.08)',
};

export default {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    /**
     * `extend.screens` y no `screens` a secas: así sobreviven sm/md/lg/xl, que
     * son los que usan las ~300 clases responsive que ya existen.
     *
     * `panel` es el corte del rediseño v3: 760px. No es ninguno de los de
     * Tailwind (sm=640, md=768) y no se puede aproximar con `md`, porque el
     * handoff define el shell entero contra ese número —sidebar a partir de
     * 760, drawer por debajo— y un layout que cambia a 768 mientras el resto
     * del CSS cambia a 760 deja 8px de viewport con el sidebar y el header
     * móvil montados a la vez.
     */
    extend: {
      screens: {
        panel: '760px',
      },
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
         * El `divider` del handoff v3 (rgba(255,255,255,.08)): el separador de
         * las piezas nuevas (sidebar, header del modal, footer del popover).
         * Queda EN MEDIO de subtle (.06) y strong (.10) a propósito: los dos que
         * ya existían son el borde de una tarjeta y el de un control, y una
         * línea que divide dos zonas de la MISMA superficie necesita más peso
         * que el primero y menos que el segundo.
         */
        divider: 'rgba(255, 255, 255, 0.08)',
        /**
         * El grafito frío que reemplaza al `neutral` puro de Tailwind (ver
         * decisión 2 arriba). Mismo hue que el canvas para que texto y fondo
         * pertenezcan a la misma familia.
         */
        neutral: {
          50: '#f7f7fb',
          100: '#ecebf3',
          200: '#d8d6e4',
          300: '#b6b3c7',
          400: '#9894ab',
          500: '#827e98',
          600: '#5c5870',
          700: '#3e3b4f',
          800: '#2a2839',
          900: '#1b1a26',
          950: '#0f0e17',
        },
        /**
         * El acento de la INTERFAZ: iris. Botones primarios, foco, lo
         * seleccionado/activo, checkboxes, links, el logo (decisión 1).
         *
         * Se llama `acento` y no `accent` a propósito: `accent-*` ya es la
         * utilidad de `accent-color` de Tailwind, y el checkbox del acento se
         * escribiría `accent-accent-500`, que no se puede leer.
         *
         * Los pasos significan lo MISMO que en `good` (100/200 texto sobre el
         * relleno oscuro, 300/400 texto sobre surface, 500 base, 600 base
         * oscura, 700 borde, 800 relleno medio, 900 relleno de fila activa): así
         * migrar `bg-good-900` → `bg-acento-900` es cambiar una palabra, no
         * re-decidir contraste en cada call site. Los contrastes están medidos
         * una sola vez en tasks/rediseno-iris/_verificacion-contraste.mjs.
         *
         * 900 existe por lo mismo que existía en `good`: "la fila con la que
         * estoy trabajando" no puede verse igual que "la fila debajo del mouse"
         * (`bg-overlay/4`). El activo lleva color; el hover sigue neutro.
         */
        acento: {
          100: '#e6e2ff',
          200: '#cbc4ff',
          300: panelColors.acentoLight,
          400: '#9d8fff',
          500: panelColors.acento,
          600: '#6f5ef0',
          700: '#5242c4',
          800: '#352a85',
          900: '#1e1848',
        },
        /**
         * "Esto está bien": ganancia, tendencia a favor, activo/entregando, una
         * acción que salió bien. NO es un color de interfaz desde el rediseño
         * iris; si un verde aparece en un botón o en un foco, es un bug de D1.
         *
         * Conserva sus 100 y 700..900 (los rellenos oscuros) porque los estados
         * semánticos también los usan: la pastilla "Activo", la fila de un "Sí".
         */
        good: {
          100: '#d3f8ea',
          200: '#a9f0d6',
          300: '#74e4bd',
          400: '#4fdba9',
          500: panelColors.good,
          600: '#1fa877',
          700: '#17805b',
          800: '#10553d',
          900: '#0a2e22',
        },
        warn: {
          200: '#fbe3b8',
          300: '#f7cf8a',
          400: '#f3bf66',
          500: panelColors.warn,
          600: '#c98b2a',
        },
        bad: {
          200: '#ffc8cb',
          300: '#ff9ea3',
          400: panelColors.badLight,
          500: panelColors.bad,
          600: '#d94a52',
        },
        info: {
          200: '#cbe7ff',
          300: '#9fd3ff',
          400: panelColors.infoLight,
          500: panelColors.info,
          600: '#3592db',
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
      /**
       * La escala de capas del panel, con NOMBRE. Antes eran números sueltos en
       * el markup y el resultado fue un bug real: el aviso flotante de saldo
       * (z-40) quedaba ARRIBA del popover anclado a la fila (z-30), así que al
       * tocar «⋯» en las últimas filas de Anuncios el popover salía por debajo
       * del aviso —se veía la mitad— y encima el aviso se comía los clicks.
       *
       * El orden es el de "qué puede tapar a qué", y los empates están
       * prohibidos a propósito: dos capas con el mismo z-index las ordena el
       * DOM, que es el tipo de empate que se rompe solo cuando alguien mueve un
       * componente de lugar.
       *
       *   contenido   (auto) — las tarjetas y tablas
       *   barra       20     — el header sticky
       *   aviso       30     — el recordatorio flotante de saldo
       *   grano       40     — la textura decorativa (pointer-events:none)
       *   popover     45     — el popover anclado a una fila: ARRIBA del grano
       *                        y del aviso, DEBAJO de los modales
       *   modal       50     — modales, drawer y sus backdrops
       *   salto       60     — el link "Saltar al contenido"
       */
      zIndex: {
        barra: '20',
        aviso: '30',
        grano: '40',
        popover: '45',
        modal: '50',
        salto: '60',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        /**
         * Bricolage Grotesque, SOLO para títulos (D6): h1 de pantalla, título de
         * tarjeta, de sección, de modal, el nombre del panel. Nunca en números,
         * tablas ni botones: sus cifras no son tabulares y una columna de
         * importes en Bricolage baila de fila en fila. El fallback es Geist y
         * no el sistema, así el primer frame (antes del swap) ya tiene la
         * métrica del resto del panel y el título no salta de ancho.
         */
        display: ['var(--font-display)', 'var(--font-geist-sans)', 'system-ui', 'sans-serif'],
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
       * `rgba(0,0,0,.6)` sobre un fondo violáceo se lee como un agujero gris;
       * teñida se lee como profundidad. El hue es `12 10 28`, el mismo que
       * `--sombra` en globals.css: si cambia uno, cambia el otro.
       *
       * Todas arrancan con el mismo highlight interno de 1px arriba: es el
       * reflejo especular del borde superior, la pieza que hace que una
       * superficie parezca vidrio y no un rectángulo pintado. La dirección de
       * la luz es UNA sola en todo el panel: desde arriba.
       */
      boxShadow: {
        'inset-highlight': 'inset 0 1px 0 0 rgba(255, 255, 255, 0.05)',
        card:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.05), 0 1px 2px -1px rgba(12, 10, 28, 0.7), 0 10px 28px -14px rgba(12, 10, 28, 0.75)',
        'card-hover':
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.08), 0 2px 4px -2px rgba(12, 10, 28, 0.7), 0 18px 44px -18px rgba(12, 10, 28, 0.85)',
        /** Vidrio: highlight arriba + refracción en el borde + sombra teñida. */
        glass:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.07), inset 0 0 0 1px rgba(255, 255, 255, 0.04), 0 12px 32px -16px rgba(12, 10, 28, 0.8)',
        /** Popovers y modales: la misma luz, más caída. */
        float:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.06), 0 24px 60px -20px rgba(12, 10, 28, 0.9)',
        /**
         * El popover anclado a una fila y la hoja de mobile (shadow-lg del
         * handoff v3). Se diferencia de `float` en el anillo de 1px: `float`
         * apoya sobre el canvas, y este apoya sobre una TABLA con sus propias
         * líneas de grilla, así que sin un borde explícito el canto del popover
         * se confunde con el borde de la celda que tiene detrás.
         */
        popover:
          '0 0 0 1px rgba(255, 255, 255, 0.14), 0 16px 40px rgba(0, 0, 0, 0.7)',
        /** La pastilla activa de un control segmentado (Nav, toggles). */
        lozenge:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.11), 0 1px 2px 0 rgba(12, 10, 28, 0.6), 0 4px 12px -6px rgba(12, 10, 28, 0.7)',
        /**
         * Halo del acento: el logo y el botón primario. Es luz del iris sobre
         * la tinta, así que el botón parece encendido y no apoyado.
         */
        'glow-acento': '0 6px 20px -6px rgba(139, 123, 255, 0.45)',
        /**
         * Halo de `good`, para lo que es un BUEN RESULTADO y quiere brillar (no
         * para interfaz: eso es `glow-acento`). Mismo alfa de siempre, con el
         * verde recalibrado de la paleta iris.
         */
        'glow-good': '0 6px 20px -6px rgba(52, 211, 154, 0.45)',
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
