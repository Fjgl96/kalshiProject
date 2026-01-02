/**
 * KALSHI PERÚ - Middleware de Autenticación y Autorización
 *
 * Middleware para proteger rutas y verificar permisos.
 *
 * CAPAS DE SEGURIDAD:
 * 1. authenticate: Verifica JWT válido
 * 2. requireKYC: Verifica KYC completado
 * 3. requireAdmin: Verifica rol de administrador
 * 4. rateLimit: Limita requests por usuario/IP
 */

import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyAccessToken, DecodedToken, AuthError } from '../services/auth.service';
import { env } from '../config/env.config';
import { query } from '../config/database.config';

// ============================================================================
// EXTENDER TIPOS DE EXPRESS
// ============================================================================

declare global {
  namespace Express {
    interface Request {
      user?: DecodedToken;
      sessionId?: string;
    }
  }
}

// ============================================================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================================================

/**
 * Middleware que verifica el JWT y adjunta el usuario al request
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({
        error: 'No authorization header',
        code: 'NO_TOKEN'
      });
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Invalid authorization format',
        code: 'INVALID_FORMAT'
      });
      return;
    }

    const token = authHeader.slice(7);
    const decoded = verifyAccessToken(token);

    // Adjuntar usuario al request
    req.user = decoded;
    req.sessionId = decoded.jti;

    next();
  } catch (error) {
    if (error instanceof AuthError) {
      res.status(error.statusCode).json({
        error: error.message,
        code: error.code
      });
      return;
    }

    res.status(401).json({
      error: 'Authentication failed',
      code: 'AUTH_FAILED'
    });
  }
}

/**
 * Middleware opcional de autenticación
 * No falla si no hay token, pero adjunta el usuario si existe
 */
export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      req.user = verifyAccessToken(token);
      req.sessionId = req.user.jti;
    }
  } catch {
    // Ignorar errores, continuar sin autenticación
  }

  next();
}

// ============================================================================
// MIDDLEWARE DE AUTORIZACIÓN
// ============================================================================

/**
 * Requiere que el usuario tenga KYC verificado
 */
export function requireKYC(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({
      error: 'Authentication required',
      code: 'NOT_AUTHENTICATED'
    });
    return;
  }

  if (req.user.kyc_status !== 'verified') {
    res.status(403).json({
      error: 'KYC verification required',
      code: 'KYC_REQUIRED',
      kyc_status: req.user.kyc_status
    });
    return;
  }

  next();
}

/**
 * Requiere que el usuario sea administrador
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({
      error: 'Authentication required',
      code: 'NOT_AUTHENTICATED'
    });
    return;
  }

  if (req.user.role !== 'admin') {
    res.status(403).json({
      error: 'Admin access required',
      code: 'ADMIN_REQUIRED'
    });
    return;
  }

  next();
}

/**
 * Requiere que el usuario tenga teléfono verificado
 */
export async function requirePhoneVerified(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      error: 'Authentication required',
      code: 'NOT_AUTHENTICATED'
    });
    return;
  }

  // Verificar en DB (el token puede estar desactualizado)
  const result = await query<{ phone_verified: boolean }>(`
    SELECT phone_verified FROM users WHERE id = $1
  `, [req.user.sub]);

  if (!result[0]?.phone_verified) {
    res.status(403).json({
      error: 'Phone verification required',
      code: 'PHONE_NOT_VERIFIED'
    });
    return;
  }

  next();
}

// ============================================================================
// RATE LIMITING
// ============================================================================

/**
 * Rate limiter por IP para endpoints de autenticación
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutos
  max: env.RATE_LIMIT_AUTH_MAX,
  message: {
    error: 'Too many authentication attempts',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: 15 * 60
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Usar IP + email si está disponible
    const email = req.body?.email?.toLowerCase() || '';
    return `auth:${req.ip}:${email}`;
  }
});

/**
 * Rate limiter para órdenes de trading
 */
export const orderRateLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minuto
  max: env.RATE_LIMIT_ORDER_MAX,
  message: {
    error: 'Too many orders. Please slow down.',
    code: 'ORDER_RATE_LIMIT'
  },
  keyGenerator: (req) => {
    return `order:${req.user?.sub || req.ip}`;
  }
});

/**
 * Rate limiter para SMS
 */
export const smsRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hora
  max: 5,
  message: {
    error: 'Too many SMS requests',
    code: 'SMS_RATE_LIMIT',
    retryAfter: 60 * 60
  },
  keyGenerator: (req) => {
    const phone = req.body?.phone || '';
    return `sms:${phone}:${req.ip}`;
  }
});

// ============================================================================
// MIDDLEWARE DE LOGGING Y AUDITORÍA
// ============================================================================

/**
 * Registra acciones del usuario para auditoría
 */
export function auditLog(action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Guardar tiempo de inicio
    const startTime = Date.now();

    // Continuar con el request
    res.on('finish', async () => {
      try {
        const duration = Date.now() - startTime;

        await query(`
          INSERT INTO audit_logs (
            user_id, session_id, ip_address, user_agent,
            action, resource_type, severity, description, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          req.user?.sub || null,
          req.sessionId || null,
          req.ip,
          req.headers['user-agent'],
          action,
          'api',
          res.statusCode >= 400 ? 'warning' : 'info',
          `${req.method} ${req.path}`,
          JSON.stringify({
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration,
            query: Object.keys(req.query).length > 0 ? req.query : undefined
          })
        ]);
      } catch (error) {
        console.error('Audit log error:', error);
      }
    });

    next();
  };
}

// ============================================================================
// MIDDLEWARE DE SEGURIDAD ADICIONAL
// ============================================================================

/**
 * Verifica que la cuenta no esté suspendida
 */
export async function requireActiveAccount(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      error: 'Authentication required',
      code: 'NOT_AUTHENTICATED'
    });
    return;
  }

  const result = await query<{ status: string }>(`
    SELECT status FROM users WHERE id = $1 AND deleted_at IS NULL
  `, [req.user.sub]);

  if (!result[0]) {
    res.status(401).json({
      error: 'User not found',
      code: 'USER_NOT_FOUND'
    });
    return;
  }

  if (result[0].status !== 'active') {
    res.status(403).json({
      error: 'Account is not active',
      code: 'ACCOUNT_INACTIVE',
      status: result[0].status
    });
    return;
  }

  next();
}

/**
 * Verifica mantenimiento programado
 */
export function checkMaintenance(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (env.MAINTENANCE_MODE) {
    // Permitir a admins durante mantenimiento
    if (req.user?.role === 'admin') {
      next();
      return;
    }

    res.status(503).json({
      error: 'System under maintenance',
      code: 'MAINTENANCE_MODE'
    });
    return;
  }

  next();
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Extrae IP real considerando proxies
 */
export function getRealIP(req: Request): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const ips = (typeof forwardedFor === 'string' ? forwardedFor : forwardedFor[0]).split(',');
    return ips[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Combina múltiples middlewares
 */
export function combineMiddleware(
  ...middlewares: ((req: Request, res: Response, next: NextFunction) => void)[]
) {
  return (req: Request, res: Response, next: NextFunction) => {
    let index = 0;

    const runNext = (err?: Error) => {
      if (err) {
        next(err);
        return;
      }

      if (index >= middlewares.length) {
        next();
        return;
      }

      const middleware = middlewares[index++];
      try {
        middleware(req, res, runNext);
      } catch (error) {
        next(error);
      }
    };

    runNext();
  };
}
