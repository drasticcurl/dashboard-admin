'use client';

/**
 * FormularioPresupuesto (task 20.3): un único importe en EUR de 0,01 al
 * Techo_Absoluto con 2 decimales, aplicable a todos los objetos de la
 * Seleccion_Activa (R13 c1). El valor entra como string para no perder los
 * decimales mientras se escribe.
 */

export function FormularioPresupuesto({
  techoEur,
  valor,
  onValor,
}: {
  techoEur: number;
  valor: string;
  onValor: (texto: string) => void;
}): JSX.Element {
  const n = Number(valor);
  const valido = valor !== '' && Number.isFinite(n) && n >= 0.01 && n <= techoEur && Number(n.toFixed(2)) === n;

  return (
    <label className="flex items-center gap-2 text-sm text-neutral-300">
      <span>Presupuesto diario para todos (EUR):</span>
      <input
        type="number"
        min={0.01}
        max={techoEur}
        step={0.01}
        value={valor}
        onChange={(e) => onValor(e.target.value)}
        className={`w-28 rounded border bg-overlay/4 px-2 py-1 text-right text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-good-500/50 ${
          valor !== '' && !valido ? 'border-bad-500/60' : 'border-border-strong'
        }`}
        aria-label="Presupuesto diario en EUR"
        aria-invalid={valor !== '' && !valido}
      />
      <span className="text-xs text-neutral-500">de 0,01 a {techoEur.toFixed(2)} EUR</span>
    </label>
  );
}
