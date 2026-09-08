# T07 — ROI en Resumen, cron de archivado, deploy y `registro.md`

- **Depende de:** T01 (el script de seed, para el checklist del deploy) y T02 (`archivarHechasViejas`,
  que llama el cron).
- **Bloquea:** nada.
- **Se puede correr en paralelo con:** T05 y T06.
- **Repo:** `dashboard-admin` (rama `main`).
- **Archivos que este task puede tocar:**
  - `lib/queries/overview.ts`
  - `lib/widgets/catalogo-resumen.tsx`
  - `scripts/archivar-tareas.ts` (nuevo)
  - `deploy/cron.panel`
  - `deploy/deploy.sh`
  - `COMO-DEPLOYAR.md`
  - `registro.md` (**la entrada del módulo entero, no sólo de esta task**)

  Nada más. **No toques `package.json`**: los dos scripts de npm los declaró T01, incluido
  `tareas:archivar`, que apunta a tu archivo. Si `npm run tareas:archivar` no existe, pará y avisá: es
  señal de que T01 no terminó.

---

## ⚠️ Antes de escribir una línea: dos de tus archivos están sucios

Medido el 2026-09-08: `lib/queries/overview.ts` y `lib/widgets/catalogo-resumen.tsx` aparecen
**modificados sin commitear** en `git status`, con cambios de otro trabajo (el módulo de insights de IA,
que está entero en el árbol sin commit).

**Commiteá o guardá eso antes de arrancar.** Si trabajás encima y hay que revertir, no hay forma limpia
de revertir sólo lo tuyo. Es la misma situación que documentó §8 del plan de `pitch-ab` y que costó una
sesión entera.

Verificalo:

```bash
git status --short -- lib/queries/overview.ts lib/widgets/catalogo-resumen.tsx
# esperado antes de empezar: VACÍO
```

---

## 1. Objetivo

Tres cosas sueltas que comparten una característica: son las únicas que tocan cosas que **ya funcionan
en producción**. Por eso van juntas y en la última ola.

1. El ROI general en Resumen.
2. El cron que archiva lo terminado a los 2 días.
3. El deploy: que el seed corra, que el cron quede instalado, y que quede escrito qué hay que hacer a
   mano en la instancia de infinix.

Y la entrada de `registro.md` del módulo completo, que es obligatoria por
`.kiro/steering/registro.md`.

---

## 2. El ROI (D16)

### La fórmula

```ts
/** Neto ÷ gasto de publicidad, como múltiplo. Equilibrio en 1.00×.
 *
 * NO es lo mismo que el `roas` de la línea de arriba, y la diferencia es el
 * numerador: `roas` usa el BRUTO (antes de devoluciones, comisiones y costos) y
 * este usa el NETO. Es lo que lo hace un número distinto y no una segunda opinión
 * sobre el mismo.
 *
 * Se descartó `resultEur / adSpendEur`, que también es "retorno sobre la
 * inversión": su equilibrio cae en 0.00× y un múltiplo cuyo cero es el break-even
 * no se lee de un vistazo. Además la ganancia en plata ya la dice el widget de
 * Resultado. La relación es `roi = 1 + resultEur/gasto`, verificada en
 * tasks/usuarios-y-tareas/_verificacion-sesion.mjs (afirmación 16).
 */
roi: totalsAdSpendEur > 0 ? totalsNetEur / totalsAdSpendEur : null,
```

**Las cuatro cosas:**

1. **`null` sin gasto, no 0 ni `Infinity`.** Es la regla que el propio archivo ya fija en las líneas
   58-62 para todos los campos nuevos: *"no se puede calcular" y "vale cero" son cosas distintas*. Los
   campos viejos (`roas`, `convSessionToSale`, `avgTicketEur`) devuelven 0 por compatibilidad con las
   vistas y los tests que ya existen, y ese comentario dice explícitamente **no unificar sin cambiar las
   dos vistas a la vez**. No lo unifiques.
2. **Se calcula con los TOTALES, nunca promediando los de cada funnel.** El comentario de las líneas
   420-427 lo explica: un promedio de ratios no significa nada, y un funnel con 1 venta pesaría igual que
   uno con 300. Va al lado del `roas` de `totals`, con los mismos sumandos.
3. **Va en `totals` y también en `FunnelSummary`**, por el mismo criterio con el que están las dos
   versiones del `roas`. El widget usa el de `totals`.
4. **No toques el `roas`.** Van a quedar los dos, a propósito (P-06).

### El widget

En `lib/widgets/catalogo-resumen.tsx`, un `StatCard` con el patrón de los que ya están.

- **Formato `1.25×`**, con dos decimales y `tabular-nums`. Dos y no uno: la diferencia entre 1.2 y 1.25
  es 4 puntos de margen.
- **Con `null`, mostrá un guion (`—`) y no `0.00×`.** Un ROI de 0 significa que no entró un peso; que no
  haya gasto cargado significa otra cosa completamente distinta.
- **El `hint` dice la fórmula, en castellano**: "neto ÷ gasto de publicidad · el equilibrio es 1.00×".
  Con dos múltiplos parecidos en la misma pantalla (P-06), el hint es lo único que los distingue.
- **El `tone`**: `good` arriba de 1, `bad` abajo, `neutral` con `null`. Es el único caso de este módulo
  donde `good` en verde corresponde, porque acá sí significa "esto está bien".
- Si el catálogo tiene `trend` contra el período anterior, usalo: `computePrev` ya trae `adSpendEur` y
  `netEur` (líneas 148-155, agregados justamente para los trends de Resultado y Gasto), así que **no hace
  falta una query más**.

**No cambies el layout por defecto de Resumen.** El widget entra al catálogo; si aparece o no en la
pantalla lo decide el layout guardado en `settings.ui_layout_resumen`, que es del usuario. Meterlo a la
fuerza en el default le reordena la pantalla a alguien que no lo pidió — y por P-01 ese layout es
**compartido**, así que se lo reordena a los dos.

---

## 3. `scripts/archivar-tareas.ts`

Modelo: `scripts/rollup.ts` o `scripts/fetch-fx.ts`.

- Llama a `archivarHechasViejas(2)` de T02 y **loguea cuántas archivó**, con la fecha. Un cron que no
  dice cuántas filas tocó no se puede auditar cuando alguien pregunta por qué desapareció una tarjeta.
- **Sale con 0 si archivó 0.** No es un error: la mayoría de los días no hay nada que archivar.
- Cargá el `.env` con el patrón de `lib/queries/reconciliacion.integracion.test.ts:46-48`
  (`process.loadEnvFile` condicionado a que exista el archivo).
- `await pool.end()` al final, como `scripts/migrate.ts:50`. Sin eso el proceso queda colgado y el cron
  acumula procesos zombis.
- **Acepta los días por argumento**, con default 2: `npm run tareas:archivar -- 7`. Es lo que permite
  probarlo sin esperar dos días, y lo que evita que alguien edite el script para hacerlo.

En `deploy/cron.panel`, una línea con el estilo de las que ya están. **Una vez al día alcanza** — la
granularidad es de 2 días, así que correrlo cada hora son 23 corridas que archivan 0. Ponelo a una hora
en la que no compita con el rollup ni con el sync de ads.

**Ojo con las dos instancias**: `deploy/cron.panel` está en el repo y lo instala el deploy de hilvanapp.
El de infinix vive fuera del repo (`/srv/panel-infinix/deploy.sh`) y **no lo podés editar**. Su cron hay
que agregarlo a mano, y eso va en el checklist de §5.

---

## 4. `deploy/deploy.sh`

Un solo cambio: correr `npm run usuarios:seed` después de las migraciones y **antes** del health check.

- **Idempotente por construcción** (T01 §8: si el usuario existe, no lo toca ni le cambia la clave), así
  que puede correr en cada deploy sin resetearle la clave a nadie. Verificalo: es lo único que impide que
  un deploy le devuelva la clave `123456` a alguien que ya la cambió.
- **Que su fallo no aborte el deploy.** Si el seed falla, el panel sigue funcionando por el fallback de
  D10 (`DASHBOARD_PASSWORD` con la tabla vacía). Loguealo fuerte y seguí. El precedente en contra
  (`verificar-token-ads.ts`, que sí aborta) es de una feature que gasta plata real; esta no.
- **NO agregues `PANEL_SESSION_SECRET` al array `REQUIRED` de la línea 177.** Tiene default a
  `DASHBOARD_PASSWORD` (D1) justo para que el deploy no falle en ninguna de las dos instancias por una
  variable nueva. Meterla en `REQUIRED` rompe los dos deploys en el próximo push.

---

## 5. `COMO-DEPLOYAR.md`

Una sección propia del módulo, con el estilo del archivo. Lo que **no puede faltar**:

1. **Se cortan todas las sesiones vivas.** El token viejo tiene 2 campos y el parser nuevo lo rechaza
   (D2). Todos vuelven a entrar. No es un bug y no hay que "arreglarlo".
2. **Las claves iniciales son `123456` y hay que cambiarlas EL MISMO DÍA.** Con letras grandes. Mientras
   no se cambien, cualquiera que sepa el nombre de usuario entra (D8, P-04).
3. **La secuencia completa de hilvanapp:**
   ```
   sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh
   # el deploy ya corre: db:migrate → usuarios:seed → health check
   # después, desde el browser: entrar como lucho / 123456 y cambiar la clave
   ```
4. **La secuencia de infinix, que es MANUAL y es lo más importante de esta sección:**
   ```
   sudo -u deploy bash /srv/panel-infinix/deploy.sh     # ese deploy.sh NO tiene el seed
   cd /srv/panel-infinix/repo
   PANEL_ADMIN_USUARIO=ivan PANEL_ADMIN_NOMBRE=Ivan npm run usuarios:seed
   # y agregar la línea del cron de archivado al crontab de esa instancia, a mano
   ```
   **Por qué es manual:** `/srv/panel-infinix/deploy.sh` vive **fuera del repo** (está afuera porque el
   repo es compartido y su `git reset --hard` borraría un archivo propio de la instancia guardado
   adentro). Ninguna task lo puede editar. Mientras el seed no corra ahí, infinix entra con
   `DASHBOARD_PASSWORD` por el fallback de D10 — o sea que **no se rompe, pero no tiene usuarios**, y es
   fácil no darse cuenta.
5. **Cómo volver atrás.** Las migraciones son aditivas: revertir el código deja las cinco tablas ahí sin
   lectores y el panel vuelve a la contraseña compartida. **No hay que borrar las tablas para revertir**, y
   borrarlas se llevaría las tareas.
6. **Qué mirar después:**
   ```
   psql "$DATABASE_URL" -tAc "SELECT usuario, es_admin, debe_cambiar_clave, activo FROM usuarios ORDER BY id"
   # esperado: los dos usuarios, y debe_cambiar_clave en 'f' después de que cada uno entró
   ```

Si algo de este deploy causa una caída, va **también** en la sección *"Cosas que ya pasaron y no
conviene repetir"* del mismo archivo (regla de `.kiro/steering/registro.md`).

---

## 6. `registro.md` — la entrada del módulo entero

**La escribís vos, cubriendo las siete tasks.** Es el mismo reparto que usó el plan de `saldo-cuentas`
(la entrada la escribe la última task, no cada una la suya) y es obligatorio por
`.kiro/steering/registro.md`.

Arriba de todo (lo más nuevo primero), con el formato del archivo:
`## YYYY-MM-DD — <título que es una afirmación>`, la lista de archivos tocados, y los tres bloques.

**Qué pasaba.** Que el panel se autenticaba con una contraseña compartida y la cookie no llevaba
identidad, con las dos migraciones que ya lo habían anotado como limitación conocida
(`016_ads_gestion.sql:404-416` y `017_rediseno_ui.sql:149-155`, citalas). Y que no había tablero de
tareas.

**Por qué se resolvió así.** Las alternativas descartadas, **con el motivo**, que es lo único que este
archivo aporta sobre `git log`:

- Se descartó **agregar una segunda contraseña en una env var** (que fue el pedido original). No era más
  barato: `lib/auth.ts:82-89` usa la contraseña **como clave HMAC** de la cookie, así que con dos
  contraseñas hay dos claves de firma válidas, la cookie no dice cuál firmó, y no se puede saber quién
  entró. Obligaba a cambiar el formato del token igual, que es el 80% de multiusuario. Lo único que
  ahorraba era la pantalla de administrar usuarios.
- Se descartó **meter los permisos firmados en la cookie** (D3): apagarle una pestaña a alguien no
  tendría efecto hasta 12 h después, con el switch diciendo "off".
- Se descartó **un header con el pathname inyectado desde el middleware** (D4), a favor de un
  `layout.tsx` por sección: archivos nuevos, cero líneas tocadas en las diez pantallas que ya andaban.
- Se descartó **`bcrypt`/`argon2`** (D7): `deploy/deploy.sh:210` corre `npm ci` sin `--omit=dev`, así que
  un módulo nativo se compila en la VPS en cada deploy. `scrypt` viene en `node:crypto`.
- Se descartó **8 columnas booleanas y un `text[]`** para los permisos (D11): con filas, "no hay fila" es
  "no lo ve", así que una sección nueva nace negada. Es el mismo movimiento que hizo la 021 con
  `ad_rules.account_ids`.
- Se descartó el **índice fraccionario** para el orden del tablero (D12).
- Se descartó **`jsonb`** para links y comentarios (D15): dos personas en la misma tarjeta se pisan con
  un read-modify-write.
- Se descartó **`resultEur / adSpendEur`** como ROI (D16): equilibrio en 0.00×.
- Y **lo que se decidió NO hacer**, que es lo que evita que alguien lo "arregle": el layout de widgets
  sigue siendo **global** (P-01), no se usó `usuario_secciones` para apagar Anuncios en infinix (P-05), y
  los usuarios **no se borran, se desactivan** (D8 del esquema, con los tres FK RESTRICT que lo
  garantizan).

**Qué se verificó.** Los números y los mensajes **textuales**:

- Las 28 afirmaciones de `_verificacion-030-031.sql` contra una base scratch con las 29 migraciones
  reales aplicadas (Postgres 16.14): 28 PASA, cero FALLA.
- Las 16 de `_verificacion-sesion.mjs` con Node v24.14.0: 16 PASA. Incluida la que decide el diseño —
  `node:crypto` y `crypto.subtle` firman el mismo hex, así que el middleware Edge puede verificar la
  identidad sin base.
- scrypt N=16384 r=8 p=1: **30 ms** en régimen, **99 ms** la primera del proceso.
- **Dos hallazgos de Postgres que costaron dos intentos de test cada uno y conviene no redescubrir:**
  `now()` es la hora de **inicio de la transacción**, así que insertar y updatear en el mismo `BEGIN`
  deja `updated_at` idéntico y `pg_sleep` no cambia nada; y como el trigger es `BEFORE UPDATE`, un
  `UPDATE ... SET updated_at = <viejo>` lo pisa el propio trigger — sembrar una fila con fecha vieja
  sólo se puede en el `INSERT`.
- Y **qué quedó sin verificar**: nada se corrió contra ninguna de las dos bases de producción. La
  verificación de que el guard devuelve 403 con la cookie de nahuel se hizo en local (T03 §7).

---

## 7. Verificación

```bash
# 1. Build y tests
npm run build && npm test
# esperado: TODO el suite verde. Sos la última ola: acá ya no hay huecos esperados.

# 2. El ROI, contra SQL a mano
psql "$DATABASE_URL" -tAc "
  SELECT COALESCE(SUM(revenue_net_eur),0) - COALESCE(SUM(commissions_eur),0) - COALESCE(SUM(costs_eur),0) AS neto,
         COALESCE(SUM(ad_spend_eur),0) AS gasto
    FROM daily_metrics WHERE day BETWEEN '2026-09-01' AND '2026-09-07'"
# dividí neto/gasto a mano y comparalo con lo que muestra el widget para ese rango.
# esperado: el MISMO número con dos decimales. Si no coincide, la query está mal.

# 3. Sin gasto cargado → guion, no 0.00×
#    Elegí un rango sin ad_spend (o poné el rango en un día futuro)
# esperado: el widget muestra "—". Si muestra "0.00×", devolviste 0 en vez de null.

# 4. La aritmética del ROI, afirmada
node tasks/usuarios-y-tareas/_verificacion-sesion.mjs
# esperado: las afirmaciones 13 a 16 en PASA

# 5. El cron de archivado
psql "$DATABASE_URL" -c "UPDATE tareas SET columna='hecho', hecha_at = now() - interval '3 days' WHERE id = <una>"
npm run tareas:archivar
# esperado: loguea "1 tarea archivada"
npm run tareas:archivar
# esperado: "0 tareas archivadas" — idempotente
npm run tareas:archivar -- 7
# esperado: 0 (la de 3 días no llega a 7)
psql "$DATABASE_URL" -tAc "SELECT archivada_at IS NOT NULL FROM tareas WHERE id = <una>"
# esperado: t
#    y que NO aparezca en el tablero, pero sí en "ver archivadas"

# 6. El seed en el deploy es idempotente — es lo que más caro sale si está mal
psql "$DATABASE_URL" -tAc "SELECT usuario, clave_hash FROM usuarios WHERE usuario='lucho'" > /tmp/antes.txt
npm run usuarios:seed
psql "$DATABASE_URL" -tAc "SELECT usuario, clave_hash FROM usuarios WHERE usuario='lucho'" > /tmp/despues.txt
diff /tmp/antes.txt /tmp/despues.txt && echo "PASA: el seed no tocó la clave"
# esperado: PASA. Si difieren, cada deploy le resetea la clave a 123456 y nadie se
#           entera hasta que alguien no puede entrar.
rm -f /tmp/antes.txt /tmp/despues.txt

# 7. El deploy no gana una env var requerida
grep -n "PANEL_SESSION_SECRET" deploy/deploy.sh
# esperado: NADA (o sólo un comentario). Si está en REQUIRED, los dos deploys fallan.

# 8. El cron quedó bien escrito
grep -n "tareas:archivar\|archivar-tareas" deploy/cron.panel
# esperado: una línea, una vez al día, sin choque de horario con rollup ni ads:sync

# 9. El e2e del módulo entero
bash tasks/usuarios-y-tareas/_verificacion-e2e.sh
# esperado: los 9 pasos en PASA

# 10. La entrada de registro.md existe y es la primera
head -20 registro.md
# esperado: el título del módulo arriba, después del encabezado del archivo
```

---

## 8. Cuándo parar

Terminaste cuando los 10 pasos pasan. El 6 es el que no se puede saltear: un seed que no es idempotente
convierte cada deploy en un reseteo de claves silencioso.

**Pará y avisá** si:

- El paso 2 no coincide. Es señal de que el numerador está mal (probablemente usaste el bruto y te dio el
  `roas` de vuelta), no de que haya que ajustar el número esperado.
- `npm run tareas:archivar` no existe. Lo declara T01 en `package.json` y **vos no lo agregás**: si falta,
  T01 no terminó.
- El seed le cambia la clave a alguien que ya la cambió.
- `lib/queries/overview.ts` o `lib/widgets/catalogo-resumen.tsx` tienen cambios sin commitear cuando vas
  a empezar. Está en el aviso de arriba.

**Anotá y seguí** si:

- Te parece que el `roas` debería salir de Resumen ahora que está el ROI. Está en P-06 y no se decide
  ahora: hay que usarlo un par de semanas primero.
- Te parece que el archivado debería ser configurable (los 2 días en `settings` en vez de en el
  argumento del cron).
- Encontrás que el cron de infinix no se puede agregar sin acceso a la VPS. Es esperado: está en el
  checklist de §5 como paso manual.
