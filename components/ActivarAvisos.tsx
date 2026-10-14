'use client';

/**
 * Campanita del pie del sidebar: activa / desactiva los avisos push (cada venta y el profit).
 *
 * Registra el service worker (`/public/sw.js`) al montar y, al tocar, pide el
 * permiso del navegador, se suscribe con la clave pública VAPID que da
 * `GET /api/push` y manda la suscripción a `POST /api/push`.
 *
 * Se esconde sola cuando no tiene sentido mostrarla:
 *  · la instancia no tiene claves VAPID (`configurado: false`);
 *  · el usuario no ve el Resumen (el GET devuelve 403).
 * En un iPhone fuera de la app instalada el navegador no tiene `PushManager`:
 * ahí la campanita queda, pero al tocarla explica que hay que agregar el panel a
 * la pantalla de inicio, que es lo único que habilita push en iOS.
 */

import { useEffect, useState } from 'react';

type Estado = 'cargando' | 'oculto' | 'sin_soporte' | 'bloqueado' | 'apagado' | 'prendido' | 'trabajando';

function claveABytes(base64: string): Uint8Array<ArrayBuffer> {
  const relleno = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + relleno).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function ActivarAvisos(): JSX.Element | null {
  const [estado, setEstado] = useState<Estado>('cargando');
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [nota, setNota] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const r = await fetch('/api/push').catch(() => null);
      if (!r || !r.ok) return vivo && setEstado('oculto');
      const data = (await r.json()) as { configurado: boolean; publicKey: string | null };
      if (!data.configurado || !data.publicKey) return vivo && setEstado('oculto');
      if (!vivo) return;
      setPublicKey(data.publicKey);

      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        return setEstado('sin_soporte');
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      const sub = await reg.pushManager.getSubscription();
      if (!vivo) return;
      if (Notification.permission === 'denied') return setEstado('bloqueado');
      setEstado(sub ? 'prendido' : 'apagado');
    })().catch(() => vivo && setEstado('oculto'));
    return () => {
      vivo = false;
    };
  }, []);

  // La nota es un aviso de paso, no un estado: se va sola.
  useEffect(() => {
    if (!nota) return;
    const t = setTimeout(() => setNota(null), 6000);
    return () => clearTimeout(t);
  }, [nota]);

  async function alternar(): Promise<void> {
    setNota(null);
    if (estado === 'sin_soporte') {
      setNota('En iPhone: Compartir → «Agregar a inicio» y abrí el panel desde ese ícono.');
      return;
    }
    if (estado === 'bloqueado') {
      setNota('Los avisos están bloqueados en los ajustes del navegador para este sitio.');
      return;
    }
    if (!publicKey) return;
    const previo = estado;
    setEstado('trabajando');
    try {
      const reg = await navigator.serviceWorker.ready;
      if (previo === 'prendido') {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch('/api/push', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
          await sub.unsubscribe();
        }
        setEstado('apagado');
        return;
      }

      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') {
        setEstado(permiso === 'denied' ? 'bloqueado' : 'apagado');
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: claveABytes(publicKey),
      });
      const r = await fetch('/api/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!r.ok) throw new Error(`POST /api/push ${r.status}`);
      setEstado('prendido');
      setNota('Listo: te aviso cada venta y 6 veces por día cómo viene el profit.');
    } catch {
      setEstado(previo);
      setNota('No se pudieron activar los avisos. Probá de nuevo.');
    }
  }

  if (estado === 'cargando' || estado === 'oculto') return null;

  const prendido = estado === 'prendido';
  const etiqueta = prendido ? 'Desactivar avisos' : 'Activar avisos de ventas y profit';

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={alternar}
        disabled={estado === 'trabajando'}
        aria-pressed={prendido}
        aria-label={etiqueta}
        title={etiqueta}
        className={`tap press flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-250 hover:bg-acento-900 disabled:opacity-50 ${
          prendido ? 'text-acento-300' : 'text-neutral-500 hover:text-acento-200'
        }`}
      >
        <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill={prendido ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          {!prendido && estado !== 'trabajando' && <path d="M3 3l18 18" />}
        </svg>
      </button>
      {nota && (
        <span
          role="status"
          className="absolute bottom-full right-0 z-10 mb-2 w-56 rounded-lg bg-surface-raised px-3 py-2 text-xs leading-snug text-neutral-200 shadow-float"
        >
          {nota}
        </span>
      )}
    </span>
  );
}
