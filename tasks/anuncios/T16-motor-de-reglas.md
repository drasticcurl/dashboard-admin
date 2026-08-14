# T16 — Motor de reglas: evaluación, ejecución, modo sombra y auditoría

- **Depende de:** T13 (la migración 016, `lib/ads/tipos.ts` y la escritura de `lib/ads/meta.ts`).
- **Bloquea:** T18 (el worker) y T19 (la UI de reglas).
- **Se puede correr en paralelo con:** T14 y T15.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** `lib/ads/reglas/motor.ts`, `lib/ads/reglas/explicacion.ts`,
  `lib/ads/reglas/ejecutor.ts`, `lib/ads/reglas/repo.ts` y sus `*.test.ts`. Nada más.

Leé `00-PLAN-ANUNCIOS.md` completo. El **§5 es el contrato congelado** de este task y el **§6** es la
escritura a Meta que ya dejó T13.

**Este es el task que puede gastar plata.** Todo lo que sigue está escrito alrededor de eso.

---

## 1. Objetivo

El motor: dada una regla y las métricas del día, decidir qué objetos tocar, tocarlos, y dejar
registrado en castellano qué se hizo y por qué. Con modo sombra, cooldown, techos, ventana horaria y
límite de acciones por objeto.

Este task **no escribe pantallas, no arma el worker y no manda mensajes a Telegram** (eso es T18). Su
salida es una función que se puede llamar y que hace todo el trabajo de una regla.

**No depende de T15 aunque use sus métricas.** T13 declaró el tipo `MetricasObjeto` y la firma de
`getMetricasAds` en `lib/ads/tipos.ts`: este task evalúa contra el **tipo**, y sus tests construyen las
filas a mano. Es el mismo truco por el que T04 pudo importar `lib/fx.ts` mientras T03 lo implementaba.

**`lib/queries/ads.ts` existe como stub y `ejecutor.ts` lo importa normalmente.** Lo dejó T13 con la
firma correcta y un cuerpo que tira `Error` (§8 del plan). Consecuencia práctica que tenés que tener en
la cabeza: **hasta que T15 termine, cualquier verificación de este task que llame a `getMetricasAds` va a
fallar con "todavía es el stub de T13".** Eso es lo esperado y no es tu bug. Los tests de `motor.ts` y
`explicacion.ts` —que son los que importan y los que cubren la lógica— no la llaman y pasan igual. Las
verificaciones del §8 que sí la necesitan (la 4 en adelante) se corren cuando T15 esté; anotá en §10 si
tuviste que dejarlas para después.

**No escribas tu propia versión de `getMetricasAds` para desbloquearte.** Dos implementaciones del cruce
de gasto con ventas es exactamente cómo el panel termina mostrando dos números distintos para lo mismo.

## 2. La separación que hace testeable todo esto

Cuatro archivos, y la frontera entre el primero y el resto es lo único que importa:

| Archivo | Qué hace | Toca red o base |
|---|---|---|
| `motor.ts` | decide | **no. PURO.** |
| `explicacion.ts` | escribe el texto en castellano | **no. PURO.** |
| `repo.ts` | lee reglas, cuenta acciones, escribe auditoría | base |
| `ejecutor.ts` | orquesta: métricas → decidir → escribir en Meta → auditar | base y red |

Sin esta separación, probar "qué pasa si el ROI es 1,29 y el conjunto ya está en el techo" requiere una
cuenta de Meta y esperar a que gaste. Con ella, es un test de tres líneas.

**`motor.ts` y `explicacion.ts` no importan `lib/db`, no importan `lib/ads/meta` y no usan
`process.env`.** Si necesitás un dato del entorno, entra por parámetro. Es la regla que hace que este
módulo se pueda cambiar sin miedo.

## 3. `lib/ads/reglas/repo.ts` — el acceso a datos

```ts
/** Las reglas prendidas, con sus condiciones ya cargadas. */
export async function reglasActivas(): Promise<{ regla: Regla; condiciones: Condicion[] }[]>;
export async function reglaPorId(id: number): Promise<{ regla: Regla; condiciones: Condicion[] } | null>;

/** Acciones REALES de hoy por objeto, para el cooldown y el máximo. */
export async function historialDeHoy(objectIds: string[]): Promise<Map<string, {
  cuenta: number; ultimaAt: Date | null;
  /** true si quedó una mutación 'pendiente' o 'indeterminado' sin cerrar (§6b). */
  sinCerrar: boolean;
}>>;

/** Las filas que quedaron a mitad de camino. Las cierra el reconciliador (§6b). */
export async function mutacionesSinCerrar(): Promise<{
  id: number; objectId: string; level: NivelAds; action: string;
  beforeValue: string | null; afterValue: string | null; createdAt: Date;
}[]>;

/** Abre la fila de ad_actions ANTES del POST y devuelve su id (§6b). */
export async function abrirAccion(a: { /* … estado: 'pendiente' … */ }): Promise<number>;

/** Cierra esa fila con el resultado real de Meta (§6b). */
export async function cerrarAccion(id: number, r: {
  estado: 'confirmado' | 'fallido' | 'indeterminado';
  ok: boolean; afterValue?: string | null; error?: string | null;
}): Promise<void>;

/** Corridas de hoy de una regla, para max_runs_per_day. */
export async function corridasDeHoy(ruleId: number): Promise<number>;

export async function abrirCorrida(ruleId: number, dryRun: boolean): Promise<number>;
export async function cerrarCorrida(runId: number, r: {
  objetosEvaluados: number; objetosQueCumplen: number;
  accionesEjecutadas: number; accionesSimuladas: number; omitidas: number;
  error?: string | null;
}): Promise<void>;

export async function registrarAccion(a: { /* una fila de ad_actions */ }): Promise<void>;

/**
 * Los interruptores globales Y LOS TOPES, en UNA consulta (D-A12, D-A9c).
 * Van juntos porque se leen juntos, al principio de cada tick, y porque un tope
 * que se lee tarde o se cachea no es un tope.
 */
export async function interruptores(): Promise<{
  habilitado: boolean;
  forzarSombra: boolean;
  /** ads_max_daily_budget_eur. Ningún objeto puede quedar arriba de esto. */
  maxDailyBudgetEur: number;
  /** ads_max_delta_por_tick_eur. Suma máxima que el módulo puede agregar por tick. */
  maxDeltaPorTickEur: number;
}>;
```

Cuatro detalles:

**`historialDeHoy` cuenta solo acciones reales:** `WHERE NOT dry_run AND ok`. Si las simuladas
consumieran cupo, un día en modo sombra dejaría la regla sin acciones disponibles justo cuando se
prende. Verificado en `_verificacion-016.sql` §8.

**Se pide en lote, no de a uno.** Con la cadencia de un minuto de D-A13, una consulta por objeto son
cientos de round-trips por tick. Un solo `WHERE object_id = ANY($1)` y un `Map` en memoria.

**"Hoy" para el cooldown es el día del servidor** (`date_trunc('day', now())`), no el de la cuenta de
Meta. Es un freno operativo, no una métrica de negocio: mezclar las dos zonas acá solo agrega
confusión. Dejalo en un comentario para que nadie lo "arregle" después.

**`interruptores()` lee de `settings`, que es `jsonb`.** Los valores son booleanos JSON: se compara
contra `'true'::jsonb`, no contra el string `'"true"'`. Si una fila no existe, el default es el lado
**seguro**: `habilitado: false`, `forzarSombra: true`, y para los topes el valor más bajo, no el más alto
(`maxDailyBudgetEur: 0` deja el módulo sin poder subir nada, que es lo correcto si la fila desapareció).

**`historialDeHoy` devuelve también `sinCerrar`, y sale de la misma consulta.** Es el flag del paso 3b:
si hay una fila `'pendiente'` o `'indeterminado'` para ese objeto, no se decide sobre él hasta reconciliar.
Traerlo en el mismo `WHERE object_id = ANY($1)` no cuesta nada; hacer una segunda consulta por objeto sí.

## 4. `lib/ads/reglas/motor.ts` — la decisión

Dos funciones exportadas, las dos puras.

```ts
/** ¿Le toca correr a esta regla ahora? Se pregunta UNA vez por regla. */
export function debeCorrer(regla: Regla, ctx: {
  ahora: Date; horaLocal: string; ultimaCorridaAt: Date | null; corridasHoy: number;
}): { correr: boolean; motivo: 'ok' | 'apagada' | 'fuera_de_ventana_horaria' | 'cadencia' | 'max_corridas_diarias' };

/** ¿Qué se hace con este objeto? Se pregunta una vez por objeto. */
export function evaluar(
  regla: Regla, condiciones: Condicion[], fila: MetricasObjeto,
  contexto: { ahora: Date; horaLocal: string; accionesRealesHoy: number;
              ultimaAccionRealAt: Date | null; minimoPresupuesto: number | null },
): Decision;
```

**`debeCorrer` se pregunta antes de pedir las métricas**, y por eso la ventana horaria y la cadencia
viven ahí y no en `evaluar`. Si estuvieran por objeto, una regla fuera de su ventana escribiría cientos
de filas de "omitida por horario" cada minuto y el historial quedaría inservible. Fuera de ventana **no
se registra nada**: solo se loguea a stdout.

**La ventana horaria se evalúa en la zona de la cuenta** (D-A10). Y si `windowStart > windowEnd`, la
ventana cruza la medianoche (`22:00`→`06:00`): la condición no es `h >= start && h <= end` sino
`h >= start || h <= end`. Con la forma ingenua, una regla nocturna nunca corre.

### El orden de los chequeos dentro de `evaluar`

No es arbitrario. Va de "esta acción no tiene sentido" a "esta acción no está permitida ahora" a "esta
acción se pasaría de un límite", y **se reporta el primer bloqueo del orden**, porque es el más
informativo para el que lee el historial:

```
1. ¿Cumple las condiciones?
      todas con AND. Una métrica null NO cumple  →  motivo 'metrica_indefinida'
      si no cumple  →  { cumple: false, aplicar: false }  y se termina
      ← NO SE REGISTRA EN ad_actions. Ver §6 regla 2.

2. ¿La acción cambia algo?
      pause  y el objeto ya está PAUSED   →  'ya_esta_en_ese_estado'
      activate y ya está ACTIVE           →  'ya_esta_en_ese_estado'

3. ¿El presupuesto se maneja en este nivel, y de una forma que sabemos escribir?
      acción de presupuesto y budgetLevel no es el nivel del objeto
                                          →  'sin_presupuesto_en_este_nivel'
      budgetMode === 'lifetime'           →  'presupuesto_lifetime_no_soportado'
      la cuenta no factura en EUR         →  'moneda_no_soportada'

3b. ¿Quedó una mutación sin cerrar sobre este objeto?
      hay una fila 'pendiente' o 'indeterminado' en ad_actions
                                          →  'resultado_indeterminado_previo'
      No se decide sobre un objeto cuyo estado real no se conoce: primero se
      reconcilia (§6b), después se evalúa.

4. ¿Está en cooldown?
      ultimaAccionRealAt + cooldownMinutes > ahora  →  'cooldown'

5. ¿Le quedan acciones hoy?
      accionesRealesHoy >= maxActionsPerObjectPerDay  →  'max_por_objeto'

6. Calcular el presupuesto nuevo y recortarlo
      techo / piso / mínimo de la cuenta
      si ya está en el límite  →  'techo_alcanzado' | 'piso_alcanzado'
      si el resultado queda bajo el mínimo de la cuenta  →  'presupuesto_bajo_el_minimo'

6b. ¿El resultado pasa el TECHO ABSOLUTO? (D-A9c)
      nuevo > ads_max_daily_budget_eur  →  'tope_absoluto'
      Va DESPUÉS del recorte por techo de regla y RECHAZA, no recorta: un pedido
      de €25.000 recortado callado a €200 esconde un bug de unidades.

7. aplicar: true
```

**El paso 2 no es una optimización, es higiene.** Sin él, una regla de "pausar si el gasto > €4" vuelve
a llamar a la API cada minuto sobre un conjunto ya pausado, gasta cuota y llena el historial de
acciones que no hicieron nada.

**El paso 6 y `cumple: true, aplicar: false`.** Cuando la condición se da pero el techo lo impide, la
decisión es `cumple: true` con `motivo: 'techo_alcanzado'`. "No pasó nada" y "no se pudo hacer nada" son
distintos cuando estás debuggeando a las 3 de la mañana, y esa diferencia es la razón por la que
`Decision` tiene los dos campos.

### La aritmética del presupuesto

Todo en **unidades mínimas** (céntimos) y con **un solo redondeo**. Verificado en
`_verificacion-016.sql` §7:

```ts
// D-A9: el porcentaje es un FACTOR sobre el presupuesto actual, NO un incremento.
// 250% = actual × 2,5. Verificado contra el export real del usuario, donde Utmify
// guarda `actionPercentInfo: 2.5` y muestra "250%".
//
// D-A9b: con 'fixed' el valor es un importe en EUR y EL SIGNO LO PONE LA ACCIÓN.
// `action_value` siempre es positivo (lo fuerza el CHECK de la base), así que la
// resta tiene que ser explícita. La versión anterior de esta fórmula hacía
// `actual + Math.round(valor * 100)` para las dos acciones: una regla de bajar
// €1,00 SUBÍA €1,00, y el log decía "se bajó" mientras el importe crecía.
const signo = regla.action === 'budget_decrease' ? -1 : 1;

const bruto = unit === 'percent'
  ? actual * (valor / 100)                          //  250 → ×2,5  ·  100 → sin cambio
  : actual + signo * Math.round(valor * 100);       //  'fixed': increase suma, decrease resta

const techo = budgetMax !== null ? Math.round(budgetMax * 100) : Infinity;
const piso  = Math.max(budgetMin !== null ? Math.round(budgetMin * 100) : 0, minimoPresupuesto ?? 0);

// El techo ABSOLUTO de D-A9c, que no lo pone la regla y no tiene excepciones.
const topeAbsoluto = Math.round(maxDailyBudgetEur * 100);

const nuevo = Math.min(Math.max(Math.round(bruto), piso), techo);
```

**Con `percent` el signo NO se aplica**, y es a propósito: el factor ya lleva la dirección adentro
(`50` baja, `250` sube). Aplicar el signo ahí daría un presupuesto negativo. El `CHECK
ad_rules_percent_direccion` de la base garantiza que un `budget_increase` con `percent` tenga
`action_value > 100` y un `budget_decrease` tenga `< 100`, así que la dirección del factor siempre
coincide con el nombre de la acción y no hay que corregirla en el motor.

**Y el tope absoluto se chequea DESPUÉS del recorte, y rechaza en lugar de recortar:**

```ts
if (nuevo > topeAbsoluto) {
  return { cumple: true, aplicar: false, motivo: 'tope_absoluto', /* ... */ };
}
```

Recortar callado al tope absoluto convierte un bug de unidades en "la regla funciona raro": el objeto
queda en €200 y nadie se enteró de que la regla pedía €25.000. Rechazar y explicarlo en el historial es
lo que hace que el error se vea. El valor sale de `settings.ads_max_daily_budget_eur` y **`repo.ts` lo
lee junto con los interruptores**, no está hardcodeado.

**La diferencia entre las dos lecturas del porcentaje no es académica.** Con `× (1 + valor/100)`, la
escalera del usuario se rompe: sus tres reglas tienen el techo puesto exactamente en el borde superior
de su condición de presupuesto multiplicado por 2,5 (€30,00 × 2,5 = €75,00 al céntimo). Con la lectura
de incremento, el techo cortaría en todas las corridas y sería decorativo.

`Math.round` una sola vez, al final. Dos redondeos encadenados hacen que un factor de 133% sobre 2500 dé
3324 en lugar de 3325, y un céntimo por corrida a las 200 corridas ya se nota.

**`minimoPresupuesto === null` significa "no sé el mínimo", no "el mínimo es 0".** Si es `null`, se usa
solo el piso del usuario. Tratarlo como 0 hace que una regla de bajar presupuesto pida €0,10 y Meta
rechace la llamada.

**Para `budget_decrease`, `valor` sigue siendo positivo** y el signo lo pone la acción **en el código, con
la constante `signo` de arriba**. Una regla con `action_value` negativo es un bug del formulario, no un
caso a soportar: el CHECK de la base ya exige `action_value > 0`. Pero "el signo lo pone la acción" no es
algo que pase solo: si la fórmula dice `actual + valor` para las dos acciones, el signo no lo pone nadie.

### El presupuesto sólo se toca donde el módulo sabe escribir

Antes de calcular nada, dos chequeos que salen del `MetricasObjeto` (D-A10):

```
fila.budgetMode === 'lifetime'  →  'presupuesto_lifetime_no_soportado'
```

El objeto tiene presupuesto TOTAL y lo único que este módulo escribe es `daily_budget`. Sin este
chequeo, la regla le manda un `daily_budget` que Meta rechaza **en cada corrida**, y el error de
validación no dice "este objeto usa presupuesto total": dice algo genérico que se confunde con un
problema de permisos.

La moneda ya la filtró T14 (una cuenta que no factura en EUR no se sincroniza), así que a este punto no
deberían llegar objetos de otra moneda. Si igual llega uno, `'moneda_no_soportada'` y a otra cosa: la
alternativa es escribir un importe en la unidad mínima equivocada, que es plata.

## 5. `lib/ads/reglas/explicacion.ts` — el texto en castellano

El usuario pidió explícitamente que el log se lea bien. Este archivo es esa función, y es puro.

```ts
export function explicar(
  regla: Regla, condiciones: Condicion[], fila: MetricasObjeto,
  d: Omit<Decision, 'explicacion'>, dryRun: boolean,
): string;
```

Una sola línea, con **los números que decidieron** dentro. Formato con `Intl` y locale `es-AR`, igual
que `fmtMoney` de `components/ui.tsx` (leelo, no lo importes: `explicacion.ts` es puro y no depende de
un archivo de React).

**Acción real:**

```
Conjunto «PXN JEAN VAQUERO 11/08 - Copia» (act_1234567): gastó €4,37 hoy con 0 ventas
→ se pausó. Condición: gasto > €4,00 y ventas = 0. Estado anterior: ACTIVE.
```

**Modo sombra:** prefijo `[SIMULACIÓN]` y el verbo en condicional. El prefijo va primero porque es lo
que se lee en la notificación de Telegram antes de abrir nada:

```
[SIMULACIÓN] Conjunto «PXN JEAN VAQUERO 11/08 - Copia» (act_1234567): gastó €4,37 hoy
con 0 ventas → se habría pausado. Condición: gasto > €4,00 y ventas = 0.
```

**Presupuesto:**

```
Conjunto «PXN BIDCAP» (act_1234567): ROI 1,52 con €12,40 de gasto y 3 ventas
→ presupuesto de €10,00 a €25,00 (+150%). Condición: ROI > 1,30 y ventas > 2.
```

**Omitida, y dice por qué:**

```
Conjunto «PXN BIDCAP» (act_1234567): ROI 1,52 con €12,40 de gasto → cumple para subir
el presupuesto, pero no se tocó: ya está en el techo de €25,00.
```

```
Anuncio «PXN R7D 3» (act_1234567): ROI 0,84 con €5,22 de gasto → cumple para pausar,
pero no se tocó: hubo una acción hace 12 minutos y el cooldown es de 60.
```

Tres reglas de redacción:

1. **`explicacion` siempre se escribe, incluso cuando se omite.** Es la razón de ser del historial.
2. **Nunca "error desconocido" ni un motivo en inglés.** El `MotivoOmision` es un enum interno; el texto
   es para una persona. Escribí un `switch` exhaustivo sobre `MotivoOmision` (con
   `const _: never = motivo` en el `default`) para que agregar un motivo nuevo rompa la compilación en
   lugar de producir una explicación vacía.
3. **Cuando la acción es `activate` y el padre está pausado, decilo.** Activar un conjunto cuya campaña
   está `PAUSED` devuelve éxito y no entrega nada: queda `status=ACTIVE` con
   `effective_status=CAMPAIGN_PAUSED`. La explicación tiene que avisarlo o el usuario va a pensar que el
   panel miente:
   ```
   Conjunto «PXN UGC OG» (act_1234567): ROI 1,41 en los últimos 7 días → se activó.
   Ojo: la campaña está pausada, así que todavía no va a entregar.
   ```

## 6. `lib/ads/reglas/ejecutor.ts` — el efecto

```ts
export type ResultadoCorrida = {
  ruleId: number; ruleName: string; runId: number | null;
  corrio: boolean; motivoNoCorrio: string | null;
  dryRun: boolean;
  objetosEvaluados: number; objetosQueCumplen: number;
  ejecutadas: number; simuladas: number; omitidas: number;
  /** Las decisiones que produjeron una fila en ad_actions. T18 las manda a Telegram. */
  acciones: { objectId: string; explicacion: string; ok: boolean }[];
  error: string | null;
};

export async function correrRegla(
  r: { regla: Regla; condiciones: Condicion[] },
  opts?: { forzarSombra?: boolean; ahora?: Date },
): Promise<ResultadoCorrida>;

export async function correrTodas(opts?: { ahora?: Date }): Promise<ResultadoCorrida[]>;
```

El flujo de `correrRegla`:

```
1. interruptores()  →  si !habilitado, devolver corrio:false y NO llamar a Meta
                       (el worker ya lo chequeó antes del sync; acá es la segunda
                        llave, para que el "correr ahora" de la UI tenga el mismo freno)
2. debeCorrer()     →  si no, devolver corrio:false sin abrir corrida ni escribir nada
3. dryRunEfectivo = regla.dryRun || forzarSombra global || opts.forzarSombra
4. getMetricasAds({ level, period, accountIds, status, nombre })
      ← puede TIRAR con 'zonas horarias mezcladas' (T15 §3). Se captura y la regla
        se omite con motivo 'zonas_horarias_mezcladas'. NO se elige una zona.
5. filtrar por nombre según nameFilterMode   (si getMetricasAds no lo hizo)
6. historialDeHoy(los ids candidatos)        ← UNA consulta, en lote
7. abrirCorrida()
8. por cada fila: evaluar() → explicar()
      si NO cumple  →  solo se cuenta en objetos_evaluados. NADA en ad_actions.
      si cumple     →  abrirAccion('pendiente') → POST a Meta → cerrarAccion(resultado)
                       → releer el objeto y refrescar la fila de la jerarquía
      si cumple pero se omite (hay motivo)  →  una fila con estado 'omitido'
      si dryRunEfectivo  →  una fila con estado 'simulado', SIN tocar Meta
9. cerrarCorrida() con los contadores
```

Reglas para el paso 8, que es donde se gasta la plata:

**1. La doble llave del modo sombra se resuelve acá y no en el worker.** `dryRunEfectivo` mira el flag
de la regla **y** el global de `settings`. Está acá y no en T18 para que un "correr ahora" disparado
desde la UI respete los mismos frenos que el cron. Un freno que solo funciona por un camino no es un
freno.

**2. Se registra en `ad_actions` sólo lo que CUMPLIÓ la condición.** Ejecutado, simulado u omitido por un
freno: esas tres van a la tabla, con `dry_run: dryRunEfectivo` y el `estado` correspondiente. La fila con
`estado: 'fallido'` y el error de Meta es la única forma de enterarse de que una regla está fallando en
silencio desde el martes, así que esa no se omite nunca.

**Los objetos que NO cumplieron la condición no generan fila.** Se cuentan en
`ad_rule_runs.objetos_evaluados` y ahí termina. La versión anterior de este task decía
"`registrarAccion()` se llama SIEMPRE", y eso rompía dos cosas a la vez:

- **Fidelidad.** Una condición que no se dio no es "una acción simulada". Con `dry_run: true` esa fila se
  muestra como *simulado* en el historial y con el modo real se muestra como *hecho*: el panel afirma que
  la regla hizo algo que no hizo. Es justo la confusión que el modo sombra existe para evitar.
- **Volumen.** Con un tick por minuto sobre unos cientos de objetos son cientos de miles de filas por día,
  en la misma tabla que sostiene el cooldown en el camino que corre cada minuto. La auditoría se vuelve
  inútil por ruido bastante antes de volverse lenta por tamaño, y el "solo errores" de T19 pasa a ser la
  única vista usable.

Si querés el detalle de por qué un objeto no cumplió, está en el preview de T19 (que evalúa y devuelve las
decisiones sin persistirlas) y en el log del tick. No en la tabla de auditoría.

**2b. El orden es abrir la fila, después escribir en Meta.** No al revés (§6c del plan):

```
abrirAccion({ estado: 'pendiente', before_value, after_value: <lo que se va a pedir> })
  → POST a Meta
  → cerrarAccion(id, { estado: 'confirmado' | 'fallido' | 'indeterminado' })
```

Una transacción de Postgres no puede hacer atómico un POST remoto. Si Meta acepta el cambio y el proceso
muere antes del `INSERT`, queda una campaña modificada **sin ninguna fila que lo diga**: el tick siguiente
no la ve, no la cuenta para el cooldown, y la repite. Invertir el orden convierte ese caso en una fila
`'pendiente'` que el reconciliador encuentra y cierra.

**Un timeout es `'indeterminado'`, no `'fallido'`.** `enviar()` de T13 §6 lo distingue. La diferencia
importa porque `'indeterminado'` **consume cupo del cooldown** (puede haberse aplicado) y `'fallido'` no
(ahí no pasó nada en Meta y reintentar es sano).

**3. `metrics` se congela en la fila.** Guardá en el `jsonb` las métricas con las que se decidió
(`spendEur`, `sales`, `roi`, `roas`, `dailyBudgetEur`, y las que aparezcan en las condiciones). El gasto
de hoy cambia todo el tiempo: recalcularlo después nunca reproduce la decisión.

**4. A qué id se le pega el presupuesto.** Si el objeto es un conjunto de una campaña CBO, el
presupuesto **no se escribe en el conjunto**: la decisión ya salió con
`sin_presupuesto_en_este_nivel` en el paso 3 de `evaluar`. Cuando sí se escribe, es al `objectId` de la
fila, nunca a un padre inferido.

**4b. Después de escribir, se relee el objeto y se refresca la fila de la jerarquía.** T17 ya lo hacía para
las acciones manuales (su §9.8) y este task no lo pedía para las automáticas. La consecuencia era concreta y
cara: el motor evaluaba la corrida siguiente contra el presupuesto **viejo** de `ad_sets.daily_budget`, la
condición `budget < €11,00` seguía cumpliéndose después de haber subido a €25,00, y **la escalera del
usuario se disparaba dos veces sobre el mismo escalón** hasta que el cooldown la frenaba.

```
setDailyBudget(objectId, nuevo)  →  confirmado
  → fetchObjeto(objectId, level)                    ← Meta es el source of truth
  → UPDATE ad_sets SET daily_budget = <lo que dijo Meta>, synced_at = now()
```

Se escribe **lo que Meta devuelve**, no lo que pediste: si Meta redondeó o ajustó al mínimo de la cuenta, el
valor real es el suyo. Si `fetchObjeto` falla, dejá la fila de `ad_actions` en `'confirmado'` (el cambio se
aplicó) pero marcá la jerarquía como vieja bajándole el `synced_at`, así el sync de T14 la refresca y la
regla no decide contra un número que no sabés si es correcto.

**4c. El tope agregado por tick** (`ads_max_delta_por_tick_eur`, D-A9c). `correrTodas` acumula cuánto
presupuesto sumó entre TODAS las reglas y TODOS los objetos del tick. Cuando el acumulado pasa el tope, las
decisiones que faltan se omiten con `'tope_absoluto'` y el tick loguea que se cortó por ahí.

Es el caso que el tope por objeto no ve: 80 conjuntos que suben €50 cada uno son €4.000 de presupuesto
diario nuevo en un minuto, y cada uno individualmente estaba dentro del límite. El acumulador vive en
`correrTodas` y se pasa a `correrRegla`, porque el límite es del tick y no de la regla.

**5. Un objeto que falla no detiene a los demás.** Mismo criterio que `syncAdSpend`: se captura, se
registra con `ok: false` y se sigue. Un `MetaAdsError` con `code: 190` (token vencido) sí conviene
cortar la corrida entera —van a fallar todos— y guardarlo en `ad_rules.last_run_error`.

**6. `before_value` y `after_value` son strings**, porque sirven para dos cosas distintas: en una acción
de estado son `'ACTIVE'`/`'PAUSED'`, y en una de presupuesto son el importe en EUR formateado. Que sea
`text` en la base es a propósito: el historial se lee, no se agrega.

## 6b. `reconciliar()` — cerrar lo que quedó a mitad de camino

Es la contraparte de escribir la fila antes del POST, y va en `ejecutor.ts`:

```ts
/**
 * Cierra las filas de ad_actions que quedaron en 'pendiente' o 'indeterminado'.
 * Corre al PRINCIPIO de cada tick, ANTES de evaluar cualquier regla.
 * Devuelve cuántas cerró y cómo, para el log y para Telegram.
 */
export async function reconciliar(): Promise<{
  revisadas: number; confirmadas: number; fallidas: number; sinResolver: number;
}>;
```

El algoritmo, por cada fila sin cerrar de más de un minuto:

```
1. fetchObjeto(objectId, level)          ← se le pregunta a Meta
2. comparar el estado real con after_value
     coincide            → cerrarAccion(estado: 'confirmado', ok: true)
     sigue en before_value → cerrarAccion(estado: 'fallido', ok: false,
                                          error: 'el POST no llegó a aplicarse')
     es otra cosa        → cerrarAccion(estado: 'confirmado') y anotar el valor real:
                           alguien lo cambió a mano en el administrador de anuncios
3. si fetchObjeto falla  → se deja como está y cuenta en sinResolver.
                           El objeto sigue bloqueado por 'resultado_indeterminado_previo'
                           hasta el tick siguiente. Bloquear es más barato que adivinar.
```

**Meta es el source of truth, no la base.** Un `'pendiente'` de hace tres minutos no significa "falló":
significa que el proceso murió entre el `INSERT` y el `POST`, o entre el `POST` y el `UPDATE`, y **desde
Postgres no hay forma de saber cuál**. La única fuente es la API.

`reconciliar()` **no llama a Meta si el interruptor global está apagado**: en ese caso las filas quedan sin
cerrar, los objetos afectados siguen bloqueados, y eso es correcto. El freno de emergencia no tiene
excepciones (D-A12).

El índice `ad_actions_sin_cerrar_idx` está para esta consulta y es parcial sobre un conjunto que
normalmente está vacío: no pesa.

## 7. Tests — este es el task con más tests del módulo

`motor.test.ts` y `explicacion.test.ts` **no necesitan base ni red**: son los que tienen que cubrir
todo. `ejecutor.test.ts` y `repo.test.ts` se saltan sin `DATABASE_URL`.

Lo que hay que probar, como mínimo:

**Condiciones**
1. Dos condiciones que se cumplen → `cumple: true`. Una de dos que no → `cumple: false` (es AND).
2. **`roi: null` con la condición `roi < 1.1` → NO cumple**, motivo `metrica_indefinida`. Es el test más
   importante del task: si esto falla, el motor pausa conjuntos que no gastaron nada.
3. Los seis operadores (`>`, `>=`, `<`, `<=`, `=`, `!=`) contra el borde exacto. `roi = 1.3` con
   `roi > 1.3` no cumple; con `roi >= 1.3` sí.
4. Cero condiciones → cumple (es una regla que se aplica a todo lo que pasó el filtro de alcance). Que
   sea intencional o no es problema del formulario de T19, no del motor.

**Frenos**
5. Cooldown de 60 min con última acción hace 12 → `cooldown`. Hace 61 → aplica.
6. `maxActionsPerObjectPerDay: 4` con 4 acciones hoy → `max_por_objeto`. Con 3 → aplica.
7. Las acciones simuladas no consumen cupo (se prueba en `repo.test.ts` contra la base).
8. `pause` sobre un objeto ya `PAUSED` → `ya_esta_en_ese_estado`.
9. Acción de presupuesto sobre un conjunto con `budgetLevel: 'campaign'` →
   `sin_presupuesto_en_este_nivel`.
10. **El orden de precedencia:** un objeto en cooldown **y** en el techo reporta `cooldown` (paso 4
    antes que paso 6). Fijá el orden con un test o va a cambiar solo en el próximo refactor.

**Presupuesto**
11. **`250%` sobre 1000 → 2500** (D-A9: factor, no incremento). Si tu implementación da 3500, está mal
    y la escalera del usuario se rompe. Poné este test primero.
12. `100%` sobre 2500 → 2500. Un factor de 100 no cambia nada, y ese es el caso que hace obvio que es
    un factor y no un incremento (con incremento daría 5000).
13. Con techo de €25,00, `250%` sobre 1100 → 2500 (recortado). Es exactamente el caso de la regla
    «Duplicar a $25» del usuario: su condición es `presupuesto < €11,00`.
14. Ya en 2500 con techo €25,00 → `techo_alcanzado`, `aplicar: false`.
15. `+€1,00` fijo sobre 2500 → 2600. `'fixed'` sí es un incremento.
15b. **`budget_decrease` con `-€1,00` fijo sobre 2500 → 2400, NO 2600.** Es el test que atrapa el bug de
    la fórmula que sumaba para las dos acciones: sin él, una regla de bajar €1,00 sube €1,00 y el
    historial dice "se bajó" mientras el importe crece. Ponelo al lado del 15.
15c. `budget_decrease` con `50%` sobre 2500 → 1250. Con `percent` el factor ya lleva la dirección, así
    que el signo NO se aplica dos veces (si tu implementación da un negativo, estás aplicando los dos).
16. `50%` sobre 200 con `minimoPresupuesto: 100` → 100, no `presupuesto_bajo_el_minimo` (queda justo en
    el mínimo). Con `40%` → 80 recortado a 100.
17. `minimoPresupuesto: null` no se trata como 0.
17b. **Techo absoluto** (D-A9c): con `maxDailyBudgetEur: 200`, un cálculo que da 25000 (€250,00) devuelve
    `motivo: 'tope_absoluto'` y **`aplicar: false`**, no un valor recortado a 20000. Recortar callado
    esconde el bug de unidades que disparó el número.
17c. **`budgetMode: 'lifetime'`** con una acción de presupuesto → `'presupuesto_lifetime_no_soportado'`,
    sin calcular nada. Es el objeto al que el módulo le mandaría un `daily_budget` que Meta rechaza en
    cada corrida (D-A10).

**Ventana y cadencia (`debeCorrer`)**
18. Ventana `22:00`–`06:00` con hora local `23:30` → corre. Con `12:00` → no.
19. Ventana `09:00`–`18:00` con `23:30` → no corre.
20. **Ventana `00:00`–`00:59` con `00:30` → corre; con `01:00` → no.** Es la regla «Activar todas a las 0
    horas» del usuario, que el seed carga con esa ventana exacta.
21. `everyMinutes: 15` con última corrida hace 3 min → no corre. Hace 16 → corre.
22. `maxRunsPerDay: 10` con 10 corridas hoy → no corre.

**Auditoría — lo que se registra y lo que no** (§6 regla 2)
22b. **Un objeto que NO cumple la condición no produce ninguna fila en `ad_actions`.** Se cuenta en
    `objetos_evaluados` y nada más. Es un test de `ejecutor.test.ts` contra la base: evaluá 10 objetos
    donde 1 cumple, y verificá `count(*) = 1` en `ad_actions` y `objetos_evaluados = 10` en
    `ad_rule_runs`. Sin este test, la tabla se llena de cientos de miles de filas por día que además
    afirman cosas que no pasaron.
22c. **Un objeto que cumple pero se omite SÍ produce fila**, con `estado: 'omitido'` y su
    `skipped_reason`. "No pasó nada" y "no se pudo hacer nada" son distintos a las 3 de la mañana.
22d. **La fila se abre ANTES del POST.** Simulá un `enviar()` que tira un `AbortError` y verificá que
    quedó una fila con `estado: 'indeterminado'` (no `'fallido'`) y que **consume cupo del cooldown**.
22e. **`reconciliar()` cierra una fila `'pendiente'`** según lo que dice Meta: si el objeto quedó en
    `after_value` → `'confirmado'`; si sigue en `before_value` → `'fallido'`. Y si `fetchObjeto` falla,
    la deja abierta y el objeto sigue bloqueado con `'resultado_indeterminado_previo'`.

**Explicación**
23. En modo sombra el texto empieza con `[SIMULACIÓN]` y usa el condicional.
24. El texto contiene el importe formateado en `es-AR` (`€4,37`, con coma) y el nombre del objeto entre
    `«»`.
25. Cada valor de `MotivoOmision` produce un texto distinto y no vacío. Iterá sobre el enum en el test:
    así, agregar un motivo sin su texto rompe el test.

**Las seis reglas del seed, de punta a punta**
26. Cargá las seis reglas que dejó el seed (ya están en la base cuando arrancás este task) y pasales
    filas de métricas construidas a mano. Verificá que cada una decida lo que su nombre dice:
    - un conjunto con `roi: 1.52`, `sales: 3`, `spendEur: 8`, `dailyBudgetEur: 10` → la regla
      «Duplicar a $25» aplica y el presupuesto nuevo es 2500
    - el mismo con `dailyBudgetEur: 12` → **no** cumple (`budget < 11`)
    - `roi: 0.9`, `spendEur: 8` → «Apagar - Gasto +$10 ROI -1.10» aplica
    - `spendEur: 5`, `sales: 0` → «Apagar - Gasto +$4 sin ventas» aplica
    - `spendEur: 5`, `sales: 1` → **no** aplica
    Es el test que prueba que la traducción del export de Utmify quedó bien, y es más valioso que
    cualquier caso inventado: son las reglas que van a correr sobre plata real.

## 8. Verificación

Nada de esto es opcional.

```bash
cd ~/Desktop/funnel/dashboard-admin
export PSQL="docker exec panel-db-1 psql -U panel -d panel"

# 1 — compila y los tests pasan
npx tsc --noEmit && npm run build && npm test

# 2 — motor.ts y explicacion.ts son PUROS (§2). Esto tiene que dar CERO líneas:
grep -nE "from '(\.\./)*db'|lib/db|lib/ads/meta|process\.env" \
  lib/ads/reglas/motor.ts lib/ads/reglas/explicacion.ts
# si aparece algo, la separación se rompió y los tests dejan de ser confiables

# 3 — EL FRENO GENERAL FUNCIONA. Con el interruptor apagado, no se toca Meta.
$PSQL -c "UPDATE settings SET value='false'::jsonb WHERE key='ads_rules_enabled';"
npx tsx -e "
  import('./lib/ads/reglas/ejecutor').then(async (m) => {
    const r = await m.correrTodas();
    console.log(JSON.stringify(r.map(x => ({ regla: x.ruleName, corrio: x.corrio, motivo: x.motivoNoCorrio })), null, 2));
  });
"
# esperado: corrio:false en TODAS, motivo 'apagada', y CERO filas nuevas en ad_actions
$PSQL -tAc "SELECT count(*) FROM ad_actions WHERE created_at > now() - interval '2 min';"
# esperado exactamente: 0

# 4 — EL CRITERIO QUE DECIDE SI ESTO SE PUEDE PRENDER (§9.6 del plan):
#     una regla en modo sombra registra la acción y NO cambia nada en Meta.
#
#  a) Creá una regla que seguro se cumpla, sobre un conjunto PAUSADO y en sombra:
$PSQL -c "
  INSERT INTO ad_rules (name, enabled, dry_run, level, status_filter, action, cooldown_minutes)
  VALUES ('PRUEBA T16 - activar pausados', true, true, 'adset', 'paused', 'activate', 0)
  RETURNING id;"
#     (sin condiciones: se aplica a todos los conjuntos pausados)

#  b) Anotá el estado real en Meta de uno de esos conjuntos ANTES:
export T=$(grep -m1 '^META_ADS_TOKEN=' .env | cut -d= -f2-)
[ -n "$T" ] || { echo "FALTA META_ADS_TOKEN en .env — agregalo antes de seguir"; exit 1; }
export V="${META_API_VERSION:-v21.0}"
export AS_ID=$($PSQL -tAc "SELECT adset_id FROM ad_sets WHERE status='PAUSED' LIMIT 1")
# Token en el HEADER, no en el query string (D-A3).
curl -sG "https://graph.facebook.com/$V/$AS_ID" \
  --data-urlencode "fields=id,name,status" -H "Authorization: Bearer $T"

#  c) Prendé el interruptor general PERO dejá el modo sombra global:
$PSQL -c "UPDATE settings SET value='true'::jsonb WHERE key='ads_rules_enabled';"
$PSQL -c "UPDATE settings SET value='true'::jsonb WHERE key='ads_rules_force_dry_run';"
npx tsx -e "import('./lib/ads/reglas/ejecutor').then(m => m.correrTodas().then(r => console.log(r)))"

#  d) Tiene que haber filas, TODAS con dry_run = true:
$PSQL -c "
  SELECT dry_run, ok, count(*) FROM ad_actions
   WHERE created_at > now() - interval '5 min' GROUP BY 1,2;"
# esperado: una sola fila, dry_run = t

#  e) Y el estado en Meta tiene que ser IDÉNTICO al del paso (b):
curl -sG "https://graph.facebook.com/$V/$AS_ID" \
  --data-urlencode "fields=id,name,status" -H "Authorization: Bearer $T"
# SI CAMBIÓ A ACTIVE, EL MODO SOMBRA NO FUNCIONA. Pará todo y arreglalo:
# es el único bug de este módulo que se paga con plata sin aviso.

#  f) Y las filas del modo sombra tienen estado 'simulado', no 'confirmado':
$PSQL -c "SELECT estado, count(*) FROM ad_actions
           WHERE created_at > now() - interval '5 min' GROUP BY 1;"
# esperado: una sola fila, estado = simulado

# 4b — LA AUDITORÍA NO REGISTRA LOS OBJETOS QUE NO CUMPLEN (§6 regla 2)
#      Es el cambio que evita cientos de miles de filas por día Y que el historial
#      afirme acciones que no pasaron.
$PSQL -c "
  SELECT r.objetos_evaluados, r.objetos_que_cumplen,
         (SELECT count(*) FROM ad_actions a WHERE a.run_id = r.id) AS filas_en_ad_actions
    FROM ad_rule_runs r ORDER BY r.id DESC LIMIT 3;"
# esperado: filas_en_ad_actions == objetos_que_cumplen, y MENOR que objetos_evaluados.
# Si filas_en_ad_actions == objetos_evaluados, estás registrando cada evaluación:
# con un tick por minuto eso son cientos de miles de filas por día en la tabla que
# además sostiene el cooldown.

# 4c — EL TECHO ABSOLUTO CORTA (D-A9c). Bajalo a €1 y verificá que rechaza.
$PSQL -c "UPDATE settings SET value='1'::jsonb WHERE key='ads_max_daily_budget_eur';"
npx tsx -e "import('./lib/ads/reglas/ejecutor').then(m => m.correrTodas().then(r => console.log(r)))"
$PSQL -c "SELECT skipped_reason, count(*) FROM ad_actions
           WHERE created_at > now() - interval '2 min' GROUP BY 1;"
# esperado: las decisiones de presupuesto omitidas con 'tope_absoluto'.
# Y NINGUNA con un after_value recortado a €1,00: el techo RECHAZA, no recorta.
$PSQL -c "UPDATE settings SET value='200'::jsonb WHERE key='ads_max_daily_budget_eur';"

# 4d — EL RECONCILIADOR CIERRA LO QUE QUEDÓ COLGADO (§6b)
#      Simulá un proceso que murió después del INSERT y antes del POST:
$PSQL -c "
  INSERT INTO ad_actions (source, account_id, level, object_id, action, ok, estado,
                          explicacion, before_value, after_value, created_at)
  VALUES ('rule', 'act_1', 'adset', '$AS_ID', 'pause', false, 'pendiente',
          'PRUEBA T16 - quedó pendiente', 'PAUSED', 'PAUSED', now() - interval '5 min');"
npx tsx -e "import('./lib/ads/reglas/ejecutor').then(m => m.reconciliar().then(r => console.log(r)))"
$PSQL -tAc "SELECT estado FROM ad_actions WHERE explicacion LIKE 'PRUEBA T16 - quedó pendiente%';"
# esperado: confirmado (el objeto en Meta está PAUSED, que es el after_value).
# Si sigue en 'pendiente', el reconciliador no corrió o fetchObjeto falló: en ese
# caso el objeto tiene que quedar BLOQUEADO, no evaluarse a ciegas.

# 5 — las explicaciones se leen bien (es lo que pidió el usuario)
$PSQL -c "SELECT explicacion FROM ad_actions ORDER BY id DESC LIMIT 8;" -P expanded=on
# leelas de verdad. Tienen que ser frases en castellano con los números adentro,
# no un volcado de campos. Si alguna dice 'undefined', 'null' o un motivo en
# inglés, arreglala.

# 6 — las métricas quedaron congeladas
$PSQL -tAc "SELECT metrics FROM ad_actions ORDER BY id DESC LIMIT 1;"
# esperado: un jsonb con spendEur, sales, roi, roas — no '{}'

# 6b — LA JERARQUÍA SE REFRESCÓ DESPUÉS DE ESCRIBIR (§6 regla 4b)
#      Es lo que evita que la escalera se dispare dos veces sobre el mismo escalón.
$PSQL -c "
  SELECT a.object_id, a.after_value, s.daily_budget, s.synced_at
    FROM ad_actions a JOIN ad_sets s ON s.adset_id = a.object_id
   WHERE a.action IN ('budget_increase','budget_decrease') AND a.estado = 'confirmado'
   ORDER BY a.id DESC LIMIT 3;"
# El daily_budget de ad_sets tiene que reflejar el after_value, y synced_at tiene
# que ser posterior a la acción. Si el presupuesto quedó viejo, la corrida
# siguiente vuelve a cumplir `budget < €11,00` y sube DE NUEVO.

# 7 — limpieza de la prueba
$PSQL -c "DELETE FROM ad_rules WHERE name = 'PRUEBA T16 - activar pausados';"
$PSQL -c "DELETE FROM ad_actions WHERE rule_name = 'PRUEBA T16 - activar pausados';"
$PSQL -c "DELETE FROM ad_actions WHERE explicacion LIKE 'PRUEBA T16%';"
$PSQL -c "UPDATE settings SET value='false'::jsonb WHERE key='ads_rules_enabled';"
$PSQL -c "UPDATE settings SET value='true'::jsonb  WHERE key='ads_rules_force_dry_run';"
$PSQL -c "UPDATE settings SET value='200'::jsonb WHERE key='ads_max_daily_budget_eur';"
# el interruptor general vuelve APAGADO. Lo prende el usuario cuando quiera.

# 8 — no se tocó nada de lo existente
# `git diff` NO SIRVE en este proyecto: `dashboard-admin` no esta trackeado
# en el repo git del padre (~/Desktop/funnel solo trackea .kiro y funnel-mate),
# asi que TODOS los archivos son untracked y el diff sale vacio o inutil.
# Verificado. El chequeo que si funciona es por fecha de modificacion:
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
```

## 9. Cuándo parar

**Bloqueante, pará y avisá:**

- **La verificación 4(e) muestra que el estado en Meta cambió con el modo sombra prendido.** Es el peor
  bug posible de este módulo: el usuario lo va a dejar corriendo toda la noche creyendo que simula.
- La verificación 3 escribe filas o llama a Meta con el interruptor general apagado.
- El test 2 (`roi: null` no cumple `roi < 1.1`) falla. El motor va a pausar conjuntos que no gastaron.
- **El test 15b falla: un `budget_decrease` con `-€1,00` fijo da 2600 en lugar de 2400.** Una regla de
  bajar que sube, con el historial diciendo "se bajó". Era un bug real de la fórmula del plan.
- **El test 11 da 3500 en lugar de 2500.** Volvió la lectura de incremento y toda la escalera del usuario
  hace algo distinto de lo que él configuró.
- **La verificación 4c muestra que el techo absoluto recorta en lugar de rechazar**, o que no corta nada.
  Es el único freno que protege contra un error de unidades, de decimales o de un payload armado a mano.
- La verificación 2 encuentra un import de `db` o de `meta` en `motor.ts` o `explicacion.ts`.

**Anotalo en §10 del plan y seguí:**

- Te faltó un `MotivoOmision` que el §5 del plan no previó. **No modifiques `lib/ads/tipos.ts`** (T17,
  T18 y T19 lo están importando): anotá cuál y usá el más cercano por ahora.
- **Cuántas filas escribe un tick en `ad_actions`.** Corré un tick sobre la cuenta real y anotá
  `objetos_evaluados` contra las filas escritas. Es el dato que dice si la auditoría va a ser legible en
  un mes, y es el insumo del plan de retención que el módulo no tiene (§11 del plan).
- **Cuántas veces `reconciliar()` encontró algo que cerrar.** Si es siempre 0, el camino está sano. Si
  aparece seguido, hay timeouts contra Meta y conviene mirar la latencia antes de subir la cadencia.
- `metricsLevel` distinto de `'object'`: la base lo rechaza (`ad_rules_mlevel_valido`) porque `'parent'`
  quedó sin implementar. Si te hace falta, **no lo agregues acá**: es una 017 con la semántica escrita
  (cómo se resuelve el padre, si se deduplica, a qué objeto se aplica la acción). Anotalo.
- Meta devuelve un `code` de error que no sabés cómo clasificar. Registralo con `ok: false` y el mensaje
  crudo, y anotá el código: con el tiempo se arma la tabla de los que importan.
- Una regla sin condiciones se aplica a todo lo que pasó el filtro de alcance, y eso es peligroso.
  **No lo bloquees en el motor** (el motor obedece): anotalo para que T19 lo advierta en el formulario.
- El `minimoPresupuesto` de la cuenta viene en `null` para todas las cuentas. Anotalo: el piso queda a
  cargo del usuario y una regla de bajar presupuesto puede fallar contra Meta.
