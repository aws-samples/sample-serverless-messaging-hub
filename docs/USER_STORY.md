# User Story — Messaging Hub

## Épica

**MH-0 — Hub de mensajería multicanal serverless**

> Como **equipo de plataforma**, quiero un **servicio central de mensajería basado en
> eventos** que entregue notificaciones por **email y SMS**, para que cualquier producto
> de la organización pueda **enviar comunicaciones transaccionales** publicando un evento,
> sin implementar la lógica de envío ni gestionar plantillas por su cuenta.

---

## Historia principal

**MH-1 — Enviar una notificación transaccional publicando un evento**

> **Como** producto consumidor (p. ej. un backend de aplicación),
> **quiero** publicar un único evento en un bus central indicando el canal, el producto,
> la funcionalidad, el idioma y el destinatario,
> **para que** el usuario final reciba el mensaje correcto, en su idioma y con su
> contenido personalizado, sin que yo tenga que conocer SES, SNS ni las plantillas.

### Contexto de negocio

- Múltiples productos/tenants necesitan enviar correos y SMS transaccionales
  (bienvenidas, restablecimiento de contraseña, notificaciones operativas).
- Duplicar la integración con SES/SNS en cada producto genera inconsistencia y costo.
- Se busca **desacoplar** al emisor (publica un evento) del canal de entrega
  (lo resuelve el hub), con **resiliencia** (reintentos + DLQ) y **observabilidad**.

### Contrato del evento (entrada)

Evento de EventBridge con `source = "eventbridge.messages"` y `detail-type = "email" | "sms"`.
El objeto `detail` gobierna el enrutamiento y el render:

| Campo | Email | SMS | Descripción |
|-------|:-----:|:---:|-------------|
| `idempotencyKey` | ✅ | ✅ | **Obligatorio.** ID inmutable y único por mensaje (`[A-Za-z0-9_-]`, máx 256); dirige dedup y correlación de auditoría |
| `product` | ✅ | ✅ | Producto/tenant (clave de partición en DynamoDB) |
| `channel` | ✅ | ✅ | `email` o `sms` |
| `feature` | ✅ | ✅ | Funcionalidad, p. ej. `welcome` |
| `language` | ✅ | ✅ | Idioma, p. ej. `en`, `es` |
| `mail` | ✅ | — | Un email **o** una lista de emails |
| `phoneNumber` | — | ✅ | En formato E.164 |
| claves extra | ✅ | ✅ | Se pasan a la plantilla Handlebars (`{{name}}`, …) |

---

## Criterios de aceptación (Gherkin)

### CA-1 — Enrutamiento por canal
```
Dado un evento con source "eventbridge.messages" y detail-type "email"
Cuando se publica en el bus central
Entonces la regla de email lo entrega a la cola SQS de email
Y el evento con detail-type "sms" es entregado a la cola SQS de SMS
```

### CA-2 — Envío de email con plantilla personalizada
```
Dado un ítem de configuración en DynamoDB para product/channel/feature/language
Y una plantilla HTML almacenada en S3 referenciada por su atributo "templatePath"
Cuando el Lambda de email procesa el mensaje
Entonces renderiza la plantilla con Handlebars usando los datos del "detail"
Y envía el correo por SES desde el "source" configurado
Y el "subject" del evento tiene prioridad sobre el "subject" de la configuración
```

### CA-3 — Envío de SMS transaccional
```
Dado un ítem de configuración en DynamoDB con la plantilla de texto inline
Cuando el Lambda de SMS procesa el mensaje
Entonces renderiza el texto con Handlebars
Y publica el SMS por SNS con MessageAttribute SMSType = "Transactional"
Y adjunta un Sender ID solo si está configurado (SMS_SENDER_ID)
```

### CA-4 — Múltiples destinatarios de email
```
Dado un evento de email cuyo campo "mail" es una lista de correos válidos
Cuando se valida el payload
Entonces la validación es exitosa
Y SES recibe todos los destinatarios en ToAddresses
```

### CA-5 — Validación de payload
```
Dado un evento cuyo "detail" no cumple el esquema (campo faltante o email inválido)
Cuando el Lambda valida el payload con Zod
Entonces lanza un error de negocio (BAD_REQUEST) y no intenta el envío
```

### CA-6 — Resiliencia: reintentos y DLQ
```
Dado un mensaje cuyo procesamiento falla
Cuando el Lambda retorna error
Entonces el mensaje regresa a la cola y se reintenta
Y tras 3 recepciones fallidas (maxReceiveCount) se mueve a la DLQ del canal
```

### CA-7 — Plantilla o configuración ausente
```
Dado un evento de email sin ítem en DynamoDB o sin "templatePath" válido
Cuando el Lambda intenta resolver la configuración
Entonces lanza un error descriptivo (no envía)
Y el mensaje termina en la DLQ tras agotar los reintentos
```

### CA-8 — Portabilidad (reproducible en cualquier cuenta/organización)
```
Dado un archivo env/env-<stage>.yml con "organization" y "appName"
Cuando se sintetiza o despliega el stack
Entonces todos los recursos se nombran "${organization}-${environment}-${appName}-..."
Y la ruta SSM de la cuenta se deriva como "/${appName}/${environment}/account"
Y los valores de los tags Product/Owner se toman del YAML
Y la observabilidad (retención de logs, nivel, logEvent, tracing), los umbrales de alarma
     y el umbral de failover se toman del YAML, no del código
Y no existe ningún nombre de organización, producto o dominio hardcodeado en el código
```

### CA-9 — Seguridad de datos (PII)
```
Dado que los mensajes contienen PII (emails, teléfonos, nombres)
Cuando se crean las colas SQS
Entonces todas (incluidas las DLQ) tienen cifrado en reposo SSE-SQS
Y exigen TLS en tránsito (enforceSSL)
Y el bucket S3 bloquea todo acceso público y usa cifrado SSE-S3
```

### CA-10 — Observabilidad y alertas
```
Dado el sistema desplegado
Cuando un mensaje cae en una DLQ, o un Lambda reporta errores/throttles,
     o el mensaje más antiguo de una cola supera 5 minutos
Entonces se dispara una alarma de CloudWatch (8 por región)
Y se notifica por email vía un topic SNS (destinatario configurable)
Y la alarma también notifica al volver a estado OK
Y los umbrales y periodos provienen de "monitoring.alarms" del YAML del entorno
Y cada función escribe en su propio Log Group gestionado, con la retención de
     "observability.logRetentionDays" (3 meses por defecto)
Y el tracing X-Ray está activo cuando "observability.tracing" es true, de modo que
     Powertools Tracer emita segmentos reales
```

### CA-11 — Idempotencia (sin envíos duplicados)
```
Dado un evento con un "idempotencyKey" (obligatorio, [A-Za-z0-9_-], máx 256)
Cuando llega un duplicado dentro de la ventana TTL (reintento, replay o failover)
Entonces el envío se ejecuta UNA sola vez (guard INPROGRESS→COMPLETED con Powertools)
Y el TTL se toma de la plantilla ("idempotencyTtlSeconds", default 1 día)
Y un evento sin "idempotencyKey" válido falla la validación y va a la DLQ
```

### CA-12 — Auditoría y no repudio
```
Dado un envío exitoso
Entonces se registra la ACEPTACIÓN (providerMessageId, destinatario hasheado) en Parquet
Y los eventos de SES (send/delivery/bounce/complaint/reject) se archivan en JSON crudo
     (JSON Lines sin comprimir) vía Configuration Set, correlacionados por el tag "idempotencyKey"
Y en PRODUCCIÓN el bucket de auditoría es inmutable (Object Lock WORM, modo COMPLIANCE);
     en dev/qa se capturan los mismos registros sin inmutabilidad
Y todo es consultable con Athena
Y el archivado es best-effort (nunca provoca un reenvío)
```

### CA-13 — Multi-región (tolerancia a fallos regional)
```
Dado "secondaryRegion" configurado en el YAML
Cuando se despliega el stack a ambas regiones
Entonces existe un EventBridge Global Endpoint con replicación de eventos
Y las tablas DynamoDB son Global Tables (réplica en la secundaria)
Y una alarma de IngestionToInvocationStartLatency (>30s durante 5 min) vía Route 53 health check
     dispara el failover a la región secundaria
Y con "secondaryRegion" vacío el comportamiento es single-región (sin cambios)
```

> Estado de la configuración commiteada: multi-región está habilitado en **dev**
> (`secondaryRegion: us-west-2`); qa y prod están en single-región. Es un eje opt-in
> independiente de `retainData` y `audit.worm`.

---

## Requisitos no funcionales

| Categoría | Requisito |
|-----------|-----------|
| **Arquitectura** | Serverless, dirigida por eventos; canales email y SMS **independientes** (cola + DLQ + Lambda por canal) para aislamiento de fallos y escalado por canal. |
| **Rendimiento** | Lambdas Node.js 22 sobre **arm64**; `batchSize = 1` para semántica de reintento por mensaje. |
| **Seguridad** | Cifrado en reposo/tránsito (ver CA-9); IAM de mínimo privilegio por Lambda: SES acotado a `identity/*` + `configuration-set/*` de la cuenta/región, S3 `GetObject` solo al bucket de plantillas, DynamoDB de solo lectura (plantillas) y lectura/escritura (idempotencia), Firehose solo al stream de auditoría. `sns:Publish` y X-Ray quedan en `*` por limitación de esas APIs (el SMS directo no tiene ARN de recurso). |
| **Observabilidad** | Logging estructurado (Powertools `Logger`) en un Log Group **gestionado por CloudFormation** por función, con retención de 3 meses; tracing con Powertools `Tracer` + **X-Ray active tracing**; alarmas + SNS. |
| **Portabilidad** | Sin branding en código; toda la configuración por entorno en YAML (incluidos los valores de tags); account ID resuelto desde SSM con ruta derivada de `appName`. |
| **Resiliencia** | DLQ por canal; visibility timeout alineado al timeout del Lambda (30s). |
| **Idempotencia** | `idempotencyKey` obligatorio; dedup con DynamoDB + Powertools, TTL por plantilla (default 1 día). |
| **No repudio** | Auditoría: aceptación en Parquet + eventos SES en JSON (sin comprimir); Athena. Inmutabilidad WORM (Object Lock, COMPLIANCE) solo en **prod**. |
| **Multi-región** | Opt-in vía `secondaryRegion`: Global Endpoint + Global Tables + failover por health check. |
| **Costo** | SSE-SQS (sin costo por request de KMS); S3 SSE-S3; DynamoDB on-demand (PAY_PER_REQUEST); retención de logs a 3 meses. Ver `cost.md`. |

---

## Fuera de alcance (de esta historia)

- Salida del sandbox de SES / verificación de dominio (procedimiento operativo documentado).
- Lista de supresión de bounces/complaints de SES (los eventos ya se capturan; falta la supresión automática).
- Dashboard de CloudWatch; regla explícita de sampling de X-Ray; conversión a Parquet de `ses_events`; CRR a bucket central.
- Canales adicionales (push, WhatsApp, etc.).

---

## Supuestos y dependencias

- Existe un parámetro SSM en `/{appName}/{environment}/account` con el AWS Account ID
  destino (o una ruta propia indicada con la clave opcional `account` del YAML).
- La identidad/dominio de envío está verificada en SES para el envío real de correo.
- La tabla DynamoDB se siembra con la configuración de plantillas y S3 con los HTML.

---

## Definition of Done

- [x] El stack **sintetiza** (`cdk synth`) para el entorno objetivo con la cuenta real.
- [x] Enrutamiento email/SMS por `detail-type` mediante reglas de EventBridge → SQS.
- [x] Lambdas de email (SES) y SMS (SNS) con render Handlebars y validación Zod.
- [x] Configuración en DynamoDB + plantillas HTML en S3 (email vía `templatePath`).
- [x] DLQ por canal con `maxReceiveCount = 3`.
- [x] Cifrado PII (SSE-SQS + TLS) y bucket privado (SSE-S3, BLOCK_ALL).
- [x] Monitoreo: SNS + alarmas (DLQ, errores/throttles de Lambda, edad de cola).
- [x] Log Group gestionado por función con retención de 3 meses + X-Ray active tracing.
- [x] IAM de mínimo privilegio con SES acotado por ARN de identidad.
- [x] Idempotencia: `idempotencyKey` + DynamoDB + Powertools con TTL por plantilla.
- [x] Auditoría/no repudio: aceptación en Parquet + eventos SES en JSON, Athena; bucket WORM (COMPLIANCE) en prod.
- [x] Multi-región (opt-in): Global Endpoint + Global Tables + failover por health check.
- [x] Portabilidad: sin branding en código; `organization`/`appName` por YAML.
- [x] **Pruebas**: unitarias de Lambda (Zod, plantillas SES, Handlebars, SMS, idempotencia, auditoría) e infra CDK (assertions).
- [x] **Documentación**: README + `compliance.md`, `idempotency-and-audit.md`, `cost.md`, `e2e-evidence.md`.

---

## Desglose en historias habilitadoras

Orden de implementación sugerido:

| ID | Historia habilitadora | Entregable en el repo |
|----|-----------------------|-----------------------|
| MH-1.1 | Bus central de eventos | `lib/event-bridge/buses.ts` |
| MH-1.2 | Reglas de enrutamiento + colas + DLQ + Lambdas | `lib/event-bridge/message-rules.ts` |
| MH-1.3 | Almacén de configuración de plantillas | `lib/databases/dynamodb.ts` |
| MH-1.4 | Almacén de plantillas HTML | `lib/buckets/buckets.ts` |
| MH-1.5 | Handler + validación + render (email) | `src/aws-lambdas/src/controllers/SendEmailController.ts`, `services/SendEmailService.ts`, `utils/SESConfig.ts` |
| MH-1.6 | Handler + validación + render (SMS) | `src/aws-lambdas/src/controllers/SendSmsController.ts`, `services/SendSmsService.ts` |
| MH-1.7 | Esquemas de validación | `src/aws-lambdas/src/libs/validators/RequestValidator.ts` |
| MH-1.8 | IAM de mínimo privilegio | `lib/iam/policies.ts` |
| MH-1.9 | Monitoreo (SNS + alarmas + logs + tracing) | `lib/monitoring/monitoring.ts`, `lib/utils/lambda-commons.ts` |
| MH-1.10 | Portabilidad (config por entorno) | `env/*.yml`, `bin/cdk.ts`, `lib/utils/*` |
| MH-1.11 | Pruebas (infra + Lambda) | `test/infra.test.ts`, `src/aws-lambdas/test/*.test.ts` |
| MH-1.12 | Idempotencia (dedup + TTL por plantilla) | `lib/databases/dynamodb.ts`, `src/aws-lambdas/src/libs/functions/Idempotency.ts` |
| MH-1.13 | Auditoría / no repudio (WORM + Firehose + Glue + SES config set) | `lib/audit/audit.ts`, `src/aws-lambdas/src/libs/functions/Audit.ts` |
| MH-1.14 | Multi-región (Global Endpoint + Global Tables) | `lib/global-endpoint/global-endpoint.ts`, `bin/cdk.ts` |

---

## Estimación

- **Épica MH-0:** ~34 puntos (XL).
- **Historia MH-1:** desglosable en las historias habilitadoras MH-1.1 … MH-1.14
  (base MH-1.1–1.11 ~13 pts; idempotencia/auditoría/multi-región MH-1.12–1.14 ~21 pts).
