# Wealth

Panel local de cuentas personales de MyInvestor, Trade Republic, Santander y Revolut en España. La portada muestra datos ficticios hasta que configuras Enable Banking o guardas la primera consulta a MyInvestor. Los saldos reales se agrupan por divisa y el gráfico conserva los saldos observados en cada actualización. El historial de movimientos contables abarca hasta 90 días, según lo que comunique cada entidad.

## Arranque

En este Mac, pulsa **Wealth** en el Dock. El lanzador de la carpeta de aplicaciones del usuario inicia el servidor cuando hace falta y abre el panel en el navegador predeterminado. También funciona después de reiniciar el Mac.

Con Node.js 22 o posterior instalado, ejecuta `npm start` desde esta carpeta y abre [Wealth](http://127.0.0.1:4317). No necesita instalar dependencias. Usa `npm test` para ejecutar las pruebas con respuestas del proveedor simuladas.

## Consultar MyInvestor desde Wealth

1. Abre **Resumen → MyInvestor → Consultar MyInvestor**. Introduce tu documento y contraseña en Wealth, en el Mac donde se ejecuta el servidor.
2. Si MyInvestor envía un SMS de inicio de sesión, introduce los seis dígitos en la misma ventana. Si el banco exige un captcha u otro método que Wealth no admite, la consulta termina y se conserva la última cartera.
3. Revisa las participaciones de tus fondos y el efectivo disponible. Pulsa **Guardar consulta** para actualizar el resumen. Cada cuenta de efectivo aparece por separado de los fondos. **Cancelar** descarta la revisión.
4. En **Inversión** verás el valor estimado en euros del conjunto de tus fondos. Cada fila muestra las participaciones totales del fondo, su valoración, la fecha del precio cuando la facilita el banco y su peso en la cartera. El efectivo se consulta en **Mis cuentas**.

Wealth envía las credenciales directamente desde su servidor local a `https://api.myinvestor.es`. La contraseña, el código SMS y los tokens bancarios se usan en memoria. La sesión de acceso solo sirve para esa consulta. Cada actualización directa requiere que inicies sesión. La tarea semanal omite esta conexión porque el inicio de sesión es puntual. Esta conexión utiliza la interfaz de clientes del banco y puede necesitar adaptaciones si MyInvestor la cambia.

## Fondos de MyInvestor

En **Resumen → MyInvestor** puedes ver las participaciones guardadas, su valoración y el efectivo. Pulsa **Consultar MyInvestor** para obtener los datos del banco.

La lista de fondos procede de las posiciones que comunica el banco para cada perfil.

Wealth obtiene el valor liquidativo en euros y las participaciones de la misma respuesta de posiciones de MyInvestor. Al guardar la consulta, multiplica ambos datos para valorar cada fondo. Si el banco omite el precio en euros o su divisa para un fondo con participaciones, la valoración de ese fondo y el total quedan pendientes. La fecha de consulta indica cuándo se leyeron las posiciones. La fecha del valor liquidativo solo se muestra cuando la facilita MyInvestor.

Las participaciones y las observaciones históricas anteriores siguen guardadas. Para valorar una cartera anterior con precios del banco, realiza una nueva consulta y confirma el resultado.

## Conectar Santander, Revolut y Trade Republic

1. Registra una aplicación personal de producción en el [panel de Enable Banking](https://enablebanking.com/cp/applications) con el servicio de información de cuentas (AIS). Registra exactamente `https://127.0.0.1:4318/callback` como URL de retorno.
2. Puedes generar la clave en el navegador durante el registro. Guarda el archivo PEM y el Application ID. En modo restringido, usa **Activate by linking accounts** en el panel del proveedor para vincular cada cuenta que quieras consultar. [Instrucciones de Enable Banking](https://enablebanking.com/docs/api/linked-accounts/)
3. En Wealth pulsa **Conectar banco**, elige la entidad y entra en **Configurar Enable Banking**. Selecciona el PEM e introduce el ID. Wealth comprueba la aplicación, la URL de retorno y el catálogo AIS para clientes particulares de España.
4. Pulsa **Autorizar en el banco** y completa el consentimiento. Abre el enlace de retorno en el mismo navegador y perfil en el que empezaste. Repite la autorización con las demás entidades.
5. En **Conexiones**, pulsa **Gestionar** para actualizar saldos y movimientos, renovar un acceso caducado o revocar una sesión. La frecuencia y el alcance del acceso dependen del banco.

El acceso cubre las cuentas y los saldos que cada banco publica mediante AIS. Puedes consultar las participaciones desde la fila de MyInvestor en **Mis cuentas**.

El retorno bancario utiliza un segundo puerto local con HTTPS. Antes de autorizar el primer banco en macOS, abre [Confiar en Wealth](macos/Confiar%20en%20Wealth.command) para confiar en el certificado del servidor local desde tu llavero de usuario. El certificado es específico de 127.0.0.1 y válido durante un año.

## Deudas del colchón de emergencia

Las salidas contabilizadas de Trade Republic desde el 1 de noviembre de 2026 se registran en **Deudas**. Wealth incorpora los movimientos ya guardados y consulta los nuevos al sincronizar la entidad y durante la actualización de los lunes. Cada salida aparece en el mes siguiente al cargo. La deuda pendiente se conserva aunque el movimiento deje de aparecer en el banco o se desvincule la entidad.

En **Deudas**, selecciona el mes de reposición. Una vez hecha la transferencia desde ocio, pulsa **Pago total** para registrar todo el pendiente o **Pago parcial** para indicar el importe transferido. En un pago parcial, el resto se suma a la reposición del mes siguiente en la misma divisa. El historial muestra cuánto pagaste y cuánto se trasladó al mes siguiente.

## Datos locales

El servidor escucha únicamente en la interfaz de bucle local. Guarda la configuración, las sesiones y los datos bancarios cifrados con AES-256-GCM en `.wealth/`, excluido de Git. La clave de descifrado se conserva en una cookie HttpOnly del perfil del navegador. Si borras esa cookie o cambias de perfil tendrás que configurar y autorizar las cuentas de nuevo. Para revocar el consentimiento antes de borrar las cookies utiliza **Desvincular entidad**. En las conexiones con Enable Banking, las claves y los códigos se introducen en el flujo del banco.

La actualización semanal se programa en Codex los lunes a las 09:00 (hora de Madrid). En este Mac, la tarea ejecuta `node macos/actualizar-saldos.mjs`, que abre Wealth en segundo plano en el navegador predeterminado. Debe usarse el perfil habitual, con su cookie y los consentimientos vigentes. Wealth consulta los saldos de las entidades vinculadas por Enable Banking. Guarda las lecturas en el histórico del día en que se obtienen. Un reintento en la misma semana omite las entidades que ya completaron la actualización.

La sincronización de saldos y movimientos también se realiza al volver de la autorización y al pulsar **Actualizar datos**. Un fallo de lectura se indica en el panel. Los últimos datos válidos se conservan cuando falla una consulta. La evolución comienza con la primera observación y requiere observaciones coincidentes de las cuentas en dos fechas distintas.

La integración sigue la [referencia de la API de Enable Banking](https://enablebanking.com/docs/api/reference/). Los iconos de las entidades corresponden a sus respectivos sitios y la fuente DM Sans se distribuye con su licencia OFL en los recursos de la interfaz.
