/**
 * Nombre de marca del panel, en un solo lugar.
 *
 * POR QUE ES UNA ENV VAR Y NO UNA CONSTANTE
 * Este repo lo comparten VARIAS instancias del panel: cada proyecto tiene su
 * propio clon, su propia base de datos, su propio dominio y su propio
 * `.env.production`, pero todas deployan desde el mismo `origin/main`. El
 * deploy hace `git reset --hard`, así que un nombre hardcodeado no se puede
 * "arreglar a mano" en una instancia: el próximo deploy lo revierte.
 *
 * Con esto, agregar un panel nuevo es poner una línea en su env y no tocar
 * código, y ninguna instancia puede quedar mostrando el nombre de otra.
 *
 * EL DEFAULT ES 'Hilvan' A PROPOSITO
 * Es el valor que el panel original ya venía mostrando. Un default vacío o
 * genérico le cambiaría el nombre a esa instancia en su siguiente deploy sin
 * que nadie lo haya pedido; así, la que no define la variable sigue igual y la
 * que sí la define es la que cambia.
 *
 * NO es `NEXT_PUBLIC_`: los dos lugares que lo usan (el `metadata` del layout
 * raíz y el header de `(panel)/layout.tsx`) son server components, así que no
 * hace falta exponerlo al bundle del browser.
 *
 * Cambiarla requiere un deploy: el `metadata` de Next se evalúa cuando el
 * módulo carga, y la página de login es estática.
 */
export const PANEL_BRAND = process.env.PANEL_BRAND?.trim() || 'Hilvan';

/** Título que va en la pestaña del navegador y en el header. */
export const PANEL_TITLE = `Panel · ${PANEL_BRAND}`;
