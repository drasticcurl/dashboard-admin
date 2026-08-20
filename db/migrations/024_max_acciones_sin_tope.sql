-- 024 — `max_actions_per_object_per_day = 0` significa "sin tope".
--
-- POR QUÉ SE ABRE EL 0
-- La 016 puso el CHECK en `>= 1` con un motivo real: los dos frenos (cooldown y
-- tope por objeto) protegen contra el peor modo de falla del módulo, que es dos
-- reglas peleándose por el mismo conjunto y el reinicio permanente de la fase
-- de aprendizaje de Meta por editar el presupuesto cada minuto. Ese motivo vale
-- para las reglas de PRESUPUESTO, que pueden actuar sobre el mismo objeto una y
-- otra vez.
--
-- Para una regla de pausar no vale, y ahí el freno se da vuelta en contra. Una
-- regla de pausar es idempotente: el motor ya descarta el objeto que está en el
-- estado destino ('ya_esta_en_ese_estado') y el filtro de alcance sólo trae
-- activos, así que no hay bucle posible que haya que frenar. Lo único que puede
-- hacer el tope es que la regla más importante del panel — "apagar lo que gasta
-- sin vender" — se rinda por el resto del día justo cuando hace falta.
--
-- Y hay un agravante: el cupo se cuenta POR OBJETO, no por (regla, objeto)
-- (`historialDeHoy` en lib/ads/reglas/repo.ts filtra sólo por object_id). Las
-- acciones de una regla de presupuesto que escala 25→50→100→200 sobre un
-- conjunto le consumen las cuatro al apagador sobre ESE MISMO conjunto. El
-- resultado es el peor posible: el que sube el presupuesto gasta el cupo y el
-- que apaga se queda afuera.
--
-- El 0 no cambia ningún default: la columna sigue naciendo en 4 y toda regla
-- existente queda como está. Es una opción que antes la base prohibía.
--
-- Compatible hacia atrás (COMO-DEPLOYAR.md): relajar un CHECK no invalida
-- ninguna fila y el código viejo, que nunca escribe 0, sigue funcionando contra
-- este schema.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ad_rules DROP CONSTRAINT IF EXISTS ad_rules_max_objeto_valido;

ALTER TABLE ad_rules
  ADD CONSTRAINT ad_rules_max_objeto_valido
  CHECK (max_actions_per_object_per_day >= 0);

COMMENT ON COLUMN ad_rules.max_actions_per_object_per_day IS
  'Tope de acciones REALES por objeto por día del servidor. 0 = sin tope. Se cuenta por objeto y no por (regla, objeto): las acciones de otra regla sobre el mismo objeto también consumen este cupo.';
