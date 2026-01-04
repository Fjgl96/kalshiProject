-- ============================================================================
-- MIGRACIÓN 004: SISTEMA DE DISPUTAS DE MERCADOS
-- ============================================================================
-- Fase 4: Sistema de disputas para resolución de mercados
-- ============================================================================

-- Tabla de disputas de mercados
CREATE TABLE IF NOT EXISTS market_disputes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    evidence TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'reviewing', 'resolved', 'rejected')),
    resolution TEXT,
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Un usuario solo puede tener una disputa activa por mercado
    CONSTRAINT unique_active_dispute UNIQUE (market_id, user_id, status)
);

-- Índices para disputas
CREATE INDEX IF NOT EXISTS idx_disputes_market ON market_disputes(market_id);
CREATE INDEX IF NOT EXISTS idx_disputes_user ON market_disputes(user_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON market_disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_pending ON market_disputes(market_id)
    WHERE status IN ('pending', 'reviewing');

-- Agregar columnas de disputa a markets si no existen
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'markets' AND column_name = 'dispute_period_ends'
    ) THEN
        ALTER TABLE markets ADD COLUMN dispute_period_ends TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'markets' AND column_name = 'resolved_by'
    ) THEN
        ALTER TABLE markets ADD COLUMN resolved_by UUID REFERENCES users(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'markets' AND column_name = 'resolved_at'
    ) THEN
        ALTER TABLE markets ADD COLUMN resolved_at TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'markets' AND column_name = 'resolution_source'
    ) THEN
        ALTER TABLE markets ADD COLUMN resolution_source VARCHAR(50);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'markets' AND column_name = 'settled_at'
    ) THEN
        ALTER TABLE markets ADD COLUMN settled_at TIMESTAMPTZ;
    END IF;
END $$;

-- Agregar columnas de liquidación a positions si no existen
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'positions' AND column_name = 'settled'
    ) THEN
        ALTER TABLE positions ADD COLUMN settled BOOLEAN DEFAULT FALSE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'positions' AND column_name = 'settled_at'
    ) THEN
        ALTER TABLE positions ADD COLUMN settled_at TIMESTAMPTZ;
    END IF;
END $$;

-- Agregar columna cancel_reason a orders si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'orders' AND column_name = 'cancel_reason'
    ) THEN
        ALTER TABLE orders ADD COLUMN cancel_reason VARCHAR(100);
    END IF;
END $$;

-- Índices adicionales para liquidación
CREATE INDEX IF NOT EXISTS idx_markets_settlement_ready ON markets(dispute_period_ends)
    WHERE resolution IS NOT NULL AND status = 'closed';

CREATE INDEX IF NOT EXISTS idx_positions_settled ON positions(settled);
CREATE INDEX IF NOT EXISTS idx_positions_market_user ON positions(market_id, user_id);

-- Trigger para notificar cuando una disputa es creada
CREATE OR REPLACE FUNCTION notify_dispute_created()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('dispute_created', json_build_object(
        'dispute_id', NEW.id,
        'market_id', NEW.market_id,
        'user_id', NEW.user_id,
        'reason', NEW.reason
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_dispute_created ON market_disputes;
CREATE TRIGGER trigger_dispute_created
    AFTER INSERT ON market_disputes
    FOR EACH ROW
    EXECUTE FUNCTION notify_dispute_created();

-- Función para verificar si un mercado puede ser liquidado
CREATE OR REPLACE FUNCTION can_settle_market(p_market_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_market RECORD;
    v_pending_disputes INTEGER;
BEGIN
    SELECT * INTO v_market FROM markets WHERE id = p_market_id;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Debe tener resolución
    IF v_market.resolution IS NULL THEN
        RETURN FALSE;
    END IF;

    -- No debe estar ya liquidado
    IF v_market.status = 'settled' THEN
        RETURN FALSE;
    END IF;

    -- Debe haber pasado el período de disputa
    IF v_market.dispute_period_ends > NOW() THEN
        RETURN FALSE;
    END IF;

    -- No debe tener disputas pendientes
    SELECT COUNT(*) INTO v_pending_disputes
    FROM market_disputes
    WHERE market_id = p_market_id AND status IN ('pending', 'reviewing');

    IF v_pending_disputes > 0 THEN
        RETURN FALSE;
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Vista para mercados listos para liquidación
CREATE OR REPLACE VIEW markets_ready_for_settlement AS
SELECT
    m.id,
    m.title,
    m.resolution,
    m.resolved_at,
    m.dispute_period_ends,
    (SELECT COUNT(*) FROM positions WHERE market_id = m.id AND quantity > 0) as active_positions,
    (SELECT COUNT(*) FROM orders WHERE market_id = m.id AND status IN ('pending', 'partial')) as pending_orders
FROM markets m
WHERE can_settle_market(m.id) = TRUE;

-- Comentarios
COMMENT ON TABLE market_disputes IS 'Disputas sobre resolución de mercados';
COMMENT ON COLUMN market_disputes.reason IS 'Razón de la disputa';
COMMENT ON COLUMN market_disputes.evidence IS 'Evidencia adicional proporcionada';
COMMENT ON COLUMN market_disputes.status IS 'Estado: pending, reviewing, resolved, rejected';
COMMENT ON FUNCTION can_settle_market(UUID) IS 'Verifica si un mercado puede ser liquidado';
