# T02 — Rutas de API: movimientos y pagos programados

- **Depende de:** T01 (`lib/queries/finance.ts`, ya congelado — lo importás, no lo modificás).
- **Bloquea:** nada directamente, pero T03 necesita estos routes funcionando para probar la
  pantalla end-to-end (alta/edición/borrado).
- **Se puede correr en paralelo con:** T03.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** `app/api/finanzas/movimientos/route.ts`,
  `app/api/finanzas/pagos-programados/route.ts`, y sus `.test.ts` junto a cada uno. Nada más.

Leé `00-PLAN-FINANZAS.md` completo. Tu contrato es el §4 (los tipos y funciones de
`lib/queries/finance.ts`, que T01 ya dejó escritas): tu trabajo es exponerlas por HTTP con
validación de payload y el guard de auth, no reimplementar su lógica.

---

## 1. Objetivo

Cuando termines:

- `GET/POST/PATCH/DELETE /api/finanzas/movimientos` funcionando.
- `GET/POST/PATCH/DELETE /api/finanzas/pagos-programados` funcionando.
- Los dos con guard de auth (401 sin cookie), validación con `zod`, y mensajes de error legibles.

**Este task no toca `lib/queries/finance.ts`.** Si te parece que falta una función o que una firma
no alcanza, es una pregunta abierta para el plan (§10), no una edición tuya de ese archivo.

## 2. Antes de escribir, leé `app/api/config/commissions/route.ts` completo

Es tu plantilla exacta: mismo guard (`guard(req)` de `app/api/config/_lib.ts`), mismo patrón de
`zod` con un schema base compartido entre `create` y `patch`, mismo patrón de traducir el `CHECK`
de la base a un mensaje entendible (`validarCombinacion` ahí valida ANTES de mandar el INSERT
justamente para no depender del texto crudo del error de Postgres).

Qué copiar: la forma general (guard → parse → validar semántica → query → responder), el uso de
`json(status, body)` para las respuestas.

Qué NO copiar: `commissions/route.ts` resuelve `funnelSlug` a `funnelId` porque las comisiones son
por-funnel — Finanzas no tiene ese concepto (D del plan: siempre global), así que tus payloads no
llevan ningún campo de funnel.

## 3. `app/api/finanzas/movimientos/route.ts`

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET ?from=&to=&kind=   → { ok: true, movements: FinanceMovement[] }
// POST                   → { ok: true, movement: FinanceMovement }
// PATCH                  → { ok: true, movement: FinanceMovement }
// DELETE ?id=            → { ok: true }
```

Los schemas de `zod`:

```ts
const kindEnum = z.enum(['gasto', 'retiro', 'ajuste']);
const categoryEnum = z.enum(['sueldos', 'herramientas', 'alquiler', 'impuestos', 'otros']);

const createSchema = z.object({
  kind: kindEnum,
  // Obligatoria en gasto, ausente en los otros dos — igual que currency en
  // commissions/route.ts (obligatoria en fixed, ausente en percent).
  category: categoryEnum.nullable().optional(),
  // Para gasto/retiro: el valor ABSOLUTO que tipeó el usuario (positivo).
  // Para ajuste: el valor con el signo que puso el usuario en el toggle +/-.
  amountEur: z.number().finite(),
  note: z.string().min(1).max(200),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
```

**Reglas, con el bug que evitan:**

1. **La validación semántica de la combinación kind/category corre ANTES de llamar a
   `createMovement`**, igual que `validarCombinacion` en comisiones:
   ```ts
   function validarCategoria(kind: string, category: string | null | undefined):
     | { ok: true; category: FinanceCategory | null }
     | { ok: false; error: string } {
     if (kind === 'gasto') {
       if (!category) return { ok: false, error: 'un gasto necesita categoría' };
       return { ok: true, category };
     }
     // retiro y ajuste: category se fuerza a null, igual que currency se fuerza
     // a null en una comisión porcentual — mandarla es ruido del formulario, no
     // un error del usuario.
     return { ok: true, category: null };
   }
   ```
   Sin esto, un payload con `kind: 'retiro', category: 'otros'` llegaría directo al `CHECK` de la
   base y el usuario vería un error crudo de Postgres en vez de un mensaje entendible.
2. **`amountEur` para `gasto`/`retiro` se valida `> 0` en el schema de creación** (el usuario tipea
   el valor absoluto, nunca negativo — plan §4 regla 1). Para `ajuste`, se acepta cualquier valor
   `!= 0` (positivo o negativo, según el toggle de la UI). Si `kind === 'ajuste'` y `amountEur ===
   0`, se rechaza en el route con `'un ajuste tiene que mover algo'` ANTES de llegar al `CHECK` de
   la base, mismo motivo que la regla anterior.
3. **El GET acepta filtro `kind` opcional** para que la UI pueda pedir sólo los ajustes, por
   ejemplo, sin traer todo y filtrar en el cliente.
4. **El PATCH no permite cambiar `kind`.** Cambiar un `gasto` a `retiro` después de cargado
   cambiaría el significado de `category` (que ya está guardada) de forma ambigua — más simple y
   más seguro es que el usuario borre y cree de nuevo si se equivocó de tipo. El schema de PATCH
   simplemente no incluye el campo `kind`.
5. **DELETE no pide confirmación del servidor** (eso lo hace el cliente con un `confirm()`, igual
   que `deleteCommission`), pero SÍ devuelve 404 si el `id` no existe, para que la UI pueda
   distinguir "ya no está" de "se borró ahora".

## 4. `app/api/finanzas/pagos-programados/route.ts`

```ts
// GET                    → { ok: true, scheduledPayments: ScheduledPayment[] }
// POST                   → { ok: true, scheduledPayment: ScheduledPayment }
// PATCH                  → { ok: true, scheduledPayment: ScheduledPayment }
// DELETE ?id=            → { ok: true }
// POST /ejecutar-ahora   → { ok: true, ejecutados: string[] }   (ver abajo)
```

```ts
const createSchema = z.object({
  name: z.string().min(1).max(80),
  category: categoryEnum,              // siempre obligatoria: un pago programado siempre es un gasto
  amountEur: z.number().positive(),    // SIEMPRE positivo: es la plantilla, no un movimiento (D5 del plan)
  dayOfMonth: z.number().int().min(1).max(28),
});
const patchSchema = z.object({
  id: z.number().int().positive(),
  name: createSchema.shape.name.optional(),
  category: createSchema.shape.category.optional(),
  amountEur: createSchema.shape.amountEur.optional(),
  dayOfMonth: createSchema.shape.dayOfMonth.optional(),
  active: z.boolean().optional(),
});
```

**Reglas:**

1. **Un endpoint extra, `POST /api/finanzas/pagos-programados/ejecutar-ahora`**, que llama a
   `runScheduledPayments(await today(DASHBOARD_TZ))` directo — es el "botón manual" que el plan §4
   menciona en la firma (`runScheduledPayments` "la usan el cron Y un botón manual"). Sin
   argumentos en el body: siempre ejecuta contra el día de hoy, nunca un día arbitrario (evitar que
   alguien dispare la ejecución de un pago "atrasado" de una fecha inventada).
2. **El DELETE no valida si hay `finance_movements` apuntando al pago** (D9 del plan: se
   desvinculan con `SET NULL`, no se bloquea el borrado). No agregues una confirmación extra de "hay
   N pagos históricos, ¿seguro?" — no se pidió y el DELETE de comisiones tampoco lo hace.
3. **`day_of_month` fuera de 1-28 lo rechaza primero el schema de zod** (con un mensaje de zod
   estándar) y, si por algún bug llegara igual, lo rechaza el `CHECK` de la base como red de
   seguridad — no necesitás una validación semántica adicional como la de categoría, porque
   `min(1).max(28)` ya es exacto.

## 5. Tests

Seguí el patrón de `app/api/ads/acciones/route.test.ts` para testear routes de Next (o el que uses
para mockear `NextRequest`, revisá cómo lo hace ese archivo antes de inventar tu propio mock).

Los que importan:

1. **Sin cookie, los 4 métodos de los dos routes devuelven 401** y no llegan a tocar la base — es
   el mismo test que ya existe para `commissions/route.ts`, adaptado.
2. **POST de un gasto sin `category` devuelve 400** con un mensaje que menciona "categoría", no el
   texto crudo de un `check_violation` de Postgres.
3. **POST de un retiro con `amountEur: -50` devuelve 400** (regla 2 de la §3: el usuario manda
   valor absoluto, no negativo, para gasto/retiro).
4. **POST de un ajuste con `amountEur: 0` devuelve 400** con el mensaje `'un ajuste tiene que mover
   algo'`.
5. **POST a `/ejecutar-ahora` con un pago atrasado sembrado de antemano** devuelve
   `{ ok: true, ejecutados: ['<nombre del pago>'] }` y una segunda llamada inmediata devuelve
   `ejecutados: []` (ya se ejecutó ese mes).
6. Los que necesitan `DATABASE_URL` se saltean con `skipIf` sin romper el build.

## 6. Verificación

```bash
# 1 — build y tests
npm run build
npm test

# 2 — sin cookie, 401
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3005/api/finanzas/movimientos
# esperado: 401

# 3 — con cookie válida (usá tu sesión de dev logueada, copiá la cookie del browser), un alta real
curl -s -b "panel_token=<tu cookie>" -X POST http://localhost:3005/api/finanzas/movimientos \
  -H 'Content-Type: application/json' \
  -d '{"kind":"gasto","category":"herramientas","amountEur":29.99,"note":"suscripción de prueba","day":"2026-08-16"}'
# esperado: {"ok":true,"movement":{...,"amountEur":-29.99,...}}   ← OJO: negativo en la respuesta

# 4 — un retiro con category se rechaza
curl -s -b "panel_token=<tu cookie>" -X POST http://localhost:3005/api/finanzas/movimientos \
  -H 'Content-Type: application/json' \
  -d '{"kind":"retiro","category":"otros","amountEur":100,"note":"x","day":"2026-08-16"}'
# esperado: {"ok":false,"error":"invalid_payload",...} con status 400

# 5 — borrar el movimiento de prueba del paso 3
curl -s -b "panel_token=<tu cookie>" -X DELETE "http://localhost:3005/api/finanzas/movimientos?id=<el id de la respuesta 3>"
# esperado: {"ok":true}
```

## 7. Cuándo parar

**Bloqueante, pará y avisá:**
- Si `lib/queries/finance.ts` no expone alguna función que necesitás, o su firma no calza con lo
  que este task necesita hacer. No la edites: es de T01. Anotalo en §10 del plan.

**Anotalo en §10 del plan y seguí:**
- Cualquier decisión de formato de respuesta HTTP no cubierta acá (por ejemplo, si un error de
  validación debería incluir el campo exacto que falló) — usá el criterio de
  `commissions/route.ts` y seguí.
- **Necesitás modificar un archivo ajeno** → nunca; anotalo.
