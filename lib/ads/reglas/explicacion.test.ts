import { describe, expect, it } from 'vitest';
import { explicar, formatearEur } from './explicacion';
import type { Condicion, Decision, MetricasObjeto, MotivoOmision, Regla } from '../tipos';

function fila(overrides: Partial<MetricasObjeto> = {}): MetricasObjeto {
  return {
    level: 'adset',
    objectId: 'obj_1',
    objectName: 'PXN JEAN VAQUERO 11/08 - Copia',
    accountId: 'act_1234567',
    campaignId: 'camp_1',
    adsetId: 'obj_1',
    adId: '',
    funnelId: null,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    budgetLevel: 'adset',
    budgetMode: 'daily',
    dailyBudgetEur: 10,
    spendEur: 4.37,
    impressions: 0,
    clicks: 0,
    sales: 0,
    revenueEur: 0,
    refundedEur: 0,
    commissionsEur: 0,
    costsEur: 0,
    netEur: 0,
    profitEur: 0,
    roas: null,
    roi: null,
    cpaEur: null,
    ctr: null,
    cpcEur: null,
    ultimaAccionAt: null,
    cpmEur: null,
    hookRate: null,
    videoReproducciones: null,
    videoThruplay: null,
    videoP25: null,
    videoP50: null,
    videoP75: null,
    videoP100: null,
    alcance: null,
    frecuencia: null,
    inicioProgramado: null,
    syncedAt: '2026-08-12T10:00:00.000Z',
    desaparecidoAt: null,
    ...overrides,
  };
}

function regla(overrides: Partial<Regla> = {}): Regla {
  return {
    id: 1,
    name: 'regla de prueba',
    enabled: true,
    dryRun: false,
    accountId: 'act_1234567',
    level: 'adset',
    statusFilter: 'active',
    nameFilter: null,
    nameFilterMode: 'contains',
    action: 'budget_increase',
    actionValue: 250,
    actionUnit: 'percent',
    budgetMax: 25,
    budgetMin: 10,
    period: 'today',
    metricsLevel: 'object',
    everyMinutes: 15,
    windowStart: null,
    windowEnd: null,
    maxRunsPerDay: null,
    cooldownMinutes: 60,
    maxActionsPerObjectPerDay: 4,
    ...overrides,
  };
}

const condiciones: Condicion[] = [
  { metric: 'spend', op: '>', value: 4 },
  { metric: 'sales', op: '=', value: 0 },
];

function decision(motivo: MotivoOmision | null, overrides: Partial<Decision> = {}): Omit<Decision, 'explicacion'> {
  return {
    objectId: 'obj_1',
    cumple: true,
    motivo,
    aplicar: motivo === null,
    presupuestoAntes: motivo === null ? 1000 : null,
    presupuestoDespues: motivo === null ? 2500 : null,
    metrics: {},
    ...overrides,
  };
}

describe('explicacion', () => {
  it('en modo sombra empieza con [SIMULACIÓN] y usa el condicional', () => {
    const texto = explicar(
      regla({ action: 'pause' }),
      condiciones,
      fila({ status: 'ACTIVE' }),
      decision(null),
      true,
    );
    expect(texto.startsWith('[SIMULACIÓN]')).toBe(true);
    expect(texto).toContain('habría pausado');
  });

  it('en modo real NO lleva prefijo y usa el pasado', () => {
    const texto = explicar(
      regla({ action: 'pause' }),
      condiciones,
      fila({ status: 'ACTIVE' }),
      decision(null),
      false,
    );
    expect(texto.startsWith('[SIMULACIÓN]')).toBe(false);
    expect(texto).toContain('se pausó');
  });

  it('el texto contiene el importe formateado en es-AR (€4,37 con coma) y el nombre entre «»', () => {
    const texto = explicar(regla({ action: 'pause' }), condiciones, fila(), decision(null), false);
    expect(texto).toContain('€4,37');
    expect(texto).toContain('«PXN JEAN VAQUERO 11/08 - Copia»');
  });

  it('un presupuesto se explica con antes/después y delta', () => {
    const texto = explicar(
      regla({ action: 'budget_increase', actionValue: 250, actionUnit: 'percent', budgetMax: 25 }),
      [{ metric: 'roi', op: '>', value: 1.3 }],
      fila({ roi: 1.52, dailyBudgetEur: 10 }),
      decision(null),
      false,
    );
    expect(texto).toContain('€10,00');
    expect(texto).toContain('€25,00');
    expect(texto).toContain('+150%');
  });

  it('cada valor de MotivoOmision produce un texto distinto y no vacío (iterá el enum)', () => {
    // La lista ES el enum; si se agrega un MotivoOmision y no se agrega acá, el
    // check de tipos de abajo rompe la compilación (y el test con ella).
    const MOTIVOS: MotivoOmision[] = [
      'cooldown',
      'max_por_objeto',
      'techo_alcanzado',
      'piso_alcanzado',
      'sin_presupuesto_en_este_nivel',
      'ya_esta_en_ese_estado',
      'metrica_indefinida',
      'fuera_de_ventana_horaria',
      'presupuesto_bajo_el_minimo',
      'presupuesto_lifetime_no_soportado',
      'moneda_no_soportada',
      'zonas_horarias_mezcladas',
      'tope_absoluto',
      'resultado_indeterminado_previo',
      'estado_desconocido',
    ];
    // Verificación de exhaustividad en tiempo de compilación: si un motivo no
    // está en la lista, `_Falta` deja de ser never y `true` no le asigna a never.
    type _Falta = Exclude<MotivoOmision, (typeof MOTIVOS)[number]>;
    const _exhaustivo: _Falta extends never ? true : never = true;
    void _exhaustivo;

    const textos = new Set<string>();
    for (const motivo of MOTIVOS) {
      const texto = explicar(regla(), condiciones, fila(), decision(motivo), false);
      expect(texto.length).toBeGreaterThan(0);
      expect(texto).not.toContain('undefined');
      expect(texto).not.toContain('null');
      textos.add(texto);
    }
    expect(textos.size).toBe(MOTIVOS.length);
  });

  it('formatearEur usa coma decimal es-AR y sin espacio', () => {
    expect(formatearEur(4.37)).toBe('€4,37');
    expect(formatearEur(1234.56)).toBe('€1.234,56');
  });

  it('el motivo deprecado zonas_horarias_mezcladas conserva su etiqueta en castellano', () => {
    // El valor sigue declarado en MotivoOmision (con @deprecated) porque el
    // historial viejo se tiene que seguir leyendo: una fila con ese
    // skipped_reason muestra este texto, no "motivo no contemplado".
    const texto = explicar(
      regla(),
      condiciones,
      fila(),
      decision('zonas_horarias_mezcladas'),
      false,
    );
    expect(texto).toContain('zonas horarias distintas');
    expect(texto).not.toContain('motivo no contemplado');
  });
});
