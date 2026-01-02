/**
 * KALSHI PERÚ - Servicio de Autenticación JWT
 *
 * Implementación de JWT con refresh tokens para sesiones seguras.
 *
 * ¿Por qué JWT + Refresh Tokens?
 * - Access token de corta duración (1h) minimiza ventana de ataque
 * - Refresh token de larga duración (7d) mejora UX sin relogin
 * - Tokens firmados con RS256 o HS256 para verificación
 *
 * RIESGOS MITIGADOS:
 * 1. Token robado: Corta expiración + blacklist de refresh tokens
 * 2. Replay attacks: Tokens incluyen timestamps y jti único
 * 3. Token tampering: Firma HMAC-SHA256
 */

import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.config';
import { query, queryOne } from '../config/database.config';
import { hashToken, generateSecureToken } from '../utils/encryption';

// ============================================================================
// TIPOS
// ============================================================================

export interface TokenPayload {
  sub: string;           // User ID
  email: string;
  role: 'user' | 'admin';
  kyc_status: string;
  jti: string;           // JWT ID único
  type: 'access' | 'refresh';
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;     // Segundos hasta expiración
  tokenType: 'Bearer';
}

export interface DecodedToken extends JwtPayload, TokenPayload {}

interface RefreshTokenRecord {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked: boolean;
  created_at: Date;
  last_used_at: Date;
  user_agent: string;
  ip_address: string;
}

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

const ACCESS_TOKEN_EXPIRY = env.JWT_EXPIRES_IN;   // '1h'
const REFRESH_TOKEN_EXPIRY = env.JWT_REFRESH_EXPIRES_IN; // '7d'

// Convertir duración a segundos
function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return 3600; // Default 1h

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 3600;
  }
}

// ============================================================================
// GENERACIÓN DE TOKENS
// ============================================================================

/**
 * Genera un par de tokens (access + refresh) para un usuario
 */
export async function generateTokenPair(
  userId: string,
  email: string,
  role: 'user' | 'admin',
  kycStatus: string,
  metadata: { userAgent?: string; ipAddress?: string } = {}
): Promise<AuthTokens> {
  const jti = uuidv4();

  // Payload del access token
  const accessPayload: TokenPayload = {
    sub: userId,
    email,
    role,
    kyc_status: kycStatus,
    jti,
    type: 'access'
  };

  // Opciones de firma
  const accessOptions: SignOptions = {
    expiresIn: ACCESS_TOKEN_EXPIRY,
    issuer: 'kalshi-peru',
    audience: 'kalshi-peru-api'
  };

  // Generar access token
  const accessToken = jwt.sign(accessPayload, env.JWT_SECRET, accessOptions);

  // Generar refresh token (token opaco + registro en DB)
  const refreshToken = generateSecureToken(48);
  const refreshTokenHash = hashToken(refreshToken);

  // Calcular expiración del refresh token
  const refreshExpiresAt = new Date();
  refreshExpiresAt.setSeconds(
    refreshExpiresAt.getSeconds() + parseExpiry(REFRESH_TOKEN_EXPIRY)
  );

  // Guardar refresh token en base de datos
  await query(`
    INSERT INTO refresh_tokens (
      user_id, token_hash, expires_at, user_agent, ip_address
    ) VALUES ($1, $2, $3, $4, $5)
  `, [
    userId,
    refreshTokenHash,
    refreshExpiresAt,
    metadata.userAgent || 'unknown',
    metadata.ipAddress || 'unknown'
  ]);

  return {
    accessToken,
    refreshToken,
    expiresIn: parseExpiry(ACCESS_TOKEN_EXPIRY),
    tokenType: 'Bearer'
  };
}

// ============================================================================
// VERIFICACIÓN DE TOKENS
// ============================================================================

/**
 * Verifica y decodifica un access token
 */
export function verifyAccessToken(token: string): DecodedToken {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: 'kalshi-peru',
      audience: 'kalshi-peru-api'
    }) as DecodedToken;

    if (decoded.type !== 'access') {
      throw new Error('Invalid token type');
    }

    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AuthError('Token expired', 'TOKEN_EXPIRED');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AuthError('Invalid token', 'INVALID_TOKEN');
    }
    throw error;
  }
}

/**
 * Renueva tokens usando un refresh token válido
 */
export async function refreshTokens(
  refreshToken: string,
  metadata: { userAgent?: string; ipAddress?: string } = {}
): Promise<AuthTokens> {
  const tokenHash = hashToken(refreshToken);

  // Buscar refresh token en DB
  const record = await queryOne<RefreshTokenRecord & { email: string; role: string; kyc_status: string }>(`
    SELECT rt.*, u.email,
           CASE WHEN u.is_admin THEN 'admin' ELSE 'user' END as role,
           u.kyc_status
    FROM refresh_tokens rt
    JOIN users u ON u.id = rt.user_id
    WHERE rt.token_hash = $1
      AND rt.revoked = false
      AND rt.expires_at > NOW()
      AND u.deleted_at IS NULL
      AND u.status = 'active'
  `, [tokenHash]);

  if (!record) {
    throw new AuthError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }

  // Revocar el token actual (rotación de refresh tokens)
  await query(`
    UPDATE refresh_tokens
    SET revoked = true, last_used_at = NOW()
    WHERE id = $1
  `, [record.id]);

  // Generar nuevo par de tokens
  return generateTokenPair(
    record.user_id,
    record.email,
    record.role as 'user' | 'admin',
    record.kyc_status,
    metadata
  );
}

// ============================================================================
// REVOCACIÓN DE TOKENS
// ============================================================================

/**
 * Revoca un refresh token específico (logout de una sesión)
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken);

  await query(`
    UPDATE refresh_tokens
    SET revoked = true
    WHERE token_hash = $1
  `, [tokenHash]);
}

/**
 * Revoca todos los refresh tokens de un usuario (logout de todas las sesiones)
 */
export async function revokeAllUserTokens(userId: string): Promise<number> {
  const result = await query<{ count: number }>(`
    UPDATE refresh_tokens
    SET revoked = true
    WHERE user_id = $1 AND revoked = false
    RETURNING 1
  `, [userId]);

  return result.length;
}

/**
 * Limpia tokens expirados (job de mantenimiento)
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const result = await query<{ count: number }>(`
    DELETE FROM refresh_tokens
    WHERE expires_at < NOW() OR revoked = true
    RETURNING 1
  `, []);

  return result.length;
}

// ============================================================================
// GESTIÓN DE SESIONES
// ============================================================================

/**
 * Obtiene todas las sesiones activas de un usuario
 */
export async function getUserSessions(userId: string): Promise<{
  id: string;
  userAgent: string;
  ipAddress: string;
  createdAt: Date;
  lastUsedAt: Date;
}[]> {
  const sessions = await query<{
    id: string;
    user_agent: string;
    ip_address: string;
    created_at: Date;
    last_used_at: Date;
  }>(`
    SELECT id, user_agent, ip_address, created_at, last_used_at
    FROM refresh_tokens
    WHERE user_id = $1
      AND revoked = false
      AND expires_at > NOW()
    ORDER BY last_used_at DESC
  `, [userId]);

  return sessions.map(s => ({
    id: s.id,
    userAgent: s.user_agent,
    ipAddress: s.ip_address,
    createdAt: s.created_at,
    lastUsedAt: s.last_used_at
  }));
}

/**
 * Revoca una sesión específica por ID
 */
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const result = await query(`
    UPDATE refresh_tokens
    SET revoked = true
    WHERE id = $1 AND user_id = $2 AND revoked = false
    RETURNING 1
  `, [sessionId, userId]);

  return result.length > 0;
}

// ============================================================================
// CLASE DE ERROR PERSONALIZADA
// ============================================================================

export class AuthError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 401
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// ============================================================================
// MIGRACIÓN ADICIONAL PARA REFRESH TOKENS
// ============================================================================

export const refreshTokensMigration = `
-- Tabla para almacenar refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT,
  ip_address INET,

  CONSTRAINT refresh_tokens_token_hash_unique UNIQUE (token_hash)
);

-- Índices para búsqueda rápida
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash) WHERE revoked = false;
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at) WHERE revoked = false;

-- Limpiar tokens expirados automáticamente (opcional, ejecutar como cron job)
-- SELECT cleanup_expired_tokens();
`;
