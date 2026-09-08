'use client';

/**
 * El panel de análisis con IA. Lo usan el widget del Resumen y la tarjeta de
 * Finanzas.
 *
 * ─── NO PIDE EL ANALISIS AL MONTAR ─────────────────────────────────────────
 * Recibe el insight guardado por prop (viaja en `OverviewData.insight` y en la
 * página de Finanzas) y lo muestra. Generar es una acción EXPLICITA del usuario o
 * del cron. Es toda la razón por la que este módulo no se come el crédito: el
 * Resumen repite su pedido cada minuto, y si el análisis se generara al renderizar
 * serían ~1.440 llamadas por día por pestaña abierta.
 *
 * ─── EL BOTON NO REFETCHEA LA PANTALLA ─────────────────────────────────────
 * El POST devuelve el insight generado y se guarda en estado local. Así el widget
 * sigue respetando la regla 2 de `lib/widgets/tipos.ts` (los DATOS entran por
 * parámetro, nunca los pide el widget) y además no arrastra un refetch del
 * overview entero —que en el Resumen desmontaría el grid y tiraría las ediciones
 * de layout sin guardar, el mismo problema que documenta `cargar()` en
 * ResumenView.
 *
 * ─── APRETARLO DOS VECES NO PAGA DOS VECES ─────────────────────────────────
 * El route cachea por huella del contenido: si los números no cambiaron, devuelve
 * lo que ya estaba sin llamar a OpenAI. Se ve en `deCache`.
 */

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Sparkle } from '@phosphor-icons/react';
import { Banner, EmptyState, Spinner, fmtDateTime } from '@/components/ui';
import type { AmbitoInsight, InsightGuardado } from '@/lib/ia/insights';

type Respuesta = { ok: true; insight: InsightGuardado } | { ok: false; error: string; detail?: string };

/** Los mensajes de error del route traducidos. El texto crudo no le dice nada al usuario. */
const MENSAJES: Record<string, string> = {
  ia_apagada: 'El análisis con IA no está configurado en esta instancia.',
  limite_diario: 'Se alcanzó el techo de análisis por hoy. Vuelve a estar disponible mañana.',
  timeout: 'El modelo tardó demasiado en contestar. Probá de nuevo.',
  unauthorized: 'Se venció la sesión. Recargá la página para volver a entrar.',
};

export function PanelInsight({
  inicial,
  ambito,
}: {
  inicial: InsightGuardado | null;
  ambito: AmbitoInsight;
}): JSX.Element {
  const searchParams = useSearchParams();
  const [actual, setActual] = useState<InsightGuardado | null>(inicial);
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analizar(): Promise<void> {
    setGenerando(true);
    setError(null);
    try {
      // El rango va igual que en /api/data/overview: el análisis tiene que hablar
      // del período que el usuario está mirando. Finanzas no manda rango — su
      // pantalla ignora el RangePicker a propósito (el patrimonio es una foto, no
      // un agregado), así que el server resuelve los meses.
      const params = new URLSearchParams({ ambito });
      if (ambito === 'resumen') {
        const from = searchParams.get('from');
        const to = searchParams.get('to');
        if (from && to) {
          params.set('from', from);
          params.set('to', to);
        } else {
          params.set('range', searchParams.get('range') ?? 'today');
        }
      }

      const res = await fetch(`/api/ia/insight?${params.toString()}`, {
        method: 'POST',
        cache: 'no-store',
      });

      // El cuerpo se lee SIEMPRE, también en un 4xx: ahí viene el motivo, y sin
      // leerlo el usuario ve "HTTP 429" en vez de "se alcanzó el techo de hoy".
      const body = (await res.json().catch(() => null)) as Respuesta | null;

      if (!res.ok || !body || body.ok !== true) {
        const clave = body && body.ok === false ? body.error : '';
        setError(
          MENSAJES[clave] ??
            (body && body.ok === false && body.detail ? body.detail : `No se pudo analizar (HTTP ${res.status}).`),
        );
        return;
      }

      setActual(body.insight);
    } catch {
      // Un fetch que tira es red, no la API: el mensaje tiene que decir eso y no
      // culpar al modelo.
      setError('No se pudo contactar al panel. Revisá la conexión.');
    } finally {
      setGenerando(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-neutral-500">
          {actual
            ? `Generado ${fmtDateTime(actual.generadoEn)}`
            : 'Todavía no se generó ningún análisis'}
        </span>
        <button
          type="button"
          onClick={analizar}
          disabled={generando}
          aria-busy={generando}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 text-xs font-semibold text-neutral-200 transition-colors hover:bg-overlay/6 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {generando ? <Spinner /> : <Sparkle size={13} weight="bold" aria-hidden />}
          {generando ? 'Analizando…' : actual ? 'Volver a analizar' : 'Analizar'}
        </button>
      </div>

      {error && (
        <Banner tone="bad" title="No se pudo analizar">
          {error}
        </Banner>
      )}

      {/* aria-live: el resultado aparece sin que el foco se mueva, así que un
          lector de pantalla no lo anunciaría solo. `polite` y no `assertive`
          porque no interrumpe nada urgente. */}
      <div aria-live="polite" className="flex flex-1 flex-col gap-2">
        {!actual && !generando && (
          <EmptyState
            title="Sin análisis todavía"
            hint="El cron genera uno por día sobre los días cerrados. Con el botón lo pedís para el período que estás viendo."
          />
        )}

        {actual?.insights.length === 0 && (
          <Banner tone="info">
            El modelo no encontró nada para señalar con los datos de este período.
          </Banner>
        )}

        {actual?.insights.map((ins, i) => (
          <Banner key={`${i}-${ins.titulo}`} tone={ins.tono} title={ins.titulo}>
            {ins.cuerpo}
            {ins.evidencia.length > 0 && (
              /* La evidencia se muestra y no se esconde: es lo que hace el
                 análisis verificable de un vistazo. Cada cita se validó contra el
                 brief antes de guardarse (ver validarEvidencia), así que estos
                 números salieron del panel y no del modelo. */
              <span className="mt-2 flex flex-wrap gap-1.5">
                {ins.evidencia.map((ev, j) => (
                  <span
                    key={`${j}-${ev.metrica}`}
                    className="rounded border border-border-subtle bg-overlay/4 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-neutral-400"
                    title={ev.metrica}
                  >
                    {ev.metrica}: {ev.valor}
                  </span>
                ))}
              </span>
            )}
          </Banner>
        ))}
      </div>

      {actual && (
        <p className="text-[11px] text-neutral-600">
          {actual.rango.desde === actual.rango.hasta
            ? actual.rango.desde
            : `${actual.rango.desde} → ${actual.rango.hasta}`}{' '}
          · {actual.modelo}
          {actual.deCache && ' · sin cambios desde el último análisis'}
        </p>
      )}
    </div>
  );
}
