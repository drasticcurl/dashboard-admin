import { describe, expect, it } from 'vitest';
import { MONEDA_ALTERNATIVA, MONEDA_REPORTE, leerMonedaVista } from './moneda-reporte';

// El entorno de tests no define NEXT_PUBLIC_REPORT_CURRENCY: la instancia es la
// de euros, y la alternativa (el switch del Resumen) es el dólar.
describe('moneda del switch EUR/USD', () => {
  it('la alternativa es la otra de las dos soportadas', () => {
    expect(MONEDA_REPORTE).toBe('EUR');
    expect(MONEDA_ALTERNATIVA).toBe('USD');
  });

  it('?moneda=USD (en cualquier caso y con espacios) pide dólares', () => {
    expect(leerMonedaVista('USD')).toBe('USD');
    expect(leerMonedaVista('usd')).toBe('USD');
    expect(leerMonedaVista(' Usd ')).toBe('USD');
  });

  it('ausente, vacío o desconocido cae en la moneda de reporte, sin tirar', () => {
    expect(leerMonedaVista(null)).toBe('EUR');
    expect(leerMonedaVista(undefined)).toBe('EUR');
    expect(leerMonedaVista('')).toBe('EUR');
    expect(leerMonedaVista('ARS')).toBe('EUR');
    expect(leerMonedaVista('EUR')).toBe('EUR');
  });
});
