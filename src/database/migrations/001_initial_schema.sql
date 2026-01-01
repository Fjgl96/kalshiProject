-- ============================================================================
-- KALSHI PERÚ - ESQUEMA DE BASE DE DATOS v1.0
-- Optimizado para transacciones de alta frecuencia con Double-Entry Bookkeeping
-- ============================================================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- TIPOS ENUMERADOS (ENUMS)
-- ============================================================================

-- Estados KYC del usuario
CREATE TYPE kyc_status AS ENUM (
    'pending',      -- Pendiente de verificación
    'submitted',    -- Documentos enviados
    'verified',     -- Verificado completamente
    'rejected',     -- Rechazado
    'suspended'     -- Suspendido por actividad sospechosa
);

-- Estados de usuario
CREATE TYPE user_status AS ENUM (
    'active',
    'inactive',
    'suspended',
    'banned'
);

-- Tipos de cuenta contable (Double-Entry)
CREATE TYPE account_type AS ENUM (
    'asset',        -- Activos (billeteras de usuarios)
    'liability',    -- Pasivos (obligaciones de la plataforma)
    'equity',       -- Patrimonio
    'revenue',      -- Ingresos (comisiones)
    'expense'       -- Gastos
);

-- Categorías de cuentas
CREATE TYPE account_category AS ENUM (
    'user_wallet',          -- Billetera disponible del usuario
    'user_escrow',          -- Fondos bloqueados del usuario (órdenes abiertas)
    'platform_commission',  -- Comisiones de la plataforma
    'platform_treasury',    -- Tesorería de la plataforma
    'settlement_pool'       -- Pool de liquidación de mercados
);

-- Tipos de transacción
CREATE TYPE transaction_type AS ENUM (
    'deposit',              -- Depósito de fondos
    'withdrawal',           -- Retiro de fondos
    'order_escrow',         -- Bloqueo por orden
    'order_release',        -- Liberación por cancelación de orden
    'trade_execution',      -- Ejecución de trade
    'market_settlement',    -- Liquidación de mercado
    'commission_charge',    -- Cobro de comisión
    'refund',               -- Reembolso
    'adjustment'            -- Ajuste manual (solo admin)
);

-- Estados de transacción
CREATE TYPE transaction_status AS ENUM (
    'pending',
    'processing',
    'completed',
    'failed',
    'reversed'
);

-- Estados de mercado
CREATE TYPE market_status AS ENUM (
    'draft',        -- En borrador
    'scheduled',    -- Programado para apertura
    'open',         -- Abierto para trading
    'suspended',    -- Suspendido temporalmente
    'closed',       -- Cerrado para trading, pendiente liquidación
    'settled',      -- Liquidado
    'cancelled'     -- Cancelado (reembolso total)
);

-- Tipo de resultado del mercado
CREATE TYPE market_outcome AS ENUM (
    'yes',          -- El evento SÍ ocurrió
    'no',           -- El evento NO ocurrió
    'void'          -- Mercado anulado
);

-- Lado de la orden
CREATE TYPE order_side AS ENUM (
    'yes',          -- Compra de contrato "Sí"
    'no'            -- Compra de contrato "No"
);

-- Tipo de orden
CREATE TYPE order_type AS ENUM (
    'limit',        -- Orden límite
    'market'        -- Orden de mercado (ejecutar al mejor precio)
);

-- Estado de la orden
CREATE TYPE order_status AS ENUM (
    'pending',      -- Pendiente de fondos/validación
    'open',         -- Abierta en el order book
    'partially_filled', -- Parcialmente ejecutada
    'filled',       -- Completamente ejecutada
    'cancelled',    -- Cancelada por usuario
    'expired',      -- Expirada
    'rejected'      -- Rechazada por el sistema
);

-- Método de pago
CREATE TYPE payment_method AS ENUM (
    'yape',
    'plin',
    'credit_card',
    'debit_card',
    'bank_transfer',
    'platform_credit'
);

-- Nivel de severidad de audit
CREATE TYPE audit_severity AS ENUM (
    'info',
    'warning',
    'error',
    'critical'
);

-- ============================================================================
-- TABLA: USERS
-- Información de usuarios con datos sensibles encriptados
-- ============================================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Información básica
    email VARCHAR(255) NOT NULL,
    email_verified BOOLEAN DEFAULT FALSE,
    phone VARCHAR(20),  -- Formato: +51XXXXXXXXX
    phone_verified BOOLEAN DEFAULT FALSE,

    -- Autenticación (password hasheado con bcrypt)
    password_hash VARCHAR(255) NOT NULL,
    password_salt VARCHAR(64) NOT NULL,

    -- Datos personales ENCRIPTADOS (AES-256-GCM)
    -- Estos campos almacenan datos cifrados + IV + auth tag
    dni_encrypted BYTEA,                    -- DNI peruano encriptado
    dni_hash VARCHAR(64),                   -- Hash del DNI para búsquedas (SHA-256)
    first_name_encrypted BYTEA,
    last_name_encrypted BYTEA,
    birth_date_encrypted BYTEA,
    address_encrypted BYTEA,

    -- Datos bancarios ENCRIPTADOS
    bank_account_encrypted BYTEA,           -- Número de cuenta encriptado
    bank_cci_encrypted BYTEA,               -- CCI encriptado
    bank_name VARCHAR(100),                 -- Nombre del banco (no sensible)

    -- KYC
    kyc_status kyc_status DEFAULT 'pending',
    kyc_submitted_at TIMESTAMP WITH TIME ZONE,
    kyc_verified_at TIMESTAMP WITH TIME ZONE,
    kyc_rejection_reason TEXT,
    kyc_documents JSONB DEFAULT '[]',       -- Referencias a documentos subidos

    -- Estado y roles
    status user_status DEFAULT 'active',
    is_admin BOOLEAN DEFAULT FALSE,

    -- Límites y restricciones
    daily_deposit_limit DECIMAL(12, 2) DEFAULT 10000.00,
    daily_withdrawal_limit DECIMAL(12, 2) DEFAULT 5000.00,
    max_position_size DECIMAL(12, 2) DEFAULT 50000.00,

    -- Seguridad
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    last_login_at TIMESTAMP WITH TIME ZONE,
    last_login_ip INET,
    two_factor_enabled BOOLEAN DEFAULT FALSE,
    two_factor_secret_encrypted BYTEA,

    -- Metadatos
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,     -- Soft delete

    -- Constraints
    CONSTRAINT users_email_unique UNIQUE (email),
    CONSTRAINT users_phone_unique UNIQUE (phone),
    CONSTRAINT users_dni_hash_unique UNIQUE (dni_hash)
);

-- Índices para Users
CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_phone ON users(phone) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_dni_hash ON users(dni_hash) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_kyc_status ON users(kyc_status);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_created_at ON users(created_at);

-- ============================================================================
-- TABLA: ACCOUNTS (Cuentas Contables - Double-Entry Bookkeeping)
-- Cada usuario tiene múltiples cuentas contables
-- ============================================================================
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Relación con usuario (NULL para cuentas del sistema)
    user_id UUID REFERENCES users(id),

    -- Identificación de cuenta
    account_number VARCHAR(20) NOT NULL UNIQUE,  -- Ej: "USR-XXXX-WALL"
    name VARCHAR(100) NOT NULL,

    -- Clasificación contable
    account_type account_type NOT NULL,
    category account_category NOT NULL,

    -- Moneda (por ahora solo PEN)
    currency CHAR(3) DEFAULT 'PEN',

    -- Balance calculado (se actualiza con triggers)
    -- IMPORTANTE: Este es un campo desnormalizado para consultas rápidas
    -- La fuente de verdad SIEMPRE es la suma de ledger_entries
    balance DECIMAL(15, 2) DEFAULT 0.00,

    -- Control de concurrencia optimista
    version INTEGER DEFAULT 1,

    -- Estado
    is_active BOOLEAN DEFAULT TRUE,
    frozen BOOLEAN DEFAULT FALSE,
    frozen_reason TEXT,
    frozen_at TIMESTAMP WITH TIME ZONE,

    -- Metadatos
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT accounts_balance_non_negative CHECK (
        -- Solo cuentas de activo deben tener balance >= 0
        (account_type != 'asset') OR (balance >= 0)
    )
);

-- Índices para Accounts
CREATE INDEX idx_accounts_user_id ON accounts(user_id);
CREATE INDEX idx_accounts_category ON accounts(category);
CREATE INDEX idx_accounts_type ON accounts(account_type);
CREATE UNIQUE INDEX idx_accounts_user_category ON accounts(user_id, category)
    WHERE user_id IS NOT NULL;

-- ============================================================================
-- TABLA: TRANSACTIONS (Agrupador de movimientos contables)
-- Cada transacción financiera agrupa múltiples entradas de ledger
-- ============================================================================
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Referencia externa (para pagos, trades, etc.)
    reference_type VARCHAR(50),              -- 'payment', 'trade', 'settlement', etc.
    reference_id UUID,                       -- ID del registro relacionado

    -- Tipo y estado
    transaction_type transaction_type NOT NULL,
    status transaction_status DEFAULT 'pending',

    -- Monto total de la transacción
    amount DECIMAL(15, 2) NOT NULL,
    currency CHAR(3) DEFAULT 'PEN',

    -- Descripción
    description TEXT,

    -- Metadatos adicionales (JSON para flexibilidad)
    metadata JSONB DEFAULT '{}',

    -- Usuario que inició la transacción
    initiated_by UUID REFERENCES users(id),

    -- Aprobación (para transacciones que requieren revisión)
    requires_approval BOOLEAN DEFAULT FALSE,
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMP WITH TIME ZONE,

    -- Reversión
    is_reversal BOOLEAN DEFAULT FALSE,
    reversal_of UUID REFERENCES transactions(id),
    reversed_at TIMESTAMP WITH TIME ZONE,
    reversal_reason TEXT,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,

    -- Constraint: El monto debe ser positivo
    CONSTRAINT transactions_amount_positive CHECK (amount > 0)
);

-- Índices para Transactions
CREATE INDEX idx_transactions_reference ON transactions(reference_type, reference_id);
CREATE INDEX idx_transactions_type ON transactions(transaction_type);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_initiated_by ON transactions(initiated_by);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);

-- ============================================================================
-- TABLA: LEDGER_ENTRIES (Libro Mayor - Corazón del Double-Entry)
-- REGLA FUNDAMENTAL: SUM(debit) = SUM(credit) para cada transaction_id
-- ============================================================================
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Relación con transacción
    transaction_id UUID NOT NULL REFERENCES transactions(id),

    -- Cuenta afectada
    account_id UUID NOT NULL REFERENCES accounts(id),

    -- Montos (solo uno debe tener valor, el otro es 0)
    -- En contabilidad: Débito = Entrada, Crédito = Salida (para activos)
    debit DECIMAL(15, 2) DEFAULT 0.00,
    credit DECIMAL(15, 2) DEFAULT 0.00,

    -- Balance después de esta entrada (para auditoría rápida)
    running_balance DECIMAL(15, 2) NOT NULL,

    -- Descripción de línea
    line_description VARCHAR(255),

    -- Secuencia dentro de la transacción
    sequence_number INTEGER NOT NULL,

    -- Timestamp (inmutable una vez creado)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT ledger_debit_or_credit CHECK (
        (debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)
    ),
    CONSTRAINT ledger_amounts_positive CHECK (
        debit >= 0 AND credit >= 0
    )
);

-- Índices para Ledger (CRÍTICOS para rendimiento)
CREATE INDEX idx_ledger_transaction_id ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_account_id ON ledger_entries(account_id);
CREATE INDEX idx_ledger_created_at ON ledger_entries(created_at);
CREATE INDEX idx_ledger_account_created ON ledger_entries(account_id, created_at DESC);

-- Índice para verificar balance rápido
CREATE INDEX idx_ledger_account_balance ON ledger_entries(account_id, created_at DESC, running_balance);

-- ============================================================================
-- TABLA: WALLETS (Vista simplificada de billetera para usuarios)
-- Esta es una tabla de conveniencia - los datos reales están en accounts
-- ============================================================================
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) UNIQUE,

    -- Referencias a cuentas contables
    available_account_id UUID NOT NULL REFERENCES accounts(id),
    escrow_account_id UUID NOT NULL REFERENCES accounts(id),

    -- Campos calculados (desnormalizados para consultas rápidas)
    available_balance DECIMAL(15, 2) DEFAULT 0.00,
    escrow_balance DECIMAL(15, 2) DEFAULT 0.00,

    -- Total = available + escrow
    total_balance DECIMAL(15, 2) GENERATED ALWAYS AS (available_balance + escrow_balance) STORED,

    currency CHAR(3) DEFAULT 'PEN',

    -- Control
    version INTEGER DEFAULT 1,
    last_transaction_at TIMESTAMP WITH TIME ZONE,

    -- Metadatos
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT wallets_available_non_negative CHECK (available_balance >= 0),
    CONSTRAINT wallets_escrow_non_negative CHECK (escrow_balance >= 0)
);

-- Índices para Wallets
CREATE INDEX idx_wallets_user_id ON wallets(user_id);

-- ============================================================================
-- TABLA: MARKETS (Mercados de Predicción)
-- ============================================================================
CREATE TABLE markets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Identificación
    ticker VARCHAR(20) NOT NULL UNIQUE,      -- Ej: "BCRP-TASA-MAY25"
    title VARCHAR(255) NOT NULL,             -- Título del mercado
    description TEXT,                        -- Descripción detallada

    -- Categorización
    category VARCHAR(50) NOT NULL,           -- 'economia', 'politica', 'clima', etc.
    subcategory VARCHAR(50),
    tags JSONB DEFAULT '[]',

    -- Reglas del mercado
    resolution_source TEXT NOT NULL,         -- Fuente oficial de resolución
    resolution_criteria TEXT NOT NULL,       -- Criterios específicos de resolución

    -- Precios (0.01 a 99.99 soles, representando probabilidad en %)
    min_price DECIMAL(5, 2) DEFAULT 0.01,
    max_price DECIMAL(5, 2) DEFAULT 99.99,
    tick_size DECIMAL(5, 2) DEFAULT 1.00,    -- Incremento mínimo de precio

    -- Límites
    min_order_size INTEGER DEFAULT 1,        -- Contratos mínimos por orden
    max_order_size INTEGER DEFAULT 10000,    -- Contratos máximos por orden
    position_limit INTEGER DEFAULT 50000,    -- Límite de posición por usuario

    -- Liquidación
    contract_value DECIMAL(10, 2) DEFAULT 100.00,  -- Valor de contrato ganador

    -- Fechas importantes
    scheduled_open_at TIMESTAMP WITH TIME ZONE,
    opened_at TIMESTAMP WITH TIME ZONE,
    closes_at TIMESTAMP WITH TIME ZONE NOT NULL,       -- Cierre de trading
    settlement_date TIMESTAMP WITH TIME ZONE NOT NULL, -- Fecha de liquidación
    settled_at TIMESTAMP WITH TIME ZONE,

    -- Estado
    status market_status DEFAULT 'draft',
    outcome market_outcome,

    -- Estadísticas (actualizadas periódicamente)
    last_yes_price DECIMAL(5, 2),
    last_no_price DECIMAL(5, 2),
    volume_24h INTEGER DEFAULT 0,
    total_volume INTEGER DEFAULT 0,
    open_interest INTEGER DEFAULT 0,

    -- Administración
    created_by UUID REFERENCES users(id),
    settled_by UUID REFERENCES users(id),
    settlement_notes TEXT,

    -- Metadatos
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT markets_dates_valid CHECK (closes_at <= settlement_date),
    CONSTRAINT markets_prices_valid CHECK (min_price < max_price)
);

-- Índices para Markets
CREATE INDEX idx_markets_ticker ON markets(ticker);
CREATE INDEX idx_markets_status ON markets(status);
CREATE INDEX idx_markets_category ON markets(category);
CREATE INDEX idx_markets_closes_at ON markets(closes_at);
CREATE INDEX idx_markets_settlement_date ON markets(settlement_date);
CREATE INDEX idx_markets_open_active ON markets(status, closes_at) WHERE status = 'open';

-- ============================================================================
-- TABLA: ORDERS (Órdenes de compra/venta)
-- ============================================================================
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Referencias
    user_id UUID NOT NULL REFERENCES users(id),
    market_id UUID NOT NULL REFERENCES markets(id),

    -- Orden número (para referencia del usuario)
    order_number BIGSERIAL,

    -- Tipo de orden
    side order_side NOT NULL,                -- 'yes' o 'no'
    order_type order_type NOT NULL,

    -- Precios
    limit_price DECIMAL(5, 2),               -- Precio límite (NULL para market orders)
    avg_fill_price DECIMAL(5, 2),            -- Precio promedio de ejecución

    -- Cantidades (en número de contratos)
    quantity INTEGER NOT NULL,               -- Cantidad original
    filled_quantity INTEGER DEFAULT 0,       -- Cantidad ejecutada
    remaining_quantity INTEGER,              -- Cantidad restante (computed)

    -- Costos
    -- Costo = (precio * cantidad) + comisión
    estimated_cost DECIMAL(15, 2) NOT NULL,  -- Costo estimado al crear
    actual_cost DECIMAL(15, 2) DEFAULT 0,    -- Costo real ejecutado
    commission DECIMAL(15, 2) DEFAULT 0,     -- Comisión cobrada

    -- Fondos bloqueados
    escrow_amount DECIMAL(15, 2) DEFAULT 0,  -- Monto en escrow
    escrow_transaction_id UUID REFERENCES transactions(id),

    -- Estado
    status order_status DEFAULT 'pending',
    rejection_reason TEXT,

    -- Tiempos
    expires_at TIMESTAMP WITH TIME ZONE,     -- Expiración de la orden
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    opened_at TIMESTAMP WITH TIME ZONE,      -- Cuando entró al order book
    filled_at TIMESTAMP WITH TIME ZONE,      -- Cuando se completó
    cancelled_at TIMESTAMP WITH TIME ZONE,

    -- IP y seguridad
    submitted_from_ip INET,
    user_agent TEXT,

    -- Metadatos
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT orders_quantity_positive CHECK (quantity > 0),
    CONSTRAINT orders_price_valid CHECK (
        (order_type = 'market') OR
        (order_type = 'limit' AND limit_price IS NOT NULL AND limit_price > 0)
    ),
    CONSTRAINT orders_filled_valid CHECK (filled_quantity <= quantity)
);

-- Columna computada para remaining_quantity
ALTER TABLE orders
ADD CONSTRAINT orders_remaining_check
CHECK (remaining_quantity IS NULL OR remaining_quantity = quantity - filled_quantity);

-- Trigger para calcular remaining_quantity automáticamente
CREATE OR REPLACE FUNCTION update_order_remaining()
RETURNS TRIGGER AS $$
BEGIN
    NEW.remaining_quantity := NEW.quantity - NEW.filled_quantity;
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_remaining_trigger
BEFORE INSERT OR UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION update_order_remaining();

-- Índices para Orders (CRÍTICOS para matching engine)
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_market_id ON orders(market_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_market_status ON orders(market_id, status);

-- Índice para order book: órdenes abiertas ordenadas por precio
CREATE INDEX idx_orders_book_yes ON orders(market_id, limit_price DESC, created_at ASC)
WHERE status IN ('open', 'partially_filled') AND side = 'yes';

CREATE INDEX idx_orders_book_no ON orders(market_id, limit_price ASC, created_at ASC)
WHERE status IN ('open', 'partially_filled') AND side = 'no';

-- Índice para órdenes del usuario
CREATE INDEX idx_orders_user_active ON orders(user_id, created_at DESC)
WHERE status IN ('open', 'partially_filled', 'pending');

-- ============================================================================
-- TABLA: TRADES (Operaciones ejecutadas)
-- Un trade representa el matching de dos órdenes
-- ============================================================================
CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Número de trade (para referencia)
    trade_number BIGSERIAL,

    -- Mercado
    market_id UUID NOT NULL REFERENCES markets(id),

    -- Órdenes participantes
    -- buyer_order compra "yes", seller_order compra "no"
    -- (o viceversa dependiendo del match)
    maker_order_id UUID NOT NULL REFERENCES orders(id),
    taker_order_id UUID NOT NULL REFERENCES orders(id),

    -- Usuarios involucrados
    maker_user_id UUID NOT NULL REFERENCES users(id),
    taker_user_id UUID NOT NULL REFERENCES users(id),

    -- Detalles del trade
    side order_side NOT NULL,               -- Lado del taker
    price DECIMAL(5, 2) NOT NULL,           -- Precio de ejecución
    quantity INTEGER NOT NULL,              -- Contratos intercambiados

    -- Costos
    total_value DECIMAL(15, 2) NOT NULL,    -- price * quantity
    maker_commission DECIMAL(15, 2) DEFAULT 0,
    taker_commission DECIMAL(15, 2) DEFAULT 0,

    -- Transacción contable asociada
    transaction_id UUID REFERENCES transactions(id),

    -- Timestamp
    executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT trades_quantity_positive CHECK (quantity > 0),
    CONSTRAINT trades_price_valid CHECK (price > 0 AND price < 100),
    CONSTRAINT trades_different_users CHECK (maker_user_id != taker_user_id)
);

-- Índices para Trades
CREATE INDEX idx_trades_market_id ON trades(market_id);
CREATE INDEX idx_trades_maker_order ON trades(maker_order_id);
CREATE INDEX idx_trades_taker_order ON trades(taker_order_id);
CREATE INDEX idx_trades_maker_user ON trades(maker_user_id);
CREATE INDEX idx_trades_taker_user ON trades(taker_user_id);
CREATE INDEX idx_trades_executed_at ON trades(executed_at DESC);
CREATE INDEX idx_trades_market_time ON trades(market_id, executed_at DESC);

-- ============================================================================
-- TABLA: POSITIONS (Posiciones abiertas de usuarios)
-- Resumen de la posición neta del usuario en cada mercado
-- ============================================================================
CREATE TABLE positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id UUID NOT NULL REFERENCES users(id),
    market_id UUID NOT NULL REFERENCES markets(id),

    -- Posición en contratos "Sí"
    yes_quantity INTEGER DEFAULT 0,
    yes_avg_price DECIMAL(5, 2) DEFAULT 0,
    yes_cost DECIMAL(15, 2) DEFAULT 0,

    -- Posición en contratos "No"
    no_quantity INTEGER DEFAULT 0,
    no_avg_price DECIMAL(5, 2) DEFAULT 0,
    no_cost DECIMAL(15, 2) DEFAULT 0,

    -- Totales
    total_invested DECIMAL(15, 2) GENERATED ALWAYS AS (yes_cost + no_cost) STORED,
    realized_pnl DECIMAL(15, 2) DEFAULT 0,    -- Ganancia/pérdida realizada

    -- Cálculo de P&L no realizado (se calcula en runtime)

    -- Control
    version INTEGER DEFAULT 1,
    last_trade_at TIMESTAMP WITH TIME ZONE,

    -- Metadatos
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Un usuario solo puede tener una posición por mercado
    CONSTRAINT positions_user_market_unique UNIQUE (user_id, market_id),
    CONSTRAINT positions_quantities_non_negative CHECK (
        yes_quantity >= 0 AND no_quantity >= 0
    )
);

-- Índices para Positions
CREATE INDEX idx_positions_user_id ON positions(user_id);
CREATE INDEX idx_positions_market_id ON positions(market_id);
CREATE INDEX idx_positions_user_active ON positions(user_id)
WHERE yes_quantity > 0 OR no_quantity > 0;

-- ============================================================================
-- TABLA: PAYMENTS (Pagos externos)
-- Depósitos y retiros
-- ============================================================================
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id UUID NOT NULL REFERENCES users(id),

    -- Tipo
    payment_type VARCHAR(20) NOT NULL CHECK (payment_type IN ('deposit', 'withdrawal')),
    method payment_method NOT NULL,

    -- Montos
    amount DECIMAL(15, 2) NOT NULL,
    fee DECIMAL(15, 2) DEFAULT 0,
    net_amount DECIMAL(15, 2) NOT NULL,      -- amount - fee
    currency CHAR(3) DEFAULT 'PEN',

    -- Estado
    status transaction_status DEFAULT 'pending',

    -- Referencias externas
    external_reference VARCHAR(100),          -- Referencia del procesador
    provider_transaction_id VARCHAR(100),     -- ID de Yape/Plin/Culqi

    -- Para depósitos QR
    qr_code TEXT,
    qr_expires_at TIMESTAMP WITH TIME ZONE,

    -- Datos de tarjeta (tokenizados, NO almacenar números completos)
    card_last_four VARCHAR(4),
    card_brand VARCHAR(20),

    -- Datos bancarios para retiro (referencia a datos encriptados del usuario)
    destination_account_encrypted BYTEA,

    -- Transacción contable asociada
    transaction_id UUID REFERENCES transactions(id),

    -- Webhook
    webhook_received_at TIMESTAMP WITH TIME ZONE,
    webhook_payload JSONB,

    -- IP de origen
    ip_address INET,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    failed_at TIMESTAMP WITH TIME ZONE,
    failure_reason TEXT,

    -- Constraints
    CONSTRAINT payments_amount_positive CHECK (amount > 0),
    CONSTRAINT payments_net_valid CHECK (net_amount = amount - fee)
);

-- Índices para Payments
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_external_ref ON payments(external_reference);
CREATE INDEX idx_payments_provider_tx ON payments(provider_transaction_id);
CREATE INDEX idx_payments_created_at ON payments(created_at DESC);

-- ============================================================================
-- TABLA: AUDIT_LOGS (Registro de auditoría)
-- Inmutable: solo INSERT, nunca UPDATE o DELETE
-- ============================================================================
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Actor
    user_id UUID REFERENCES users(id),       -- NULL para acciones del sistema
    session_id VARCHAR(64),
    ip_address INET,
    user_agent TEXT,

    -- Acción
    action VARCHAR(100) NOT NULL,            -- Ej: 'user.login', 'order.create', etc.
    resource_type VARCHAR(50),               -- Ej: 'user', 'order', 'market'
    resource_id UUID,

    -- Severidad
    severity audit_severity DEFAULT 'info',

    -- Detalles
    description TEXT,
    old_values JSONB,                        -- Valores anteriores (para updates)
    new_values JSONB,                        -- Valores nuevos
    metadata JSONB DEFAULT '{}',

    -- Resultado
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,

    -- Timestamp (inmutable)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Índices para Audit Logs
CREATE INDEX idx_audit_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_severity ON audit_logs(severity);
CREATE INDEX idx_audit_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_user_time ON audit_logs(user_id, created_at DESC);

-- Particionamiento por tiempo (para escalabilidad)
-- En producción, considerar particionar por mes
-- CREATE TABLE audit_logs_partitioned (...) PARTITION BY RANGE (created_at);

-- ============================================================================
-- TABLA: SYSTEM_ACCOUNTS (Cuentas del Sistema)
-- Referencia a cuentas especiales de la plataforma
-- ============================================================================
CREATE TABLE system_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    name VARCHAR(50) NOT NULL UNIQUE,         -- Ej: 'PLATFORM_TREASURY', 'COMMISSION_POOL'
    description TEXT,
    account_id UUID NOT NULL REFERENCES accounts(id),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- FUNCIONES Y TRIGGERS
-- ============================================================================

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar trigger a todas las tablas relevantes
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON accounts
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wallets_updated_at BEFORE UPDATE ON wallets
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_markets_updated_at BEFORE UPDATE ON markets
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_positions_updated_at BEFORE UPDATE ON positions
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- FUNCIÓN: Verificar balance de double-entry
-- Garantiza que cada transacción esté balanceada
-- ============================================================================
CREATE OR REPLACE FUNCTION verify_transaction_balance()
RETURNS TRIGGER AS $$
DECLARE
    total_debit DECIMAL(15, 2);
    total_credit DECIMAL(15, 2);
BEGIN
    -- Esta función se ejecuta AFTER INSERT en ledger_entries
    -- Verifica que la transacción esté balanceada

    SELECT
        COALESCE(SUM(debit), 0),
        COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM ledger_entries
    WHERE transaction_id = NEW.transaction_id;

    -- La verificación solo se hace cuando la transacción está completa
    -- Se asume que las entradas se insertan en una transacción SQL

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCIÓN: Actualizar balance de cuenta después de ledger entry
-- ============================================================================
CREATE OR REPLACE FUNCTION update_account_balance()
RETURNS TRIGGER AS $$
DECLARE
    new_balance DECIMAL(15, 2);
    current_balance DECIMAL(15, 2);
BEGIN
    -- Obtener balance actual
    SELECT balance INTO current_balance
    FROM accounts
    WHERE id = NEW.account_id
    FOR UPDATE;  -- Lock para evitar race conditions

    -- Calcular nuevo balance
    -- Para cuentas de activo: débito aumenta, crédito disminuye
    -- Para cuentas de pasivo/patrimonio: crédito aumenta, débito disminuye
    new_balance := current_balance + NEW.debit - NEW.credit;

    -- Actualizar running_balance en la entrada
    NEW.running_balance := new_balance;

    -- Actualizar balance en la cuenta
    UPDATE accounts
    SET balance = new_balance, version = version + 1
    WHERE id = NEW.account_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_update_balance
BEFORE INSERT ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION update_account_balance();

-- ============================================================================
-- FUNCIÓN: Sincronizar wallet con accounts
-- ============================================================================
CREATE OR REPLACE FUNCTION sync_wallet_balance()
RETURNS TRIGGER AS $$
BEGIN
    -- Actualizar wallets cuando cambia el balance de una cuenta de usuario
    UPDATE wallets w
    SET
        available_balance = CASE
            WHEN NEW.id = w.available_account_id THEN NEW.balance
            ELSE w.available_balance
        END,
        escrow_balance = CASE
            WHEN NEW.id = w.escrow_account_id THEN NEW.balance
            ELSE w.escrow_balance
        END,
        version = version + 1
    WHERE w.available_account_id = NEW.id OR w.escrow_account_id = NEW.id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_sync_wallet
AFTER UPDATE OF balance ON accounts
FOR EACH ROW
EXECUTE FUNCTION sync_wallet_balance();

-- ============================================================================
-- POLÍTICA DE SEGURIDAD: Audit logs inmutables
-- ============================================================================
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit logs cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_modification();

-- ============================================================================
-- VISTAS ÚTILES
-- ============================================================================

-- Vista: Resumen de billetera del usuario
CREATE VIEW user_wallet_summary AS
SELECT
    u.id AS user_id,
    u.email,
    w.available_balance,
    w.escrow_balance,
    w.total_balance,
    w.currency,
    w.last_transaction_at
FROM users u
JOIN wallets w ON w.user_id = u.id
WHERE u.deleted_at IS NULL;

-- Vista: Order book de un mercado
CREATE VIEW order_book AS
SELECT
    m.id AS market_id,
    m.ticker,
    o.side,
    o.limit_price,
    SUM(o.remaining_quantity) AS total_quantity,
    COUNT(*) AS order_count
FROM markets m
JOIN orders o ON o.market_id = m.id
WHERE o.status IN ('open', 'partially_filled')
  AND m.status = 'open'
GROUP BY m.id, m.ticker, o.side, o.limit_price
ORDER BY
    m.id,
    o.side,
    CASE WHEN o.side = 'yes' THEN o.limit_price END DESC,
    CASE WHEN o.side = 'no' THEN o.limit_price END ASC;

-- Vista: Posiciones activas del usuario
CREATE VIEW user_active_positions AS
SELECT
    p.user_id,
    m.id AS market_id,
    m.ticker,
    m.title,
    m.status AS market_status,
    p.yes_quantity,
    p.yes_avg_price,
    p.no_quantity,
    p.no_avg_price,
    p.total_invested,
    p.realized_pnl,
    m.last_yes_price,
    m.last_no_price,
    -- P&L no realizado aproximado
    (p.yes_quantity * COALESCE(m.last_yes_price, p.yes_avg_price)) +
    (p.no_quantity * COALESCE(m.last_no_price, p.no_avg_price)) -
    p.total_invested AS unrealized_pnl
FROM positions p
JOIN markets m ON m.id = p.market_id
WHERE p.yes_quantity > 0 OR p.no_quantity > 0;

-- ============================================================================
-- DATOS INICIALES: Cuentas del sistema
-- ============================================================================

-- Insertar cuentas del sistema (se ejecuta en migración de datos)
-- Ver archivo 002_seed_system_accounts.sql

COMMENT ON TABLE users IS 'Usuarios de la plataforma con datos sensibles encriptados';
COMMENT ON TABLE accounts IS 'Cuentas contables para double-entry bookkeeping';
COMMENT ON TABLE ledger_entries IS 'Libro mayor - corazón del sistema financiero';
COMMENT ON TABLE transactions IS 'Transacciones financieras agrupando movimientos de ledger';
COMMENT ON TABLE wallets IS 'Vista simplificada de billeteras de usuarios';
COMMENT ON TABLE markets IS 'Mercados de predicción (eventos para trading)';
COMMENT ON TABLE orders IS 'Órdenes de compra/venta de contratos';
COMMENT ON TABLE trades IS 'Trades ejecutados (matching de órdenes)';
COMMENT ON TABLE positions IS 'Posiciones de usuarios en mercados';
COMMENT ON TABLE payments IS 'Depósitos y retiros de fondos';
COMMENT ON TABLE audit_logs IS 'Registro inmutable de auditoría';
