// Lo monta T06 en FinanzasView.tsx. Hasta entonces nadie lo importa, a propósito.
'use client';

/**
 * GraficoSaldo — el gráfico de saldo con el toggle Diario / Mensual
 * (plan `tasks/saldo-cuentas/00-PLAN-SALDO.md` §5, T04 §2).
 *
 * LAS DOS VISTAS MUESTRAN COSAS DISTINTAS, Y ESO ES EL PUNTO:
 *
 *   · **Diario (este mes)** dibuja el PATRIMONIO de cada día. Es un NIVEL:
 *     cuánta plata hay.
 *   · **Mensual** dibuja la GANANCIA de cada mes (Δ patrimonio − retiros −
 *     aportes, D7). Es un FLUJO: cuánto generó el negocio.
 *
 * O sea que el eje Y cambia de significado al tocar el toggle. Por eso el título
 * de la card y la línea de arriba del gráfico dicen cuál está activa: que el
 * botón esté resaltado no alcanza para explicar que el 9.000 de una vista y el
 * 700 de la otra no son la misma unidad.
 *
 * Arranca en **Diario** (P-04): la vista mensual necesita DOS meses cerrados
 * para tener un solo punto, así que durante el primer mes de vida del módulo
 * está vacía por definición.
 *
 * Recibe las dos series ya cargadas por props y NO hace fetch: el toggle no
 * vuelve a pedir nada, el componente es puro y T06 decide cuándo refrescar.
 *
 * Los tipos entran con `import type`: `lib/queries/saldo.ts` importa `pg`, y un
 * import de valor arrastraría el driver de Postgres al bundle del browser.
 */

import { useId, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { panelColors } from '@/tailwind.config';
import { Card, ChartFrame, EmptyState, fmtAxis, fmtMoney } from '@/components/ui';
import type { PuntoDiario, PuntoMensual } from '@/lib/queries/saldo';
import { etiquetaDia, etiquetaMes, offsetDelCero, textoSinDato } from './serie';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';

type Vista = 'diario' | 'mensual';

/**
 * La fila que consume recharts. `valor` es `number | null` y NUNCA 0 para un
 * punto sin dato (D12): un patrimonio de 0 es un dato real y dramático, y
 * taparlo con 0 lo vuelve indistinguible de "no cargué".
 *
 * `punto` viaja entero para que el tooltip pueda explicar de dónde sale el
 * número —el cierre del mes, los retiros, los aportes— sin recalcular nada.
 */
type Fila =
  | { etiqueta: string; valor: number | null; vista: 'diario'; punto: PuntoDiario }
  | { etiqueta: string; valor: number | null; vista: 'mensual'; punto: PuntoMensual };

/**
 * El tooltip propio. El `ChartTip` compartido de `components/ui.tsx` formatea
 * con `fmtInt` y esto es plata, así que va `fmtMoney(v, MONEDA_REPORTE)`.
 *
 * `ChartFrame` inyecta el tooltip compartido sólo si el chart no trae uno
 * (`injectSharedTooltip`, vía `cloneElement`): como acá se pasa este, no lo pisa.
 */
function SaldoTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Fila }>;
}): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const fila = payload[0]!.payload;

  return (
    <div className="rounded-xl border border-border-strong bg-surface-overlay/95 px-3 py-2 text-xs shadow-float backdrop-blur-sm">
      {fila.vista === 'diario' ? (
        <>
          {/* La fecha se arma cortando el string y no con `fmtDate`: ese pasa
              por `new Date('2026-08-05')`, que es medianoche UTC, y en una TZ al
              oeste de Greenwich el tooltip mostraría el día ANTERIOR al del
              dato. En un gráfico cuyo único trabajo es decir de qué día es cada
              número, eso no se puede. */}
          <p className="mb-1.5 font-semibold text-neutral-100">
            {etiquetaDia(fila.punto.day)}/{fila.punto.day.slice(0, 4)}
          </p>
          {fila.punto.totalEur === null ? (
            <>
              <p className="text-neutral-400">{textoSinDato()}</p>
              <p className="mt-1 max-w-[32ch] text-pretty leading-relaxed text-neutral-500">
                ese día no está cargado el saldo de todas las cuentas, así que no hay patrimonio
                que mostrar — un total al que le falta una cuenta sería un número equivocado
              </p>
            </>
          ) : (
            <p className="font-mono tabular-nums text-neutral-100">
              <span className="mr-1.5 font-sans text-neutral-400">Patrimonio</span>
              {fmtMoney(fila.punto.totalEur, MONEDA_REPORTE)}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mb-1.5 font-semibold text-neutral-100">{etiquetaMes(fila.punto.month)}</p>
          {fila.punto.gananciaEur === null ? (
            <>
              <p className="text-neutral-400">{textoSinDato()}</p>
              <p className="mt-1 max-w-[32ch] text-pretty leading-relaxed text-neutral-500">
                falta el cierre de este mes o del anterior: sin los dos no hay diferencia que
                medir, y tratar el saldo inicial como ganancia inventaría plata que nunca se ganó
              </p>
            </>
          ) : (
            <>
              <p className="font-mono tabular-nums text-neutral-100">
                <span className="mr-1.5 font-sans text-neutral-400">Ganancia</span>
                {fmtMoney(fila.punto.gananciaEur, MONEDA_REPORTE)}
              </p>
              {/* De dónde sale ese número. Es la fila que evita la pregunta
                  "¿por qué dice 700 si el patrimonio subió 3.500?" (D7). */}
              {fila.punto.cierreEur !== null && (
                <p className="mt-1 font-mono tabular-nums text-neutral-400">
                  <span className="mr-1.5 font-sans">Cierre</span>
                  {fmtMoney(fila.punto.cierreEur, MONEDA_REPORTE)}
                  {fila.punto.diaCierre !== null && (
                    <span className="ml-1 font-sans text-neutral-500">
                      (el {etiquetaDia(fila.punto.diaCierre)})
                    </span>
                  )}
                </p>
              )}
              {fila.punto.retirosEur !== 0 && (
                <p className="font-mono tabular-nums text-neutral-400">
                  <span className="mr-1.5 font-sans">Retiros</span>
                  {fmtMoney(fila.punto.retirosEur, MONEDA_REPORTE)}
                  <span className="ml-1 font-sans text-neutral-500">(no son pérdida)</span>
                </p>
              )}
              {fila.punto.aportesEur !== 0 && (
                <p className="font-mono tabular-nums text-neutral-400">
                  <span className="mr-1.5 font-sans">Aportes</span>
                  {fmtMoney(fila.punto.aportesEur, MONEDA_REPORTE)}
                  <span className="ml-1 font-sans text-neutral-500">(no son ganancia)</span>
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** El copy de cada vista, en un solo lugar para que título y subtítulo no se separen. */
const COPY: Record<Vista, { boton: string; titulo: string; unidad: string; hint: string }> = {
  diario: {
    boton: 'Diario (este mes)',
    titulo: 'Patrimonio · día por día (este mes)',
    unidad: 'El eje mide CUÁNTA PLATA HAY, día por día.',
    hint: 'El patrimonio medido: la suma de los saldos que cargaste, con la deuda restada. Un día sin cargar no se dibuja y el tooltip dice "sin información" — nunca se muestra en 0.',
  },
  mensual: {
    boton: 'Mensual',
    titulo: 'Ganancia · mes por mes (últimos meses)',
    unidad: 'El eje mide CUÁNTO GENERÓ EL NEGOCIO en cada mes.',
    hint: 'La ganancia es cuánto cambió el patrimonio, descontando los retiros y los aportes: sacar o meter plata propia no es ni ganancia ni pérdida del negocio.',
  },
};

export function GraficoSaldo({
  diario,
  mensual,
}: {
  /** `serieDiaria(mesActual)`: del 1 del mes a hoy, continuo. */
  diario: PuntoDiario[];
  /** `serieMensual(12)`. */
  mensual: PuntoMensual[];
}): JSX.Element {
  // Arranca en Diario: es la única vista con datos desde el primer día (P-04).
  const [vista, setVista] = useState<Vista>('diario');

  // Un id por instancia para los degradados: dos <linearGradient> con el mismo
  // id en el documento hacen que el segundo gráfico se pinte con el primero.
  // Los `:` que trae useId no se pueden dejar dentro de un url(#…).
  const gradId = `saldo-${useId().replace(/:/g, '')}-${vista}`;

  const filas: Fila[] =
    vista === 'diario'
      ? diario.map((p) => ({
          etiqueta: etiquetaDia(p.day),
          valor: p.totalEur,
          vista: 'diario',
          punto: p,
        }))
      : mensual.map((p) => ({
          etiqueta: etiquetaMes(p.month),
          valor: p.gananciaEur,
          vista: 'mensual',
          punto: p,
        }));

  const valores = filas.map((f) => f.valor);
  const hayDato = valores.some((v) => v !== null);
  const hayNegativo = valores.some((v) => v !== null && v < 0);
  const offset = offsetDelCero(valores);

  const copy = COPY[vista];

  return (
    <Card title={copy.titulo} hint={copy.hint}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {/* La unidad, escrita. El eje Y quiere decir dos cosas distintas según
            el toggle, y un botón resaltado no explica cuál. */}
        <p className="max-w-[52ch] text-pretty text-xs leading-relaxed text-neutral-400">
          {copy.unidad}
        </p>

        {/*
          El mismo control segmentado que el toggle de base de Embudo y que las
          tabs del Nav: canal hundido, opción activa como pastilla elevada. Se
          copia en lugar de inventar otro para que dos controles idénticos del
          panel no se vean distintos.
        */}
        <div
          role="group"
          aria-label="Unidad del gráfico de saldo"
          className="flex shrink-0 items-center gap-0.5 rounded-xl bg-canvas/70 p-1 shadow-[inset_0_1px_2px_0_rgba(4,6,14,0.6),inset_0_0_0_1px_rgba(255,255,255,0.05)]"
        >
          {(['diario', 'mensual'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setVista(v)}
              aria-pressed={vista === v}
              className={`press rounded-lg px-3 py-1.5 text-sm transition-[background-color,color,box-shadow] duration-250 ${
                vista === v
                  ? 'bg-surface-raised font-semibold text-neutral-50 shadow-lozenge'
                  : 'font-medium text-neutral-400 hover:bg-overlay/7 hover:text-neutral-100'
              }`}
            >
              {COPY[v].boton}
            </button>
          ))}
        </div>
      </div>

      {!hayDato ? (
        // Un gráfico en blanco sin explicación es el peor resultado posible: no
        // se distingue de un gráfico que no terminó de cargar (P-04).
        <EmptyState
          title={
            vista === 'mensual'
              ? 'Todavía no hay dos meses cerrados para comparar'
              : 'Todavía no hay ningún día completo de este mes'
          }
          hint={
            vista === 'mensual'
              ? 'La ganancia de un mes es la diferencia contra el cierre del mes anterior, así que el primer mes del módulo nunca la tiene. Con dos meses cerrados aparece el primer punto.'
              : 'Un día entra al gráfico cuando tiene cargado el saldo de TODAS las cuentas vigentes. Cargá los saldos de hoy y el primer punto aparece acá.'
          }
        />
      ) : (
        <ChartFrame alto="md">
          <AreaChart data={filas} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {/*
                Un <Area> tiene UN solo fill, así que la única forma de que un
                mes en pérdida se vea distinto de un mes en ganancia es partir el
                degradado en el cero. `offsetDelCero` calcula dónde cae; es
                aproximado porque el dominio del eje va en 'auto' y ese auto
                redondea a números lindos. El cero EXACTO lo marca la
                ReferenceLine de abajo.
              */}
              <linearGradient id={`fill-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={0} stopColor={panelColors.good} stopOpacity={0.28} />
                <stop offset={offset} stopColor={panelColors.good} stopOpacity={0.04} />
                <stop offset={offset} stopColor={panelColors.bad} stopOpacity={0.04} />
                <stop offset={1} stopColor={panelColors.bad} stopOpacity={0.28} />
              </linearGradient>
              <linearGradient id={`stroke-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={offset} stopColor={panelColors.good} />
                <stop offset={offset} stopColor={panelColors.bad} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke={panelColors.grid} vertical={false} />
            <XAxis
              dataKey="etiqueta"
              tick={{ fontSize: 11, fill: panelColors.axis }}
              tickLine={false}
              axisLine={{ stroke: panelColors.axisLine }}
              minTickGap={16}
            />
            <YAxis
              tickFormatter={fmtAxis}
              tick={{ fontSize: 11, fill: panelColors.axis }}
              tickLine={false}
              axisLine={false}
              width={56}
              /* Ajustado al rango, NO anclado en cero: un patrimonio que se
                 mueve entre 8.000 y 8.400 con el eje desde cero se ve como una
                 recta. El costo es que exagera los movimientos chicos, y es el
                 tradeoff que el usuario eligió (plan §5). */
              domain={['auto', 'auto']}
            />
            <Tooltip content={<SaldoTooltip />} cursor={{ stroke: panelColors.axisLine }} />
            {/* Sin la línea del cero, un gráfico con valores negativos no se
                lee. Sólo cuando hay alguno: con todo positivo y dominio 'auto',
                el cero queda fuera del rango y la línea no diría nada. */}
            {hayNegativo && <ReferenceLine y={0} stroke={panelColors.axisLine} strokeDasharray="3 3" />}
            <Area
              type="monotone"
              dataKey="valor"
              name={vista === 'diario' ? 'Patrimonio' : 'Ganancia'}
              stroke={`url(#stroke-${gradId})`}
              strokeWidth={2}
              fill={`url(#fill-${gradId})`}
              /*
                connectNulls PRENDIDO (D12). Sin esto, un mes donde el usuario
                cargó el día 5 y el día 25 no dibuja NADA: recharts necesita dos
                puntos ADYACENTES para trazar un segmento, así que dos puntos
                aislados quedan sin área y el gráfico se ve roto en vez de
                escaso.
              */
              connectNulls
              /* Y el dot es lo que salva a connectNulls de mentir: con la línea
                 sola no se distingue un día medido de la interpolación entre dos
                 días medidos. Los puntos son los datos; la línea sólo los une. */
              dot={{ r: 2, strokeWidth: 0, fill: panelColors.inkOnDark }}
              activeDot={{ r: 4, strokeWidth: 0 }}
              /* Sin animación: el área se redibuja en cada toggle y animarla
                 desde cero muestra medio segundo de una forma que no es el dato. */
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartFrame>
      )}
    </Card>
  );
}
