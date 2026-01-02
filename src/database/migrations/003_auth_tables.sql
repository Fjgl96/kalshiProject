-- ============================================================================
-- KALSHI PERÚ - Tablas de Autenticación
-- Fase 2: JWT, Refresh Tokens, Verificación SMS
-- ============================================================================

-- ============================================================================
-- TABLA: REFRESH_TOKENS
-- Almacena tokens de refresco para mantener sesiones
-- ============================================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Token hasheado (nunca almacenar el token en texto plano)
    token_hash VARCHAR(64) NOT NULL,

    -- Expiración y estado
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked BOOLEAN DEFAULT FALSE,

    -- Metadata de la sesión
    user_agent TEXT,
    ip_address INET,
    device_info JSONB DEFAULT '{}',

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash)
);

-- Índices para refresh_tokens
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash) WHERE revoked = false;
CREATE INDEX idx_refresh_tokens_cleanup ON refresh_tokens(expires_at) WHERE revoked = false;

-- ============================================================================
-- TABLA: VERIFICATION_CODES
-- Códigos de verificación para SMS y email
-- ============================================================================
CREATE TABLE IF NOT EXISTS verification_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,

    -- Tipo de verificación
    type VARCHAR(20) NOT NULL CHECK (type IN ('phone', 'email', 'password_reset', '2fa')),

    -- Destino (email o teléfono)
    destination VARCHAR(255) NOT NULL,

    -- Código (hasheado para seguridad)
    code_hash VARCHAR(64) NOT NULL,

    -- Control de intentos
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,

    -- Expiración (típicamente 10 minutos)
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Estado
    verified BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMP WITH TIME ZONE,

    -- Metadata
    ip_address INET,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Índices para verification_codes
CREATE INDEX idx_verification_destination ON verification_codes(destination, type);
CREATE INDEX idx_verification_user ON verification_codes(user_id);
CREATE INDEX idx_verification_cleanup ON verification_codes(expires_at);

-- ============================================================================
-- TABLA: LOGIN_ATTEMPTS
-- Registro de intentos de login para detectar ataques
-- ============================================================================
CREATE TABLE IF NOT EXISTS login_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Identificador (email o IP)
    identifier VARCHAR(255) NOT NULL,
    identifier_type VARCHAR(10) NOT NULL CHECK (identifier_type IN ('email', 'ip')),

    -- Resultado
    success BOOLEAN NOT NULL,
    failure_reason VARCHAR(50),

    -- Metadata
    ip_address INET NOT NULL,
    user_agent TEXT,

    -- Timestamp
    attempted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Índice para consultas de rate limiting
CREATE INDEX idx_login_attempts_identifier ON login_attempts(identifier, identifier_type, attempted_at DESC);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip_address, attempted_at DESC);

-- Limpiar intentos antiguos (más de 24 horas)
CREATE INDEX idx_login_attempts_cleanup ON login_attempts(attempted_at);

-- ============================================================================
-- TABLA: PASSWORD_RESET_TOKENS
-- Tokens para recuperación de contraseña
-- ============================================================================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Token hasheado
    token_hash VARCHAR(64) NOT NULL UNIQUE,

    -- Expiración (1 hora típicamente)
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Estado
    used BOOLEAN DEFAULT FALSE,
    used_at TIMESTAMP WITH TIME ZONE,

    -- Metadata
    ip_address INET,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_password_reset_token ON password_reset_tokens(token_hash) WHERE used = false;
CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);

-- ============================================================================
-- FUNCIONES DE UTILIDAD
-- ============================================================================

-- Función para verificar rate limiting de login
CREATE OR REPLACE FUNCTION check_login_rate_limit(
    p_identifier VARCHAR(255),
    p_identifier_type VARCHAR(10),
    p_window_minutes INTEGER DEFAULT 15,
    p_max_attempts INTEGER DEFAULT 5
) RETURNS TABLE (
    allowed BOOLEAN,
    attempts_count INTEGER,
    locked_until TIMESTAMP WITH TIME ZONE
) AS $$
DECLARE
    v_count INTEGER;
    v_window_start TIMESTAMP WITH TIME ZONE;
BEGIN
    v_window_start := NOW() - (p_window_minutes || ' minutes')::INTERVAL;

    -- Contar intentos fallidos en la ventana
    SELECT COUNT(*) INTO v_count
    FROM login_attempts
    WHERE identifier = p_identifier
      AND identifier_type = p_identifier_type
      AND attempted_at > v_window_start
      AND success = false;

    IF v_count >= p_max_attempts THEN
        -- Calcular tiempo de desbloqueo
        RETURN QUERY SELECT
            false,
            v_count,
            (v_window_start + (p_window_minutes || ' minutes')::INTERVAL);
    ELSE
        RETURN QUERY SELECT true, v_count, NULL::TIMESTAMP WITH TIME ZONE;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Función para registrar intento de login
CREATE OR REPLACE FUNCTION record_login_attempt(
    p_identifier VARCHAR(255),
    p_identifier_type VARCHAR(10),
    p_success BOOLEAN,
    p_ip_address INET,
    p_user_agent TEXT DEFAULT NULL,
    p_failure_reason VARCHAR(50) DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    INSERT INTO login_attempts (
        identifier, identifier_type, success, failure_reason, ip_address, user_agent
    ) VALUES (
        p_identifier, p_identifier_type, p_success, p_failure_reason, p_ip_address, p_user_agent
    );

    -- Si es exitoso, limpiar intentos fallidos anteriores para este identificador
    IF p_success THEN
        DELETE FROM login_attempts
        WHERE identifier = p_identifier
          AND identifier_type = p_identifier_type
          AND success = false
          AND attempted_at < NOW() - INTERVAL '1 hour';
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Función para limpiar datos de autenticación expirados
CREATE OR REPLACE FUNCTION cleanup_auth_data() RETURNS TABLE (
    deleted_refresh_tokens INTEGER,
    deleted_verification_codes INTEGER,
    deleted_login_attempts INTEGER,
    deleted_password_resets INTEGER
) AS $$
DECLARE
    v_refresh INTEGER;
    v_verification INTEGER;
    v_login INTEGER;
    v_password INTEGER;
BEGIN
    -- Refresh tokens expirados o revocados hace más de 7 días
    DELETE FROM refresh_tokens
    WHERE expires_at < NOW()
       OR (revoked = true AND last_used_at < NOW() - INTERVAL '7 days');
    GET DIAGNOSTICS v_refresh = ROW_COUNT;

    -- Códigos de verificación expirados
    DELETE FROM verification_codes
    WHERE expires_at < NOW();
    GET DIAGNOSTICS v_verification = ROW_COUNT;

    -- Intentos de login de más de 24 horas
    DELETE FROM login_attempts
    WHERE attempted_at < NOW() - INTERVAL '24 hours';
    GET DIAGNOSTICS v_login = ROW_COUNT;

    -- Password reset tokens expirados o usados
    DELETE FROM password_reset_tokens
    WHERE expires_at < NOW() OR used = true;
    GET DIAGNOSTICS v_password = ROW_COUNT;

    RETURN QUERY SELECT v_refresh, v_verification, v_login, v_password;
END;
$$ LANGUAGE plpgsql;
