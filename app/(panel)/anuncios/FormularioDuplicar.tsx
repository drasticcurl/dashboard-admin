'use client';

/**
 * FormularioDuplicar (task 23.4): cantidad de copias de 1 a 5 (default 1),
 * presupuesto opcional en EUR de 1,00 a 999.999,99 con 2 decimales, e inicio
 * opcional con el default de mañana a las 00:00 en la Zona_Cuenta (R11 c2).
 *
 * La validación de R18 c8 es del CLIENTE y deja el diálogo abierto con los
 * valores ingresados, señalando el campo inválido y el rango admitido; el
 * servidor revalida todo igual. El presupuesto se muestra con su destino:
 * campaña (CBO) o cada conjunto (ABO), según el `budget_level` del origen
 * (R18 c3, c7).
 */

import { mananaMedianocheLocal } from './zonaHoraria';

export function FormularioDuplicar({
  zona,
  copias,
  presupuesto,
  fecha,
  hora,
  destinoPresupuesto,
  onCopias,
  onPresupuesto,
  onFecha,
  onHora,
}: {
  zona: string;
  copias: number;
  /** Texto del input: sin valor = sin presupuesto. */
  presupuesto: string;
  fecha: string;
  hora: string;
  /** null = sin presupuesto pedido. */
  destinoPresupuesto: 'campaña (CBO)' | 'cada conjunto (ABO)' | 'mixto' | null;
  onCopias: (n: number) => void;
  onPresupuesto: (s: string) => void;
  onFecha: (f: string) => void;
  onHora: (h: string) => void;
}): JSX.Element {
  const n = Number(presupuesto);
  const presupuestoValido =
    presupuesto === '' ||
    (Number.isFinite(n) && n >= 1 && n <= 999999.99 && Number(n.toFixed(2)) === n);
  const copiasValido = Number.isInteger(copias) && copias >= 1 && copias <= 5;
  const fechaValida = /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !Number.isNaN(Date.parse(`${fecha}T00:00:00Z`));
  const horaValida = /^\d{2}:\d{2}$/.test(hora);

  return (
    <div className="space-y-2 text-sm text-neutral-300">
      <label className="flex items-center gap-2">
        <span>Copias por objeto (1 a 5):</span>
        <input
          type="number"
          min={1}
          max={5}
          step={1}
          value={String(copias)}
          onChange={(e) => onCopias(Math.max(1, Math.min(5, Math.floor(Number(e.target.value) || 1))))}
          className={`w-16 rounded border bg-overlay/4 px-2 py-1 text-right text-neutral-100 focus:outline-none focus:ring-1 focus:ring-good-500/50 ${
            copiasValido ? 'border-border-strong' : 'border-bad-500/60'
          }`}
          aria-label="Cantidad de copias por objeto"
          aria-invalid={!copiasValido}
        />
        {!copiasValido && <span className="text-xs text-bad-300">de 1 a 5</span>}
      </label>

      <label className="flex items-center gap-2">
        <span>Presupuesto diario (EUR, opcional):</span>
        <input
          type="number"
          min={1}
          max={999999.99}
          step={0.01}
          value={presupuesto}
          placeholder="sin presupuesto"
          onChange={(e) => onPresupuesto(e.target.value)}
          className={`w-28 rounded border bg-overlay/4 px-2 py-1 text-right text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-good-500/50 ${
            presupuestoValido ? 'border-border-strong' : 'border-bad-500/60'
          }`}
          aria-label="Presupuesto diario en EUR"
          aria-invalid={!presupuestoValido}
        />
        {!presupuestoValido && (
          <span className="text-xs text-bad-300">de 1,00 a 999.999,99 EUR con 2 decimales</span>
        )}
      </label>

      {presupuesto !== '' && destinoPresupuesto && (
        <p className="text-xs text-neutral-400">
          El presupuesto se aplica a: <span className="text-neutral-200">{destinoPresupuesto}</span>.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span>Inicio (en {zona}):</span>
        <input
          type="date"
          value={fecha}
          onChange={(e) => onFecha(e.target.value)}
          className={`rounded border bg-overlay/4 px-2 py-1 text-neutral-100 focus:outline-none focus:ring-1 focus:ring-good-500/50 ${
            fechaValida ? 'border-border-strong' : 'border-bad-500/60'
          }`}
          aria-label="Fecha de inicio"
          aria-invalid={!fechaValida}
        />
        <input
          type="time"
          value={hora}
          step={60}
          onChange={(e) => onHora(e.target.value || '00:00')}
          className={`rounded border bg-overlay/4 px-2 py-1 text-neutral-100 focus:outline-none focus:ring-1 focus:ring-good-500/50 ${
            horaValida ? 'border-border-strong' : 'border-bad-500/60'
          }`}
          aria-label="Hora de inicio"
          aria-invalid={!horaValida}
        />
        <button
          type="button"
          onClick={() => {
            onFecha(mananaMedianocheLocal(zona));
            onHora('00:00');
          }}
          className="rounded border border-border-strong px-2 py-1 text-xs text-neutral-300 hover:bg-overlay/6"
        >
          mañana 00:00
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        El valor se interpreta en la zona de la cuenta ({zona}). El inicio tiene que ser posterior al
        momento actual y no más de 6 meses después.
      </p>
    </div>
  );
}
