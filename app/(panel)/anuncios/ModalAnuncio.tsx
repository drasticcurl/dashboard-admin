'use client';

/**
 * ModalAnuncio — el popup «Ver anuncio» del menú de la fila: el preview oficial
 * de Meta (el mismo que muestra el Administrador de anuncios), con el video
 * reproducible, el copy y el botón, sin salir del panel.
 *
 * El preview lo arma Meta en un iframe propio (`/{ad_id}/previews`). El panel
 * sólo pide el `src` a `/api/ads/preview` y lo monta: no inyecta HTML de afuera.
 *
 * La pestaña por defecto, «Creativo», NO es el iframe de Meta: es el video (o
 * la imagen), el copy y el botón dibujados por el panel. El iframe de Meta trae
 * adentro el cartel de cookies de Facebook y, al ser de otro origen, el panel
 * no lo puede esconder. Las pestañas de ubicación (Feed, Stories, Reels) siguen
 * siendo el iframe oficial para cuando se quiere ver el recorte exacto; si el
 * creativo no es apto para una, Meta devuelve error y se muestra el motivo.
 *
 * El link a Meta lleva sólo `act` y `selected_ad_ids`: el `business_id` y las
 * fechas del link que copia el Administrador son opcionales y Meta los completa.
 */

import { useEffect, useState } from 'react';
import { ArrowSquareOut, DownloadSimple } from '@phosphor-icons/react';
import { Modal } from '../finanzas/Modal';

const FORMATOS = [
  { clave: 'CREATIVO', rotulo: 'Creativo' },
  { clave: 'MOBILE_FEED_STANDARD', rotulo: 'Feed Facebook' },
  { clave: 'INSTAGRAM_STANDARD', rotulo: 'Feed Instagram' },
  { clave: 'INSTAGRAM_STORY', rotulo: 'Stories' },
  { clave: 'INSTAGRAM_REELS', rotulo: 'Reels' },
] as const;

type Formato = (typeof FORMATOS)[number]['clave'];

type Creativo = {
  tipo: 'video' | 'imagen' | 'desconocido';
  videoUrl: string | null;
  imagenUrl: string | null;
  texto: string | null;
  titulo: string | null;
  cta: string | null;
  link: string | null;
};

type Estado =
  | { tipo: 'cargando' }
  | { tipo: 'listo'; src: string }
  | { tipo: 'creativo'; creativo: Creativo }
  | { tipo: 'error'; detalle: string };

/** El link al anuncio en el Administrador de anuncios de Meta. */
export function linkAnuncioMeta(accountId: string, adId: string): string {
  const act = accountId.replace(/^act_/, '');
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit/standalone?act=${encodeURIComponent(act)}&selected_ad_ids=${encodeURIComponent(adId)}`;
}

/** El link que baja el video (o la imagen) del anuncio como archivo, vía /api/ads/descarga. */
export function urlDescarga(adId: string, accountId: string, nombre: string | null): string {
  const p = new URLSearchParams({ adId, accountId });
  if (nombre) p.set('nombre', nombre);
  return `/api/ads/descarga?${p.toString()}`;
}

export function ModalAnuncio({
  adId,
  accountId,
  nombre,
  onCerrar,
}: {
  adId: string;
  accountId: string;
  nombre: string | null;
  onCerrar: () => void;
}): JSX.Element {
  const [formato, setFormato] = useState<Formato>('CREATIVO');
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });

  useEffect(() => {
    const ctl = new AbortController();
    setEstado({ tipo: 'cargando' });
    fetch(
      `/api/ads/preview?adId=${encodeURIComponent(adId)}&accountId=${encodeURIComponent(accountId)}&formato=${formato}`,
      {
        signal: ctl.signal,
        cache: 'no-store',
      },
    )
      .then(async (r) => {
        const b = (await r.json().catch(() => null)) as
          | { ok: true; src?: string; creativo?: Creativo; detail?: undefined }
          | { ok: false; detail?: string }
          | null;
        if (b && b.ok && b.creativo) setEstado({ tipo: 'creativo', creativo: b.creativo });
        else if (b && b.ok && b.src) setEstado({ tipo: 'listo', src: b.src });
        else setEstado({ tipo: 'error', detalle: b?.detail ?? `HTTP ${r.status}` });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setEstado({ tipo: 'error', detalle: e instanceof Error ? e.message : 'no se pudo pedir el preview' });
      });
    return () => ctl.abort();
  }, [adId, accountId, formato]);

  return (
    <Modal
      titulo={nombre ?? '(sin nombre)'}
      descripcion="Preview oficial de Meta: así se ve el anuncio en cada ubicación."
      onCerrar={onCerrar}
      pie={
        <div className="flex justify-end gap-2">
          <a
            href={urlDescarga(adId, accountId, nombre)}
            className="tap press inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors duration-250 hover:bg-overlay/6 hover:text-neutral-50"
          >
            <DownloadSimple size={14} weight="bold" aria-hidden />
            Descargar
          </a>
          <a
            href={linkAnuncioMeta(accountId, adId)}
            target="_blank"
            rel="noopener noreferrer"
            className="tap press inline-flex items-center gap-1.5 rounded-md bg-gradient-to-b from-acento-400 to-acento-500 px-3 py-1.5 text-xs font-semibold text-canvas shadow-glow-acento transition-[filter] duration-250 hover:brightness-110"
          >
            <ArrowSquareOut size={14} weight="bold" aria-hidden />
            Abrir en Meta
          </a>
        </div>
      }
    >
      <div
        role="group"
        aria-label="Ubicación del preview"
        className="mb-4 flex flex-wrap gap-0.5 rounded-md bg-canvas/60 p-0.5"
      >
        {FORMATOS.map((f) => (
          <button
            key={f.clave}
            type="button"
            onClick={() => setFormato(f.clave)}
            aria-pressed={formato === f.clave}
            className={`flex-1 whitespace-nowrap rounded px-2 py-1.5 text-xs transition-colors duration-250 ${
              formato === f.clave
                ? 'bg-acento-900 font-medium text-acento-100'
                : 'text-neutral-400 hover:text-neutral-100'
            }`}
          >
            {f.rotulo}
          </button>
        ))}
      </div>

      {/* Alto fijo mientras carga para que el modal no salte al llegar el
          iframe. El iframe de Meta mide 540×690 en feed y más en stories. */}
      <div className="flex min-h-[560px] items-start justify-center">
        {estado.tipo === 'cargando' && (
          <p className="pt-24 text-sm text-neutral-500" aria-live="polite">
            Pidiendo el preview a Meta…
          </p>
        )}
        {estado.tipo === 'error' && (
          <div className="max-w-sm pt-20 text-center" aria-live="polite">
            <p className="text-sm text-warn-300">
              {formato === 'CREATIVO' ? 'No se pudo traer el creativo.' : 'No hay preview para esta ubicación.'}
            </p>
            <p className="mt-1.5 text-xs text-neutral-500">{estado.detalle}</p>
          </div>
        )}
        {estado.tipo === 'creativo' && <VistaCreativo c={estado.creativo} />}
        {estado.tipo === 'listo' && (
          <iframe
            key={estado.src}
            src={estado.src}
            title={`Preview de ${nombre ?? adId}`}
            className="h-[720px] w-full max-w-[540px] rounded-lg border-0 bg-white"
            // Meta necesita scripts y su propio origen para reproducir el video.
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          />
        )}
      </div>
    </Modal>
  );
}

/** El rótulo del botón de Meta a partir del `call_to_action_type`. */
const CTA_TEXTO: Record<string, string> = {
  LEARN_MORE: 'Más información',
  SHOP_NOW: 'Comprar',
  SIGN_UP: 'Registrarte',
  SEE_DETAILS: 'Ver detalles',
  GET_OFFER: 'Obtener oferta',
  ORDER_NOW: 'Pedir ahora',
  BUY_NOW: 'Comprar ahora',
  SUBSCRIBE: 'Suscribirte',
  DOWNLOAD: 'Descargar',
  CONTACT_US: 'Contactarnos',
  APPLY_NOW: 'Postularte',
  BOOK_TRAVEL: 'Reservar',
  WATCH_MORE: 'Ver más',
  SEND_MESSAGE: 'Enviar mensaje',
  GET_QUOTE: 'Pedir presupuesto',
  NO_BUTTON: '',
};

/**
 * El creativo dibujado por el panel: el video con controles (o la imagen)
 * arriba, y debajo el título, el botón y el copy completo. No imita el marco
 * de Facebook a propósito: lo que se viene a mirar es el creativo y el texto.
 */
function VistaCreativo({ c }: { c: Creativo }): JSX.Element {
  const cta = c.cta ? (CTA_TEXTO[c.cta] ?? c.cta.replace(/_/g, ' ').toLowerCase()) : '';
  return (
    <div className="w-full max-w-[460px] space-y-3">
      <div className="overflow-hidden rounded-lg bg-black">
        {c.videoUrl ? (
          <video
            key={c.videoUrl}
            src={c.videoUrl}
            poster={c.imagenUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
            className="max-h-[62dvh] w-full object-contain"
          />
        ) : c.imagenUrl ? (
          <img src={c.imagenUrl} alt="" className="max-h-[62dvh] w-full object-contain" />
        ) : (
          <p className="p-8 text-center text-sm text-neutral-500">Meta no devolvió el video ni la imagen.</p>
        )}
      </div>
      {c.tipo === 'video' && !c.videoUrl && (
        <p className="text-xs text-warn-300">
          El video no se puede leer con el token del panel: se muestra la miniatura. Abrilo en Meta para verlo.
        </p>
      )}
      {(c.titulo || cta) && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-overlay/2 px-3 py-2.5">
          <div className="min-w-0">
            {c.link && <p className="truncate text-[11px] uppercase text-neutral-500">{hostDe(c.link)}</p>}
            {c.titulo && <p className="break-words text-sm font-semibold text-neutral-100">{c.titulo}</p>}
          </div>
          {cta &&
            (c.link ? (
              <a
                href={c.link}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-md bg-overlay/8 px-3 py-1.5 text-xs font-semibold text-neutral-100 hover:bg-overlay/12"
              >
                {cta}
              </a>
            ) : (
              <span className="shrink-0 rounded-md bg-overlay/8 px-3 py-1.5 text-xs font-semibold text-neutral-100">
                {cta}
              </span>
            ))}
        </div>
      )}
      {c.texto && <p className="whitespace-pre-line break-words text-sm leading-relaxed text-neutral-300">{c.texto}</p>}
    </div>
  );
}

function hostDe(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return link;
  }
}
