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
 * rojo: el motivo sale de `textoDeMotivo`, el mismo catálogo que el diálogo usa
 * al lado del botón deshabilitado, así los dos textos no pueden contradecirse
 * (R1 c6).
 */

import { useId } from 'react';
import { MINIMO_EUR, parsearPresupuesto, textoDeMotivo } from '@/lib/ads/presupuesto';

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
        type="number"
        min={MINIMO_EUR}
        max={techoEur}
        step={0.01}
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
          ? textoDeMotivo(parseo.motivo)
          : `de ${conComa(MINIMO_EUR)} a ${conComa(techoEur)} EUR`}
      </span>
    </label>
  );
}
