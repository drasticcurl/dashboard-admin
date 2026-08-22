# Requirements Document

## Introduction

El gestor de anuncios tiene tres síntomas que se reportaron como bugs separados —"editar presupuesto da error required", "activar conjunto no activa nada", "cambio algo en Facebook y el panel sigue igual"— pero que comparten una causa de fondo: **el panel decide y muestra el estado de los objetos de Meta leyendo una copia local que puede estar arbitrariamente vieja, sin ninguna señal de que lo está.**

El objetivo de este spec es que el panel no pueda afirmar en pantalla algo que no pasó en Meta, que un dato viejo sea visible como viejo, y que refrescar refresque todo lo que la pantalla muestra y no sólo el gasto.

### Alcance

Entra: el camino de escritura de presupuesto y estado desde el gestor, la frescura de la Jerarquía en el camino en vivo, el tratamiento de los objetos que Meta deja de devolver, el orden entre sync y lectura en el endpoint de datos, y los totales de la barra de KPIs.

No entra: el motor de reglas automáticas, la duplicación, el renombrado y la programación de inicio. Comparten el Endpoint_Acciones y se benefician de los arreglos, pero sus requisitos propios no se tocan acá.

## Verificaciones realizadas

Contra el sistema real (VPS de producción, lecturas solamente) y contra el código:

1. **El cron de Sync_Jerarquia sí está instalado y funciona.** Corre cada 15 minutos y el log muestra corridas exitosas (`284 conjuntos traídos · 284 guardados`). La hipótesis de que nunca corría quedó descartada.
2. **El presupuesto nunca llega a Meta.** No existe ni una fila `source = manual` con `action = budget_set` en `ad_actions`. El rechazo ocurre en la validación del route, antes de abrir la fila de auditoría. El `Required` que se ve es el mensaje de zod, porque el payload se arma desde `confirmacion.params.budgetEur`, que en el camino de la barra de lote es `undefined`.
3. **El toggle sí escribe en Meta y Meta confirma.** Hay tres filas `source = manual`, `action = activate`, `estado = confirmado`, `PAUSED → ACTIVE`. El camino de escritura funciona: lo que está roto es la dirección de la acción, la reversión del Pintado_Optimista y el mensaje que se muestra.
4. **El toggle se dispara dos veces sobre el mismo objeto.** Dos filas `activate confirmado` sobre el mismo conjunto separadas por un segundo (12:59:40 y 12:59:41). No hay guarda de pedido en vuelo por fila.
5. **Hay objetos indefinidamente viejos.** 34 de 326 conjuntos, 13 de 216 campañas y 38 de 505 anuncios no se refrescan desde hace más de 20 minutos, y el más viejo tiene **5 días y 17 horas**. Son los que la Sync_Jerarquia cuenta como `desaparecidos`: Meta dejó de devolverlos, el sync los deja intactos sin marcarlos, y el panel los dibuja como si fueran actuales.
6. **La hipótesis de la moneda quedó descartada.** Las dos cuentas activas tienen `currency = EUR` poblada, así que la conversión es la identidad y `spend_eur` no puede quedar en `NULL` por falta de cotización. El gasto que baja no viene de ahí.
7. **Las dos cuentas usan presupuesto por conjunto (ABO).** `budget_level = 'adset'` en todas las campañas y `ad_campaigns.daily_budget` en `NULL`. Por eso a nivel campaña ninguna celda de presupuesto es editable, y el mensaje que muestra dice "el presupuesto se maneja en la campaña" cuando la realidad es la inversa.
8. **Los totales de la barra de KPIs se calculan sobre la página visible**, no sobre el total del filtro: `data.filas.reduce(...)`. Con 505 anuncios y un tope de 500 filas por página, el total de gasto a nivel anuncio no incluye todas las filas.

## Glossary

- **Jerarquía**: la copia local de campañas, conjuntos y anuncios de Meta, con nombres, estados y presupuestos. Vive en `ad_campaigns`, `ad_sets` y `ads`. Es lo que la tabla del gestor dibuja.
- **Sync_Jerarquia**: la sincronización que trae la Jerarquía desde Meta. Su único disparador automático es un cron cada 15 minutos.
- **Sync_Gasto**: la sincronización que trae Insights y escribe `ad_spend`. Corre en el render, en el Boton_Actualizar y en el polling.
- **Objeto_Desaparecido**: un objeto que existe en la Jerarquía local pero que Meta dejó de devolver en la última corrida de Sync_Jerarquia. Hoy queda con sus datos viejos y sin ninguna marca.
- **Frescura_Objeto**: la antigüedad del dato de un objeto individual, derivada de su `synced_at`. Distinta de la frescura de la cuenta.
- **Boton_Actualizar**: el control de la barra de frescura que fuerza una sincronización ignorando el TTL.
- **Marca_Frescura**: el texto que informa la antigüedad de los datos sincronizados.
- **Endpoint_Acciones**: `POST /api/ads/acciones`, el único camino de escritura hacia Meta desde el panel.
- **Preflight**: la revalidación que corre en el Endpoint_Acciones contra la base y la configuración antes de cualquier escritura, y que puede omitir objetos.
- **Previsualizacion**: el cálculo de antes y después por objeto que se muestra en el diálogo de confirmación, y que el servidor recalcula con el mismo módulo.
- **Omisión**: la decisión del Preflight de no llamar a Meta para un objeto. Se registra en la auditoría y no es un fallo.
- **Resultado_Indeterminado**: el desenlace de una escritura que pudo haberse aplicado en Meta sin que el panel lo sepa, por timeout o corte de red.
- **Pintado_Optimista**: el cambio inmediato de una fila en pantalla antes de que el servidor confirme, usado por el interruptor de estado.
- **Seleccion_Activa**: el conjunto de objetos tildados sobre el que operan las acciones de lote.
- **Techo_Absoluto**: el máximo de presupuesto diario por objeto que la configuración permite.
- **Discrepancia**: la situación en la que el estado o el presupuesto de la Jerarquía no coincide con el que Meta reporta para el mismo objeto.

## Requirements

### Requirement 1: El presupuesto que se manda es el que el usuario escribió

**User Story:** Como operador del panel, quiero que al fijar un presupuesto diario se aplique el importe que escribí en el diálogo, para no recibir un error de validación por un campo que sí completé.

#### Acceptance Criteria

1. CUANDO el usuario abre el diálogo de presupuesto desde la barra de selección, escribe un importe válido y confirma, ENTONCES el sistema DEBE enviar ese importe en el campo `budgetEur` del pedido al Endpoint_Acciones.
2. CUANDO el usuario abre el diálogo de presupuesto desde la celda de una fila con un importe ya cargado, ENTONCES el sistema DEBE precargar el campo del diálogo con ese importe, y la Previsualizacion DEBE mostrar el valor "después" en lugar de un guion.
3. CUANDO el usuario modifica el importe dentro del diálogo, ENTONCES el sistema DEBE enviar el último valor mostrado en el campo, sin importar por qué camino se abrió el diálogo.
4. MIENTRAS el campo de importe esté vacío o tenga un valor que no cumpla la regla de validez del formulario, el sistema DEBE mantener deshabilitado el botón de ejecutar.
5. El sistema DEBE usar la misma regla de validez en el formulario y en la habilitación del botón, de forma que un importe que el formulario marca inválido no pueda llegar al Endpoint_Acciones.
6. CUANDO el Endpoint_Acciones rechaza un importe por su forma, ENTONCES el mensaje que se muestra DEBE nombrar el campo y la regla incumplida, y no puede ser un mensaje genérico de la librería de validación.
7. CUANDO una celda de presupuesto no es editable, ENTONCES el motivo que se muestra DEBE nombrar el nivel donde el presupuesto vive realmente, y no puede afirmar que vive en la campaña cuando vive en el conjunto.

### Requirement 2: El toggle de estado no puede afirmar un cambio que no ocurrió

**User Story:** Como operador del panel, quiero que el interruptor de activar y pausar refleje lo que realmente quedó en Meta, para no creer que activé un conjunto que sigue apagado.

#### Acceptance Criteria

1. CUANDO el usuario acciona el interruptor de una fila, ENTONCES la acción enviada DEBE derivarse del mismo valor con el que el interruptor se dibuja, de forma que una fila pintada como apagada siempre pida activar y una pintada como encendida siempre pida pausar.
2. CUANDO el estado del objeto es desconocido, ENTONCES el sistema DEBE poder pedir la activación, y no puede quedar en un estado donde el único pedido posible sea pausar.
3. CUANDO el pedido devuelve un resultado distinto de confirmado, ENTONCES el sistema DEBE devolver la fila al valor que tenía antes del Pintado_Optimista.
4. CUANDO el servidor omite el objeto sin llamar a Meta, ENTONCES el sistema DEBE mostrar el motivo de la Omisión en castellano, y no puede mostrar un mensaje construido con el código de estado HTTP.
5. CUANDO el pedido falla con un error de validación o de Preflight, ENTONCES el sistema DEBE mostrar el detalle que devuelve el endpoint, con el mismo criterio que ya usa la ejecución de lote.
6. El sistema NO DEBE mostrar nunca un aviso de error cuyo texto sea un código de estado exitoso.
7. CUANDO el resultado es Resultado_Indeterminado, ENTONCES el sistema DEBE decir que no se sabe si el cambio se aplicó, y no puede presentarlo ni como éxito ni como fallo.
8. MIENTRAS haya un pedido de cambio de estado en vuelo para una fila, el sistema DEBE ignorar nuevas acciones sobre el interruptor de esa misma fila, de forma que dos clicks seguidos no produzcan dos escrituras a Meta.

### Requirement 3: Un dato viejo se ve viejo

**User Story:** Como operador del panel, quiero distinguir las filas cuyo dato está desactualizado, para no tomar decisiones de plata sobre un estado que Meta ya no confirma.

#### Acceptance Criteria

1. CUANDO la Frescura_Objeto de una fila supera un umbral configurable, ENTONCES la tabla DEBE señalar esa fila como desactualizada e informar su antigüedad.
2. CUANDO Meta deja de devolver un objeto que existe en la Jerarquía, ENTONCES la Sync_Jerarquia DEBE registrar esa condición en el objeto, y no puede dejarlo indistinguible de uno recién confirmado.
3. La pantalla DEBE poder informar cuántos objetos del filtro vigente están desactualizados.
4. CUANDO el usuario intenta una acción de escritura sobre un Objeto_Desaparecido, ENTONCES el sistema DEBE advertirlo antes de ejecutar.
5. El sistema NO DEBE borrar automáticamente un Objeto_Desaparecido, porque puede tener gasto histórico atribuido y su desaparición puede ser transitoria.
6. CUANDO un Objeto_Desaparecido vuelve a aparecer en una corrida de Sync_Jerarquia, ENTONCES el sistema DEBE quitarle la marca.

### Requirement 4: Refrescar refresca todo lo que la pantalla muestra

**User Story:** Como operador del panel, quiero que al apretar Actualizar el panel traiga de Meta también los estados y los presupuestos, para no tener que esperar hasta 15 minutos después de tocar el administrador de anuncios.

#### Acceptance Criteria

1. CUANDO el usuario usa el Boton_Actualizar en el gestor de anuncios, ENTONCES el sistema DEBE refrescar desde Meta los estados, los presupuestos y los nombres de la cuenta vigente, además del gasto.
2. El sistema DEBE aplicar a la Sync_Jerarquia en vivo un freno propio, independiente del freno del gasto, de forma que apretar el botón repetidamente no multiplique las llamadas a Meta.
3. El sistema DEBE aplicar a la Sync_Jerarquia en vivo un presupuesto de espera, y CUANDO ese presupuesto se agota, ENTONCES DEBE dibujar la pantalla con lo último guardado en lugar de quedarse esperando.
4. CUANDO la Sync_Jerarquia en vivo falla, ENTONCES la pantalla DEBE seguir funcionando con los datos guardados y DEBE informar que la Jerarquía puede estar atrasada.
5. La pantalla DEBE exponer la antigüedad de la Jerarquía de forma distinguible de la del gasto, porque son dos sincronizaciones distintas que se atrasan de forma independiente.
6. El cron de Sync_Jerarquia DEBE seguir existiendo y no puede quedar reemplazado por el refresco del render, porque cubre las horas en las que nadie tiene el panel abierto.
7. CUANDO el usuario cambia el estado o el presupuesto de un objeto desde el panel, ENTONCES la fila de ese objeto DEBE quedar con el valor que confirmó Meta sin depender del próximo cron.
8. El polling automático NO DEBE disparar una Sync_Jerarquia, para no multiplicar por pestaña abierta un sync que es una llamada por cuenta y por nivel.

### Requirement 5: El endpoint de datos sincroniza antes de leer

**User Story:** Como operador del panel, quiero que la respuesta de un refresco contenga los datos que ese refresco trajo, para no ver siempre la foto anterior.

#### Acceptance Criteria

1. CUANDO un pedido al endpoint de datos dispara un sync, ENTONCES la respuesta DEBE construirse con los datos posteriores a ese sync.
2. CUANDO el sync no termina dentro de su presupuesto de espera, ENTONCES la respuesta DEBE construirse con los datos guardados e informar que el sync quedó en curso.
3. Los comentarios del endpoint DEBEN describir el orden real de las operaciones.
4. CUANDO llegan al cliente varias respuestas del endpoint de datos fuera de orden, ENTONCES el sistema DEBE descartar las que correspondan a un pedido anterior al último emitido, de forma que una respuesta vieja no pueda sobrescribir datos más nuevos en pantalla.

### Requirement 6: Una Discrepancia entre la copia local y Meta se informa, no se esconde

**User Story:** Como operador del panel, quiero que cuando el panel decide no hacer nada porque cree que el objeto ya está en ese estado me lo diga con esas palabras, para saber que el problema es un dato viejo y no un botón roto.

#### Acceptance Criteria

1. CUANDO el Preflight omite un objeto porque su copia local ya está en el estado pedido, ENTONCES el sistema DEBE informarlo con un mensaje que nombre esa razón y la antigüedad del dato con el que se decidió.
2. CUANDO el usuario pide activar o pausar un objeto cuya Frescura_Objeto supera un umbral definido, ENTONCES el sistema DEBE releer ese objeto contra Meta antes de decidir si la acción se omite.
3. CUANDO el estado real en Meta difiere del que la copia local tenía al momento de decidir, ENTONCES el sistema DEBE ejecutar la acción según el estado real y DEBE registrar la Discrepancia en la auditoría.
4. CUANDO se activa un conjunto cuyo objeto padre está pausado, ENTONCES el sistema DEBE avisar que el conjunto no va a entregar hasta que el padre se active, y DEBE distinguir ese caso de un fallo de la acción.
5. Toda acción que no llegó a llamar a Meta DEBE quedar distinguible en la auditoría de una que sí llamó y fue rechazada.

### Requirement 7: Los totales de la barra de KPIs dicen sobre qué están calculados

**User Story:** Como operador del panel, quiero que el total de gasto no cambie según la página en la que estoy, para no interpretar un cambio de paginación como una caída de gasto.

#### Acceptance Criteria

1. CUANDO el resultado del filtro vigente no entra en una sola página, ENTONCES el total de gasto que se muestra DEBE corresponder al filtro completo y no sólo a las filas visibles.
2. SI un total se calcula sobre un subconjunto de las filas del filtro, ENTONCES la pantalla DEBE decir explícitamente sobre qué está calculado.
3. CUANDO el usuario cambia de página sin cambiar los filtros, ENTONCES los totales de la barra de KPIs NO DEBEN cambiar.
4. El sistema DEBE calcular los totales de forma que un cambio de estado de un objeto no altere el total de gasto del período, porque el gasto ya ocurrido no depende del estado actual del objeto.
