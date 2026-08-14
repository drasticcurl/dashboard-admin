export type Device = 'mobile' | 'desktop' | 'tablet' | 'unknown';

/**
 * Parseo mínimo de user-agent (task T02 §6), sin dependencias: solo se
 * necesita clasificar para el contexto de la sesión, no para tomar decisiones.
 *
 * El orden de los regex importa: un iPad manda 'Mobile' en su UA, así que
 * tablet se evalúa primero, si no todo iPad sería 'mobile'.
 */
export function deviceFromUA(ua: string | null | undefined): Device {
  if (!ua) return 'unknown';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) return 'mobile';
  return 'desktop';
}
