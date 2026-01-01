# KALSHI PERÚ - Documentación de Arquitectura

## Fase 1: Base de Datos y Seguridad

### Índice
1. [Decisiones de Arquitectura](#decisiones-de-arquitectura)
2. [Esquema de Base de Datos](#esquema-de-base-de-datos)
3. [Double-Entry Bookkeeping](#double-entry-bookkeeping)
4. [Estrategia de Encriptación](#estrategia-de-encriptación)
5. [Riesgos y Mitigaciones](#riesgos-y-mitigaciones)

---

## Decisiones de Arquitectura

### ¿Por qué PostgreSQL?

| Criterio | PostgreSQL | MySQL | MongoDB |
|----------|------------|-------|---------|
| Transacciones ACID | ✅ Nativo | ✅ InnoDB | ⚠️ Limitado |
| Tipos de datos | ✅ JSONB, UUID, BYTEA | ⚠️ Básico | ✅ Flexible |
| Concurrencia (MVCC) | ✅ Excelente | ⚠️ Lock-based | ⚠️ Document-level |
| Extensiones | ✅ pgcrypto, uuid-ossp | ❌ Limitado | N/A |
| Integridad referencial | ✅ Robusto | ✅ Aceptable | ❌ Manual |

**Decisión**: PostgreSQL por su soporte robusto de transacciones ACID, crítico para operaciones financieras.

### ¿Por qué TypeScript?

- **Seguridad de tipos**: Detecta errores en tiempo de compilación
- **Autocompletado**: Mejora productividad del desarrollo
- **Documentación implícita**: Los tipos sirven como documentación
- **Mantenibilidad**: Facilita refactorizaciones seguras

### Stack Tecnológico

```
┌─────────────────────────────────────────────────────────────┐
│                         FRONTEND                             │
│                    (React + TypeScript)                      │
├─────────────────────────────────────────────────────────────┤
│                          API                                 │
│              Express.js + TypeScript + Zod                   │
├─────────────────────────────────────────────────────────────┤
│                     BASE DE DATOS                            │
│                PostgreSQL 15+ con pgcrypto                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Esquema de Base de Datos

### Diagrama de Entidades

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    USERS    │────▶│  ACCOUNTS   │────▶│   LEDGER    │
└─────────────┘     └─────────────┘     │  ENTRIES    │
       │                   │            └─────────────┘
       │                   │                   │
       ▼                   ▼                   │
┌─────────────┐     ┌─────────────┐            │
│   WALLETS   │     │TRANSACTIONS │◀───────────┘
└─────────────┘     └─────────────┘
       │
       ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   ORDERS    │────▶│   TRADES    │────▶│  POSITIONS  │
└─────────────┘     └─────────────┘     └─────────────┘
       │
       ▼
┌─────────────┐
│   MARKETS   │
└─────────────┘
```

### Tablas Principales

| Tabla | Propósito | Registros Esperados |
|-------|-----------|---------------------|
| `users` | Información de usuarios | 10K - 1M |
| `accounts` | Cuentas contables | 2x usuarios + sistema |
| `ledger_entries` | Movimientos financieros | 100K - 10M diarios |
| `transactions` | Agrupador de movimientos | Similar a ledger |
| `wallets` | Vista simplificada de balance | 1 por usuario |
| `markets` | Mercados de predicción | 100 - 10K |
| `orders` | Órdenes de compra/venta | Alta frecuencia |
| `trades` | Operaciones ejecutadas | Alta frecuencia |
| `positions` | Posiciones de usuarios | usuarios x mercados |
| `audit_logs` | Registro de auditoría | Ilimitado (particionar) |

---

## Double-Entry Bookkeeping

### ¿Por qué Contabilidad de Doble Partida?

La contabilidad de doble partida garantiza que **todo el dinero esté siempre contabilizado**. Cada movimiento de dinero se registra en dos cuentas:

- **Débito**: Entrada de dinero a una cuenta
- **Crédito**: Salida de dinero de una cuenta

**Regla fundamental**: `SUM(débitos) = SUM(créditos)` para cada transacción.

### Estructura de Cuentas

```
CUENTAS DEL SISTEMA
├── PLATFORM_TREASURY (Tesorería)      [Asset]
├── COMMISSION_POOL (Comisiones)       [Revenue]
└── SETTLEMENT_POOL (Liquidaciones)    [Liability]

CUENTAS POR USUARIO
├── USR-XXXX-WALL (Billetera)          [Asset]
└── USR-XXXX-ESCR (Escrow/Bloqueado)   [Asset]
```

### Flujos de Dinero

#### 1. Depósito de Usuario

```
ANTES:
  PLATFORM_TREASURY: S/ 100,000
  USER_WALLET:       S/ 0

TRANSACCIÓN:
  Usuario deposita S/ 500 vía Yape

ENTRADAS DE LEDGER:
  | Cuenta           | Débito  | Crédito |
  |------------------|---------|---------|
  | TREASURY         | 0       | 500     | ← Sale de tesorería
  | USER_WALLET      | 500     | 0       | ← Entra a usuario

DESPUÉS:
  PLATFORM_TREASURY: S/ 99,500 (conceptualmente, dinero asignado)
  USER_WALLET:       S/ 500
```

#### 2. Creación de Orden (Escrow)

```
ANTES:
  USER_WALLET: S/ 500
  USER_ESCROW: S/ 0

TRANSACCIÓN:
  Usuario crea orden por S/ 100

ENTRADAS DE LEDGER:
  | Cuenta           | Débito  | Crédito |
  |------------------|---------|---------|
  | USER_WALLET      | 0       | 100     | ← Sale de disponible
  | USER_ESCROW      | 100     | 0       | ← Entra a bloqueado

DESPUÉS:
  USER_WALLET: S/ 400
  USER_ESCROW: S/ 100
```

#### 3. Ejecución de Trade

```
ANTES:
  BUYER_ESCROW:  S/ 60  (compró YES @ 60)
  SELLER_ESCROW: S/ 40  (compró NO @ 40)

TRANSACCIÓN:
  Match de órdenes, comisión 2%

ENTRADAS DE LEDGER:
  | Cuenta           | Débito  | Crédito |
  |------------------|---------|---------|
  | BUYER_ESCROW     | 0       | 60      |
  | SELLER_ESCROW    | 0       | 40      |
  | COMMISSION_POOL  | 2       | 0       | ← 2% comisión
  | SETTLEMENT_POOL  | 98      | 0       | ← Para liquidación
```

### Funciones SQL Clave

```sql
-- Transferencia segura (función core)
SELECT transfer_funds(
  from_account_id,  -- Cuenta origen
  to_account_id,    -- Cuenta destino
  amount,           -- Monto
  'order_escrow',   -- Tipo de transacción
  'Bloqueo por orden #123'
);

-- Bloquear fondos para orden
SELECT escrow_funds(user_id, amount, order_id);

-- Liberar fondos (cancelación)
SELECT release_escrow(user_id, amount, order_id);

-- Verificar integridad del sistema
SELECT * FROM verify_ledger_integrity();
```

### Verificación de Integridad

El sistema incluye una función que verifica:

1. ✅ Todas las transacciones están balanceadas
2. ✅ Balances de cuentas coinciden con el ledger
3. ✅ No hay balances negativos en activos
4. ✅ Wallets sincronizados con accounts

```sql
SELECT * FROM verify_ledger_integrity();

-- Resultado esperado:
-- | check_name                  | status | details                    |
-- |-----------------------------|--------|----------------------------|
-- | Transaction Balance Check   | PASS   | All transactions balanced  |
-- | Account Balance Verification| PASS   | All balances match ledger  |
-- | Negative Balance Check      | PASS   | No negative asset balances |
-- | Wallet Sync Check          | PASS   | All wallets synchronized   |
```

---

## Estrategia de Encriptación

### Capas de Protección

```
┌────────────────────────────────────────────────────────────┐
│                    CAPA DE APLICACIÓN                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         AES-256-GCM (Datos Sensibles)               │   │
│  │    DNI, Datos bancarios, Información personal       │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         bcrypt (Contraseñas)                        │   │
│  │    12 rondas, salt automático                       │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         HMAC-SHA256 (Hashes de búsqueda)            │   │
│  │    Permite buscar por DNI sin exponerlo             │   │
│  └─────────────────────────────────────────────────────┘   │
├────────────────────────────────────────────────────────────┤
│                     CAPA DE TRANSPORTE                      │
│                    TLS 1.3 (HTTPS)                         │
├────────────────────────────────────────────────────────────┤
│                    CAPA DE BASE DE DATOS                   │
│            Encriptación en reposo (si disponible)          │
└────────────────────────────────────────────────────────────┘
```

### Datos Encriptados

| Campo | Algoritmo | Propósito |
|-------|-----------|-----------|
| `dni_encrypted` | AES-256-GCM | Documento de identidad |
| `dni_hash` | HMAC-SHA256 | Búsqueda sin exponer |
| `first_name_encrypted` | AES-256-GCM | Nombre del usuario |
| `last_name_encrypted` | AES-256-GCM | Apellido |
| `bank_account_encrypted` | AES-256-GCM | Número de cuenta |
| `bank_cci_encrypted` | AES-256-GCM | Código interbancario |
| `password_hash` | bcrypt | Contraseña |

### Formato de Datos Encriptados

```
┌────────────────────────────────────────────────────────┐
│ IV (16 bytes) │ Auth Tag (16 bytes) │ Encrypted Data  │
└────────────────────────────────────────────────────────┘
```

- **IV (Initialization Vector)**: Aleatorio por cada encriptación
- **Auth Tag**: Garantiza integridad (detecta manipulación)
- **Encrypted Data**: Datos cifrados

### Uso de AAD (Additional Authenticated Data)

Cada encriptación incluye contexto adicional:

```typescript
// DNI vinculado al usuario
encryptDNI(dni, userId);  // AAD: "dni:{userId}"

// Datos bancarios con tipo específico
encryptBankData(cci, userId, 'cci');  // AAD: "bank:cci:{userId}"
```

Esto previene que un atacante pueda copiar datos encriptados entre usuarios.

---

## Riesgos y Mitigaciones

### 1. Inyección SQL

| Riesgo | Mitigación |
|--------|------------|
| Queries maliciosas | Prepared statements con parámetros |
| Datos no sanitizados | Validación con Zod antes de DB |

```typescript
// ❌ MAL - Vulnerable
await query(`SELECT * FROM users WHERE email = '${email}'`);

// ✅ BIEN - Parametrizado
await query('SELECT * FROM users WHERE email = $1', [email]);
```

### 2. Inconsistencias de Dinero

| Riesgo | Mitigación |
|--------|------------|
| Balance negativo | Constraint CHECK en DB |
| Transacciones desbalanceadas | Trigger de verificación |
| Race conditions | Transacciones SERIALIZABLE + FOR UPDATE |
| Datos corruptos | Función verify_ledger_integrity() |

```sql
-- Nivel de aislamiento para operaciones críticas
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- ... operaciones financieras ...
COMMIT;
```

### 3. Exposición de Datos Sensibles

| Riesgo | Mitigación |
|--------|------------|
| Breach de DB | Encriptación AES-256-GCM |
| Logs con datos sensibles | Máscaras (maskDNI, maskEmail) |
| Acceso a claves | Variables de entorno, no en código |

### 4. Ataques de Fuerza Bruta

| Riesgo | Mitigación |
|--------|------------|
| Passwords | bcrypt con 12 rondas |
| Login | Rate limiting + lockout temporal |
| APIs | Rate limiting por IP y usuario |

### 5. Escalamiento

| Riesgo | Mitigación |
|--------|------------|
| Ledger muy grande | Índices optimizados, particionamiento futuro |
| Conexiones DB | Pool de conexiones configurado |
| Queries lentas | Statement timeout de 30s |

---

## Configuración de Producción

### Variables de Entorno Críticas

```bash
# NUNCA usar valores por defecto en producción
ENCRYPTION_KEY=<64-char-hex>  # Generar único
JWT_SECRET=<48-char-min>      # Generar único
HASH_SECRET=<32-char-min>     # Generar único
DB_PASSWORD=<strong-password>

# Habilitar SSL
DB_SSL_CA=<certificate>

# Monitoreo
SENTRY_DSN=<your-sentry-dsn>
```

### Checklist Pre-Producción

- [ ] Generar todas las claves de encriptación únicas
- [ ] Configurar SSL para PostgreSQL
- [ ] Habilitar backups automáticos
- [ ] Configurar monitoreo (Sentry, APM)
- [ ] Revisar rate limits para producción
- [ ] Ejecutar `verify_ledger_integrity()` periódicamente
- [ ] Configurar alertas para transacciones sospechosas

---

## Próximos Pasos (Fases 2-6)

### Fase 2: Autenticación y KYC
- JWT con refresh tokens
- Verificación SMS (Twilio)
- Integración RENIEC simulada
- Detección de documentos fraudulentos

### Fase 3: Pagos
- Integración Yape/Plin (QR)
- Culqi para tarjetas
- Webhooks seguros
- Sistema de escrow

### Fase 4: Motor de Mercados
- Matching engine
- Order book en memoria
- Liquidación automática
- Cálculo de P&L

### Fase 5: Frontend
- React + TypeScript
- Gráficos en tiempo real
- UX optimizado para trading

### Fase 6: Seguridad Avanzada
- Rate limiting por endpoint
- Detección de fraude
- Términos legales
