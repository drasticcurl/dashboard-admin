'use client';

/**
 * FormularioPresupuesto (task 20.3): un único importe en EUR de 0,01 al
 * Techo_Absoluto con 2 decimales, aplicable a todos los objetos de la
 * Seleccion_Activa (R13 c1). El valor entra como string para no perder los
 * decimales mientras se escribe.
 *
 * La regla de validez ya NO vive acá (task 3.2 de frescura-y-acciones-anuncios):
 * la trae `parsearPresupuesto`, la misma que usa el armado del payload y la
 * habilitación del botón Ejecutar. Mientras estuvo escrita a mano en este
 * archivo, el borde rojo del campo y el rechazo del Endpoint_Acciones eran dos
 * reglas distintas que podían discrepar (R1 c5).
 *
 * El campo además dice POR QUÉ un importe no sirve, en lugar de sólo pintarse de
 * rojo: el texto sale del `texto` del propio rechazo, el MISMO campo del MISMO
 * objeto que el diálogo muestra al lado del botón deshabilitado, así los dos
 * textos no pueden contradecirse (R1 c6, cláusula 3.6). Antes los dos llamaban a
 * `textoDeMotivo` por separado y la coherencia era una convención que había que
 * recordar.
 *
 * ─── POR QUÉ EL CAMPO NO ES `type="number"` (task 3.4 de parseo-montos-anuncios) ─
 *
 * Un `type="number"` se come la coma antes de que el parseo la vea, así que con
 * él la decisión de aceptar la coma decimal quedaba escrita y sin efecto. El
 * campo es de texto con `inputMode="decimal"`, que es el patrón que ya usan los
 * cuatro campos de importe de Reglas y los de Finanzas: mismo teclado numérico en
 * el celular, sin que el browser filtre el texto.
 *
 * Con eso se fueron también `min`, `max` y `step`, y NO se reemplazaron por nada:
 * `parsearPresupuesto` ya tiene los tres cortes equivalentes (`bajo_el_minimo` =
 * `min`, `sobre_el_techo` = `max`, `mas_de_dos_decimales` = `step`) y ya son los
 * que deciden este borde rojo y el bloqueo de Ejecutar. Lo único que el browser
 * aportaba encima era la flecha del spinner.
 */

import { useId } from 'react';
import { MINIMO_EUR, parsearPresupuesto } from '@/lib/ads/presupuesto';

/** Un importe en EUR con la coma decimal del resto del panel. */
function conComa(eur: number): string {
  return eur.toFixed(2).replace('.', ',');
}

export function FormularioPresupuesto({
  techoEur,
  valor,
  onValor,
}: {
  techoEur: number;
  valor: string;
  onValor: (texto: string) => void;
}): JSX.Element {
  const idAyuda = useId();
  const parseo = parsearPresupuesto(valor, techoEur);
  // El campo en blanco no se pinta de rojo: no está mal escrito, está sin
  // escribir. Ejecutar igual queda deshabilitado, pero eso lo declara el
  // `bloqueo` del diálogo, que sí mira el caso vacío.
  const invalido = valor !== '' && !parseo.ok;

  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-neutral-300">
      <span>Presupuesto diario para todos (EUR):</span>
      <input
        inputMode="decimal"
        value={valor}
        onChange={(e) => onValor(e.target.value)}
        className={`w-28 rounded border bg-overlay/4 px-2 py-1 text-right text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-good-500/50 ${
          invalido ? 'border-bad-500/60' : 'border-border-strong'
        }`}
        aria-label="Presupuesto diario en EUR"
        aria-invalid={invalido}
        aria-describedby={idAyuda}
      />
      <span id={idAyuda} className={`text-xs ${invalido ? 'text-bad-300' : 'text-neutral-500'}`}>
        {valor !== '' && !parseo.ok
          ? parseo.texto
          : `de ${conComa(MINIMO_EUR)} a ${conComa(techoEur)} EUR`}
      </span>
    </label>
  );
}
