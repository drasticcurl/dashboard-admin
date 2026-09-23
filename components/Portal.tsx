'use client';

/**
 * Portal — saca un overlay del árbol de la pantalla y lo cuelga del <body>.
 *
 * ── El bug que esto arregla (medido, no supuesto) ───────────────────────────
 *
 * Reportado como: «cuando toco cargar cuentas se ve la mitad del cuadrado y no
 * se puede bajar ni subir para ingresar los saldos, también pasa cuando le doy a
 * editar a un anuncio».
 *
 * Un `position: fixed` se posiciona contra el VIEWPORT, salvo que algún ancestro
 * tenga `transform`, `filter`, `backdrop-filter`, `perspective`, `will-change` o
 * `contain`: en ese caso se posiciona contra ESE ancestro. Y el panel tenía uno.
 *
 * `.reveal > *` (globals.css) anima la entrada de los bloques de cada pantalla
 * con `animation: rise-in 420ms ... both`. El `fill-mode: both` deja el ÚLTIMO
 * keyframe aplicado para siempre, y ese keyframe dice `transform: none`. El
 * comentario de `tailwind.config.ts` daba justamente eso por seguro:
 *
 *     «Termina en `transform: none` y NO en `translate3d(0,0,0)` [...] con
 *      `translate3d(0,0,0)` los modales del panel (que son `fixed inset-0`)
 *      quedarían encerrados dentro de la tarjeta. Con `none` no queda transform
 *      y no hay bloque contenedor.»
 *
 * **Eso es falso.** El valor COMPUTADO de un `transform: none` aplicado por una
 * animación con fill es `matrix(1, 0, 0, 1, 0, 0)`, no `none`. Y una matriz
 * identidad crea containing block igual: el navegador no distingue "identidad"
 * de "cualquier transform". Medido en el panel local a 390×844, el overlay del
 * modal —que es `fixed inset-0`— daba `top: 195` y `height: 1965` en lugar de
 * `top: 0, height: 844`: estaba midiendo contra el `<div class="space-y-4">` de
 * la pantalla, que es el hijo animado del `<main>`. De ahí el "se ve la mitad del
 * cuadrado": el modal aparecía a 195px del tope del DOCUMENTO y con el alto del
 * documento, no de la pantalla.
 *
 * ── Por qué un portal y no sólo arreglar la animación ───────────────────────
 *
 * La animación también se arregló (`fill-mode: backwards`, ver globals.css), y
 * con eso solo el síntoma desaparece. Pero el portal es lo que hace que no
 * vuelva: cualquiera que en el futuro le ponga un `filter`, un `backdrop-blur` o
 * un `will-change` a una tarjeta rompería todos los modales de la pantalla sin
 * relación aparente entre la causa y el efecto. Colgado del <body>, un overlay
 * no tiene ancestros que lo puedan capturar.
 *
 * `useEffect` + `montado`: `createPortal` necesita el DOM, que en el render del
 * servidor no existe. Devolver `null` en el primer render y el portal en el
 * segundo es el patrón estándar; el costo es un frame, y los overlays se montan
 * por una interacción, o sea que nunca están en el HTML inicial.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Portal({ children }: { children: ReactNode }): JSX.Element | null {
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);
  if (!montado) return null;
  return createPortal(children, document.body);
}
