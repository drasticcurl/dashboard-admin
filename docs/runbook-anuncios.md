# Runbook de Anuncios — operativo

Para leer a las 2 de la mañana con una regla que hizo algo raro. Nada de
arquitectura: eso vive en `tasks/anuncios/00-PLAN-ANUNCIOS.md`. El worker corre
en PM2 como `panel-reglas`; el cron de respaldo (`--health`) avisa si cayó.

**El módulo puede gastar plata.** Todo lo que sigue está escrito alrededor de
esa frase.

---

## 1. Prender el módulo por primera vez

El orden importa. Es el argumento de venta de todo el diseño: se mira un día
entero de decisiones simuladas antes de darle la llave del presupuesto.

```bash
cd /srv/panel/current

# 0. VERIFICAR EL TECHO ABSOLUTO. ads_max_daily_budget_eur arranca en €200.
#    Si tus reglas necesitan más, subilo A PROPÓSITO con un UPDATE — no
#    descubras el rechazo (motivo 'tope_absoluto') en producción:
#    docker exec panel-db-1 psql -U panel -d panel -c \
#      "SELECT key, value FROM settings WHERE key = 'ads_max_daily_budget_eur';"

# 1. Confirmar que el token ESCRIBE.
npm run ads:token

# 2. Cargar campañas, conjuntos y anuncios (jerarquía).
npm run ads:jerarquia

# 3. Configurar el bot de Telegram (opcional, pero querés los avisos).
npm run ads:telegram

# 4. Crear las reglas en /anuncios/reglas. Nacen apagadas y en sombra.

# 5. Prender el freno de mano global. El worker empieza a evaluar.
#    (o el switch "Motor de reglas" en /anuncios/reglas)
#    UPDATE settings SET value='true'::jsonb WHERE key='ads_rules_enabled';

# 6. DEJAR ads_rules_force_dry_run EN true POR 24 HORAS.
#    Con esto todo corre y se registra, pero NADA se escribe en Meta.
#    Es el modo sombra global (D-A12): no lo apagues el mismo día.

# 7. Leer /anuncios/historial: ver qué HABRÍA hecho el motor.

# 8. Recién ahí, apagar force_dry_run. A partir de este momento el módulo
#    empieza a actuar de verdad.
```

El paso 0 es el que más frustración evita: prender todo, ver que la escalera no
sube nada, y tardar en darse cuenta de que las decisiones salían omitidas con
`tope_absoluto`. El default de €200 es deliberadamente bajo (D-A9c); la regla
«Duplicar a $150» del seed entra justo abajo.

---

## 2. Apagar todo, ya

Dos niveles, en orden:

```bash
# 1. El freno de mano: el worker deja de hacer TODO en el tick siguiente.
#    Ni sync, ni insights, ni escrituras. Cero llamadas a Meta.
docker exec panel-db-1 psql -U panel -d panel -c \
  "UPDATE settings SET value='false'::jsonb WHERE key='ads_rules_enabled';"

# 2. Plan B: si necesitás que el proceso directamente no exista.
pm2 stop panel-reglas
```

Con `ads_rules_enabled=false` el worker sigue vivo (lo podés ver en `pm2 list`),
pero loguea "apagado" cada tick y no habla con Meta. Si querés frenar también
las acciones MANUALES del gestor, no hay interruptor: son personas apretando un
botón a propósito (D-A12c). Lo que las frena es el techo absoluto, sin
excepción.

---

## 3. Qué mirar cuando algo raro pasa

En este orden:

```bash
pm2 logs panel-reglas --lines 80 --nostream

docker exec panel-db-1 psql -U panel -d panel <<'SQL'
-- Qué corrió y con qué resultado
SELECT rule_id, started_at, finished_at, objetos_evaluados, objetos_que_cumplen,
       acciones_ejecutadas, acciones_simuladas, omitidas, error
  FROM ad_rule_runs ORDER BY started_at DESC LIMIT 20;

-- Qué acciones fallaron
SELECT * FROM ad_actions WHERE ok = false ORDER BY created_at DESC LIMIT 20;

-- El último error de cada regla
SELECT id, name, last_run_at, last_run_error FROM ad_rules WHERE enabled;

-- Si el backoff está frenando el tick
SELECT key, value FROM settings WHERE key LIKE 'ads_backoff%' ORDER BY key;

-- Si el worker está vivo
SELECT value FROM settings WHERE key = 'ads_worker_last_tick';
SQL
```

`ads_worker_last_tick` tiene que estar a menos de un minuto de `now()`. Si se
atrasa, el cron de respaldo (`--health`, cada 30 min) manda un aviso por
Telegram.

---

## 4. Los errores de Meta que se van a ver

| Código | Qué significa | Qué hacer |
|---|---|---|
| `190` | token vencido o revocado | rotar el token en Meta, subirlo al `.env.production`, redeploy (o correr `npm run ads:token`) |
| `200` | sin permiso (`ads_management`) | el usuario del sistema no tiene la cuenta asignada con rol de administrador |
| `17` / `613` | límite de cuota alcanzado | el worker ya se autofrena (backoff). Subí `ads_insights_ttl_seconds` si es recurrente |
| `100` | presupuesto inválido o bajo el mínimo | la regla pidió un importe que Meta rechaza; mirá la `explicacion` en el historial |

El `17`/`613` con subcódigo `2446079`/`1487742` es el "user request limit" /
"too many calls": es el que el backoff de D-A14 reconoce y castiga duplicando el
freno en cada reincidencia.

---

## 5. Cómo revertir una acción de una regla

**No hay undo.** Se lee la `explicacion` y el `before_value` de `ad_actions` y
se restaura a mano desde el gestor (`/anuncios`):

```bash
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT created_at, rule_name, object_name, action, before_value, after_value,
          estado, explicacion FROM ad_actions ORDER BY created_at DESC LIMIT 20;"
```

El caso que hay que saber leer: una fila con `estado = 'indeterminado'`
significa que el POST cortó por timeout y **no se sabe si se aplicó**. No la
revirtas a ciegas: el reconciliador le pregunta a Meta en el tick siguiente y la
cierra. Si tenés que actuar antes, mirá el objeto en el administrador de
anuncios de Meta, no en el panel.

---

## 6. Límites conocidos y rotación del bot token

Límites que ya se saben, para no volver a investigarlos:

- **El gasto tiene el lag de Meta y las ventas el del webhook de Shopify.** Los
  números de Anuncios no van a coincidir exactamente con los de Ventas.
- **El día se corta en la zona de la cuenta, no en la del funnel** (D-A10).
- **El gasto que Meta corrige a la baja no se limpia** (P-A07): `syncAdSpend`
  no pone en cero una fila que dejó de venir, así que las reglas de 7 días
  pueden ver plata que ya no existe.
- **Una regla no puede abarcar cuentas en zonas horarias distintas** (P-A09):
  se omite con `zonas_horarias_mezcladas` en lugar de calcular mal.
- **Sólo cuentas en EUR y sólo presupuesto diario** (D-A10). El presupuesto
  total se ve pero no se automatiza.
- **Un lote no es atómico** (§6c del plan): si 3 de 10 acciones fallan, 7
  quedaron aplicadas.
- **El panel no sabe quién hizo cada cosa** (P-A12): contraseña compartida, sin
  roles. `actor_hint` guarda IP y request id, no una identidad.
- **La versión de la Graph API** (P-A10): `v21.0` muere alrededor de principios
  de 2027. Se cambia con `META_API_VERSION`; subirla NO es cambiar el prefijo de
  la URL.

**Rotación del bot token de Telegram.** El token queda en texto plano en la
base, así que también en los dumps de `pg_dump` de `/srv/panel/backups` (se
retienen 14 días). Para rotarlo: revocá el bot en @BotFather (o generá un token
nuevo con `/revoke`), y volvé a correr `npm run ads:telegram`. El riesgo de un
token filtrado es acotado (alguien manda mensajes al chat), pero la rotación es
un comando.
