-- ============================================================================
-- KALSHI PERÚ - CUENTAS DEL SISTEMA
-- Estas cuentas son fundamentales para el double-entry bookkeeping
-- ============================================================================

-- ============================================================================
-- CUENTAS DE LA PLATAFORMA
-- ============================================================================

-- 1. Cuenta de Tesorería Principal
INSERT INTO accounts (
    id,
    account_number,
    name,
    account_type,
    category,
    currency
) VALUES (
    'a0000000-0000-0000-0000-000000000001'::uuid,
    'SYS-0001-TREA',
    'Platform Treasury',
    'asset',
    'platform_treasury',
    'PEN'
);

-- 2. Cuenta de Comisiones
INSERT INTO accounts (
    id,
    account_number,
    name,
    account_type,
    category,
    currency
) VALUES (
    'a0000000-0000-0000-0000-000000000002'::uuid,
    'SYS-0002-COMM',
    'Commission Revenue',
    'revenue',
    'platform_commission',
    'PEN'
);

-- 3. Cuenta de Pool de Liquidación
INSERT INTO accounts (
    id,
    account_number,
    name,
    account_type,
    category,
    currency
) VALUES (
    'a0000000-0000-0000-0000-000000000003'::uuid,
    'SYS-0003-SETL',
    'Settlement Pool',
    'liability',
    'settlement_pool',
    'PEN'
);

-- ============================================================================
-- REGISTRO EN SYSTEM_ACCOUNTS
-- ============================================================================

INSERT INTO system_accounts (name, description, account_id) VALUES
    ('PLATFORM_TREASURY', 'Cuenta principal de tesorería de la plataforma', 'a0000000-0000-0000-0000-000000000001'::uuid),
    ('COMMISSION_POOL', 'Cuenta donde se acumulan las comisiones cobradas', 'a0000000-0000-0000-0000-000000000002'::uuid),
    ('SETTLEMENT_POOL', 'Cuenta para liquidación de mercados', 'a0000000-0000-0000-0000-000000000003'::uuid);

-- ============================================================================
-- FUNCIÓN: Crear cuentas de usuario automáticamente
-- ============================================================================

CREATE OR REPLACE FUNCTION create_user_accounts()
RETURNS TRIGGER AS $$
DECLARE
    wallet_account_id UUID;
    escrow_account_id UUID;
    account_prefix VARCHAR(4);
BEGIN
    -- Generar prefijo único basado en ID de usuario
    account_prefix := UPPER(SUBSTRING(REPLACE(NEW.id::text, '-', ''), 1, 4));

    -- Crear cuenta de billetera disponible
    INSERT INTO accounts (
        user_id,
        account_number,
        name,
        account_type,
        category,
        currency
    ) VALUES (
        NEW.id,
        'USR-' || account_prefix || '-WALL',
        'User Wallet - ' || NEW.email,
        'asset',
        'user_wallet',
        'PEN'
    ) RETURNING id INTO wallet_account_id;

    -- Crear cuenta de escrow
    INSERT INTO accounts (
        user_id,
        account_number,
        name,
        account_type,
        category,
        currency
    ) VALUES (
        NEW.id,
        'USR-' || account_prefix || '-ESCR',
        'User Escrow - ' || NEW.email,
        'asset',
        'user_escrow',
        'PEN'
    ) RETURNING id INTO escrow_account_id;

    -- Crear registro de wallet
    INSERT INTO wallets (
        user_id,
        available_account_id,
        escrow_account_id,
        currency
    ) VALUES (
        NEW.id,
        wallet_account_id,
        escrow_account_id,
        'PEN'
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para crear cuentas automáticamente al registrar usuario
CREATE TRIGGER user_create_accounts
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION create_user_accounts();

-- ============================================================================
-- FUNCIÓN: Transferencia segura entre cuentas (Double-Entry)
-- Esta es la función CORE para cualquier movimiento de dinero
-- ============================================================================

CREATE OR REPLACE FUNCTION transfer_funds(
    p_from_account_id UUID,
    p_to_account_id UUID,
    p_amount DECIMAL(15, 2),
    p_transaction_type transaction_type,
    p_description TEXT,
    p_reference_type VARCHAR(50) DEFAULT NULL,
    p_reference_id UUID DEFAULT NULL,
    p_initiated_by UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'
) RETURNS UUID AS $$
DECLARE
    v_transaction_id UUID;
    v_from_balance DECIMAL(15, 2);
    v_from_account_type account_type;
BEGIN
    -- Validar que el monto sea positivo
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Transfer amount must be positive';
    END IF;

    -- Validar que las cuentas existan y no estén congeladas
    SELECT balance, account_type INTO v_from_balance, v_from_account_type
    FROM accounts
    WHERE id = p_from_account_id AND NOT frozen
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Source account not found or frozen';
    END IF;

    -- Verificar balance suficiente (solo para cuentas de activo)
    IF v_from_account_type = 'asset' AND v_from_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient balance: % < %', v_from_balance, p_amount;
    END IF;

    -- Verificar cuenta destino
    IF NOT EXISTS (
        SELECT 1 FROM accounts WHERE id = p_to_account_id AND NOT frozen
    ) THEN
        RAISE EXCEPTION 'Destination account not found or frozen';
    END IF;

    -- Crear la transacción
    INSERT INTO transactions (
        reference_type,
        reference_id,
        transaction_type,
        status,
        amount,
        description,
        metadata,
        initiated_by
    ) VALUES (
        p_reference_type,
        p_reference_id,
        p_transaction_type,
        'completed',
        p_amount,
        p_description,
        p_metadata,
        p_initiated_by
    ) RETURNING id INTO v_transaction_id;

    -- Crear entrada de débito (salida de la cuenta origen)
    INSERT INTO ledger_entries (
        transaction_id,
        account_id,
        debit,
        credit,
        running_balance,  -- Se actualiza por trigger
        line_description,
        sequence_number
    ) VALUES (
        v_transaction_id,
        p_from_account_id,
        0,
        p_amount,
        0,  -- Placeholder, se actualiza por trigger
        'Transfer out: ' || p_description,
        1
    );

    -- Crear entrada de crédito (entrada a la cuenta destino)
    INSERT INTO ledger_entries (
        transaction_id,
        account_id,
        debit,
        credit,
        running_balance,
        line_description,
        sequence_number
    ) VALUES (
        v_transaction_id,
        p_to_account_id,
        p_amount,
        0,
        0,
        'Transfer in: ' || p_description,
        2
    );

    -- Actualizar timestamp de transacción completada
    UPDATE transactions
    SET completed_at = CURRENT_TIMESTAMP
    WHERE id = v_transaction_id;

    RETURN v_transaction_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCIÓN: Bloquear fondos en escrow (para órdenes)
-- ============================================================================

CREATE OR REPLACE FUNCTION escrow_funds(
    p_user_id UUID,
    p_amount DECIMAL(15, 2),
    p_order_id UUID,
    p_description TEXT DEFAULT 'Order escrow'
) RETURNS UUID AS $$
DECLARE
    v_wallet_account_id UUID;
    v_escrow_account_id UUID;
    v_transaction_id UUID;
BEGIN
    -- Obtener cuentas del usuario
    SELECT available_account_id, escrow_account_id
    INTO v_wallet_account_id, v_escrow_account_id
    FROM wallets
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User wallet not found';
    END IF;

    -- Transferir de disponible a escrow
    v_transaction_id := transfer_funds(
        v_wallet_account_id,
        v_escrow_account_id,
        p_amount,
        'order_escrow',
        p_description,
        'order',
        p_order_id,
        p_user_id,
        jsonb_build_object('order_id', p_order_id)
    );

    RETURN v_transaction_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCIÓN: Liberar fondos de escrow (cancelación de orden)
-- ============================================================================

CREATE OR REPLACE FUNCTION release_escrow(
    p_user_id UUID,
    p_amount DECIMAL(15, 2),
    p_order_id UUID,
    p_description TEXT DEFAULT 'Order cancelled - escrow release'
) RETURNS UUID AS $$
DECLARE
    v_wallet_account_id UUID;
    v_escrow_account_id UUID;
    v_transaction_id UUID;
BEGIN
    -- Obtener cuentas del usuario
    SELECT available_account_id, escrow_account_id
    INTO v_wallet_account_id, v_escrow_account_id
    FROM wallets
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User wallet not found';
    END IF;

    -- Transferir de escrow a disponible
    v_transaction_id := transfer_funds(
        v_escrow_account_id,
        v_wallet_account_id,
        p_amount,
        'order_release',
        p_description,
        'order',
        p_order_id,
        p_user_id,
        jsonb_build_object('order_id', p_order_id)
    );

    RETURN v_transaction_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCIÓN: Procesar depósito de usuario
-- ============================================================================

CREATE OR REPLACE FUNCTION process_deposit(
    p_user_id UUID,
    p_amount DECIMAL(15, 2),
    p_payment_id UUID,
    p_description TEXT DEFAULT 'Deposit'
) RETURNS UUID AS $$
DECLARE
    v_wallet_account_id UUID;
    v_treasury_account_id UUID;
    v_transaction_id UUID;
BEGIN
    -- Obtener cuenta del usuario
    SELECT available_account_id
    INTO v_wallet_account_id
    FROM wallets
    WHERE user_id = p_user_id;

    -- Obtener cuenta de tesorería
    SELECT account_id INTO v_treasury_account_id
    FROM system_accounts
    WHERE name = 'PLATFORM_TREASURY';

    -- Para depósitos, el dinero "entra" a la plataforma desde la tesorería
    -- En realidad, esto representa que la plataforma recibe el dinero
    -- y lo acredita al usuario
    v_transaction_id := transfer_funds(
        v_treasury_account_id,
        v_wallet_account_id,
        p_amount,
        'deposit',
        p_description,
        'payment',
        p_payment_id,
        p_user_id,
        jsonb_build_object('payment_id', p_payment_id)
    );

    RETURN v_transaction_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCIÓN: Procesar retiro de usuario
-- ============================================================================

CREATE OR REPLACE FUNCTION process_withdrawal(
    p_user_id UUID,
    p_amount DECIMAL(15, 2),
    p_payment_id UUID,
    p_description TEXT DEFAULT 'Withdrawal'
) RETURNS UUID AS $$
DECLARE
    v_wallet_account_id UUID;
    v_treasury_account_id UUID;
    v_transaction_id UUID;
BEGIN
    -- Obtener cuenta del usuario
    SELECT available_account_id
    INTO v_wallet_account_id
    FROM wallets
    WHERE user_id = p_user_id;

    -- Obtener cuenta de tesorería
    SELECT account_id INTO v_treasury_account_id
    FROM system_accounts
    WHERE name = 'PLATFORM_TREASURY';

    -- Transferir de usuario a tesorería (el dinero "sale" de la plataforma)
    v_transaction_id := transfer_funds(
        v_wallet_account_id,
        v_treasury_account_id,
        p_amount,
        'withdrawal',
        p_description,
        'payment',
        p_payment_id,
        p_user_id,
        jsonb_build_object('payment_id', p_payment_id)
    );

    RETURN v_transaction_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCIÓN: Cobrar comisión
-- ============================================================================

CREATE OR REPLACE FUNCTION charge_commission(
    p_user_id UUID,
    p_amount DECIMAL(15, 2),
    p_trade_id UUID,
    p_description TEXT DEFAULT 'Trading commission'
) RETURNS UUID AS $$
DECLARE
    v_escrow_account_id UUID;
    v_commission_account_id UUID;
    v_transaction_id UUID;
BEGIN
    -- Obtener cuenta escrow del usuario
    SELECT escrow_account_id
    INTO v_escrow_account_id
    FROM wallets
    WHERE user_id = p_user_id;

    -- Obtener cuenta de comisiones
    SELECT account_id INTO v_commission_account_id
    FROM system_accounts
    WHERE name = 'COMMISSION_POOL';

    -- Transferir comisión
    v_transaction_id := transfer_funds(
        v_escrow_account_id,
        v_commission_account_id,
        p_amount,
        'commission_charge',
        p_description,
        'trade',
        p_trade_id,
        NULL,  -- Sistema
        jsonb_build_object('trade_id', p_trade_id)
    );

    RETURN v_transaction_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCIÓN: Verificar integridad del ledger
-- Útil para auditorías y debugging
-- ============================================================================

CREATE OR REPLACE FUNCTION verify_ledger_integrity()
RETURNS TABLE (
    check_name VARCHAR(100),
    status VARCHAR(10),
    details TEXT
) AS $$
DECLARE
    v_count INTEGER;
    v_balance_mismatch INTEGER;
BEGIN
    -- Check 1: Todas las transacciones están balanceadas
    check_name := 'Transaction Balance Check';
    SELECT COUNT(*) INTO v_count
    FROM (
        SELECT transaction_id,
               SUM(debit) as total_debit,
               SUM(credit) as total_credit
        FROM ledger_entries
        GROUP BY transaction_id
        HAVING SUM(debit) != SUM(credit)
    ) unbalanced;

    IF v_count = 0 THEN
        status := 'PASS';
        details := 'All transactions are balanced';
    ELSE
        status := 'FAIL';
        details := v_count || ' unbalanced transactions found';
    END IF;
    RETURN NEXT;

    -- Check 2: Balances de cuentas coinciden con ledger
    check_name := 'Account Balance Verification';
    SELECT COUNT(*) INTO v_balance_mismatch
    FROM (
        SELECT
            a.id,
            a.balance as stored_balance,
            COALESCE(SUM(le.debit) - SUM(le.credit), 0) as calculated_balance
        FROM accounts a
        LEFT JOIN ledger_entries le ON le.account_id = a.id
        GROUP BY a.id, a.balance
        HAVING a.balance != COALESCE(SUM(le.debit) - SUM(le.credit), 0)
    ) mismatched;

    IF v_balance_mismatch = 0 THEN
        status := 'PASS';
        details := 'All account balances match ledger';
    ELSE
        status := 'FAIL';
        details := v_balance_mismatch || ' accounts with mismatched balances';
    END IF;
    RETURN NEXT;

    -- Check 3: No hay balances negativos en cuentas de activo
    check_name := 'Negative Balance Check';
    SELECT COUNT(*) INTO v_count
    FROM accounts
    WHERE account_type = 'asset' AND balance < 0;

    IF v_count = 0 THEN
        status := 'PASS';
        details := 'No negative asset balances';
    ELSE
        status := 'FAIL';
        details := v_count || ' asset accounts with negative balance';
    END IF;
    RETURN NEXT;

    -- Check 4: Wallets sincronizados con accounts
    check_name := 'Wallet Sync Check';
    SELECT COUNT(*) INTO v_count
    FROM wallets w
    JOIN accounts a1 ON a1.id = w.available_account_id
    JOIN accounts a2 ON a2.id = w.escrow_account_id
    WHERE w.available_balance != a1.balance
       OR w.escrow_balance != a2.balance;

    IF v_count = 0 THEN
        status := 'PASS';
        details := 'All wallets synchronized with accounts';
    ELSE
        status := 'FAIL';
        details := v_count || ' wallets out of sync';
    END IF;
    RETURN NEXT;

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- ÍNDICES ADICIONALES PARA OPTIMIZACIÓN
-- ============================================================================

-- Índice para búsqueda rápida de transacciones por usuario
CREATE INDEX idx_ledger_user_transactions ON ledger_entries(account_id, created_at DESC);

-- Índice parcial para órdenes activas
CREATE INDEX idx_orders_active_by_price ON orders(market_id, side, limit_price, created_at)
WHERE status IN ('open', 'partially_filled');

-- ============================================================================
-- COMENTARIOS DE DOCUMENTACIÓN
-- ============================================================================

COMMENT ON FUNCTION transfer_funds IS 'Función core para transferencias con double-entry bookkeeping';
COMMENT ON FUNCTION escrow_funds IS 'Bloquea fondos del usuario para una orden';
COMMENT ON FUNCTION release_escrow IS 'Libera fondos bloqueados cuando se cancela una orden';
COMMENT ON FUNCTION process_deposit IS 'Procesa un depósito de fondos del usuario';
COMMENT ON FUNCTION process_withdrawal IS 'Procesa un retiro de fondos del usuario';
COMMENT ON FUNCTION verify_ledger_integrity IS 'Verifica la integridad del sistema de contabilidad';
