'use client';

/**
 * FormularioProgramar (task 26.2): el inicio programado de los conjuntos
 * seleccionados. Default mañana a las 00:00 en la Zona_Cuenta (R11 c2), edición
 * con granularidad de un minuto y segundos fijos en 00, rango desde el minuto
 * siguiente al momento actual hasta 365 días después. En el MISMO control, sin
 * interacción adicional, se muestra el nombre de la Zona_Cuenta y su
 * desplazamiento horario vigente para la fecha y hora elegidas, e indica que el
 * valor se interpreta en esa zona (R11 c3).
 *
 * La BarraSeleccion sólo ofrece esta acción con Nivel_Activo `adset` y 1..100
 * objetos seleccionados (R11 c1), así que este formulario asume ese contexto.
 */

import { mananaMedianocheLocal } from './zonaHoraria';

function offsetDe(zona: string, fecha: string, hora: string): string {
  const comoUTC = Date.parse(`${fecha}T${hora}:00Z`);
  if (Number.isNaN(comoUTC)) return '±00:00';
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(comoUTC));
  const mapa = new Map(partes.map((p) => [p.type, p.value]));
  const pared = Date.UTC(
    Number(mapa.get('year')),
    Number(mapa.get('month')) - 1,
    Number(mapa.get('day')),
    Number(mapa.get('hour')),
    Number(mapa.get('minute')),
  );
  const minutos = Math.round((pared - comoUTC) / 60_000);
  const signo = minutos < 0 ? '-' : '+';
  const abs = Math.abs(minutos);
  return `${signo}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function FormularioProgramar({
  zona,
  fecha,
  hora,
  onFecha,
  onHora,
}: {
  zona: string;
  fecha: string;
  hora: string;
  onFecha: (f: string) => void;
  onHora: (h: string) => void;
}): JSX.Element {
  const inputCls =
    'rounded border border-border-strong bg-overlay/4 px-2 py-1 text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-good-500/50';
  const fechaValida = /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !Number.isNaN(Date.parse(`${fecha}T00:00:00Z`));
  const horaValida = /^\d{2}:\d{2}$/.test(hora);

  return (
    <div className="space-y-2 text-sm text-neutral-300">
      <div className="flex flex-wrap items-center gap-2">
        <span>Inicio:</span>
        <input
          type="date"
          value={fecha}
          onChange={(e) => onFecha(e.target.value)}
          className={`${inputCls} ${fechaValida ? '' : 'border-bad-500/60'}`}
          aria-label="Fecha de inicio"
          aria-invalid={!fechaValida}
        />
        <input
          type="time"
          value={hora}
          step={60}
          onChange={(e) => onHora(e.target.value || '00:00')}
          className={`${inputCls} ${horaValida ? '' : 'border-bad-500/60'}`}
          aria-label="Hora de inicio"
          aria-invalid={!horaValida}
        />
        <span className="text-xs text-neutral-500">(segundos fijos en 00)</span>
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
      <p className="text-xs text-neutral-400">
        El valor se interpreta en la zona horaria de la cuenta:{' '}
        <span className="font-semibold text-neutral-200">{zona}</span> (desplazamiento vigente para la
        fecha y hora elegidas: <span className="tabular-nums">{offsetDe(zona, fecha, hora)}</span>).
        Acepta desde el minuto siguiente al momento actual en esa zona hasta 365 días después.
      </p>
    </div>
  );
}
