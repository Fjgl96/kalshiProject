/**
 * KALSHI PERÚ - Rutas de Autenticación
 */

import { Router } from 'express';
import { z } from 'zod';
import { register, login, logout, logoutAll, changePassword } from '../../services/user.service';
import { refreshTokens } from '../../services/auth.service';
import { sendVerificationCode, verifyCode, resendVerificationCode } from '../../services/sms.service';
import { authenticate, authRateLimiter, smsRateLimiter } from '../../middleware/auth.middleware';
import { validateRequest } from '../validators/common.validator';

const router = Router();

// ============================================================================
// SCHEMAS DE VALIDACIÓN
// ============================================================================

const registerSchema = z.object({
  body: z.object({
    email: z.string().email('Email inválido'),
    password: z.string().min(8, 'Mínimo 8 caracteres'),
    phone: z.string().regex(/^\+51[19]\d{8}$/, 'Formato: +51 9XX XXX XXX'),
    acceptTerms: z.literal(true, {
      errorMap: () => ({ message: 'Debes aceptar los términos' })
    })
  })
});

const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Email inválido'),
    password: z.string().min(1, 'Contraseña requerida')
  })
});

const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'Refresh token requerido')
  })
});

const verifyPhoneSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^\+51[19]\d{8}$/, 'Formato: +51 9XX XXX XXX'),
    code: z.string().length(6, 'Código de 6 dígitos')
  })
});

const sendCodeSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^\+51[19]\d{8}$/, 'Formato: +51 9XX XXX XXX')
  })
});

const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'Contraseña actual requerida'),
    newPassword: z.string().min(8, 'Mínimo 8 caracteres')
  })
});

// ============================================================================
// RUTAS
// ============================================================================

/**
 * POST /auth/register
 * Registra un nuevo usuario
 */
router.post(
  '/register',
  authRateLimiter,
  validateRequest(registerSchema),
  async (req, res, next) => {
    try {
      const result = await register(req.body, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });

      res.status(201).json({
        success: true,
        message: 'Registro exitoso',
        data: {
          user: result.user,
          tokens: result.tokens
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /auth/login
 * Inicia sesión
 */
router.post(
  '/login',
  authRateLimiter,
  validateRequest(loginSchema),
  async (req, res, next) => {
    try {
      const result = await login(req.body, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });

      res.json({
        success: true,
        message: 'Login exitoso',
        data: {
          user: result.user,
          tokens: result.tokens
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /auth/refresh
 * Renueva tokens usando refresh token
 */
router.post(
  '/refresh',
  validateRequest(refreshSchema),
  async (req, res, next) => {
    try {
      const tokens = await refreshTokens(req.body.refreshToken, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });

      res.json({
        success: true,
        data: { tokens }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /auth/logout
 * Cierra la sesión actual
 */
router.post(
  '/logout',
  authenticate,
  async (req, res, next) => {
    try {
      const refreshToken = req.body.refreshToken;

      if (refreshToken) {
        await logout(req.user!.sub, refreshToken, {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent']
        });
      }

      res.json({
        success: true,
        message: 'Sesión cerrada'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /auth/logout-all
 * Cierra todas las sesiones del usuario
 */
router.post(
  '/logout-all',
  authenticate,
  async (req, res, next) => {
    try {
      const count = await logoutAll(req.user!.sub, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });

      res.json({
        success: true,
        message: `${count} sesiones cerradas`
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /auth/change-password
 * Cambia la contraseña del usuario
 */
router.post(
  '/change-password',
  authenticate,
  validateRequest(changePasswordSchema),
  async (req, res, next) => {
    try {
      await changePassword(
        req.user!.sub,
        req.body.currentPassword,
        req.body.newPassword,
        {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent']
        }
      );

      res.json({
        success: true,
        message: 'Contraseña actualizada. Todas las sesiones han sido cerradas.'
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// VERIFICACIÓN DE TELÉFONO
// ============================================================================

/**
 * POST /auth/phone/send-code
 * Envía código de verificación por SMS
 */
router.post(
  '/phone/send-code',
  authenticate,
  smsRateLimiter,
  validateRequest(sendCodeSchema),
  async (req, res, next) => {
    try {
      const result = await sendVerificationCode(
        req.body.phone,
        'phone',
        req.user!.sub,
        { ipAddress: req.ip }
      );

      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.error
        });
        return;
      }

      res.json({
        success: true,
        message: 'Código enviado',
        data: {
          expiresAt: result.expiresAt
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /auth/phone/verify
 * Verifica el código SMS
 */
router.post(
  '/phone/verify',
  authenticate,
  validateRequest(verifyPhoneSchema),
  async (req, res, next) => {
    try {
      const result = await verifyCode(
        req.body.phone,
        req.body.code,
        'phone',
        { ipAddress: req.ip }
      );

      if (!result.valid) {
        res.status(400).json({
          success: false,
          error: result.error,
          remainingAttempts: result.remainingAttempts
        });
        return;
      }

      res.json({
        success: true,
        message: 'Teléfono verificado correctamente'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /auth/phone/resend
 * Reenvía código de verificación
 */
router.post(
  '/phone/resend',
  authenticate,
  smsRateLimiter,
  validateRequest(sendCodeSchema),
  async (req, res, next) => {
    try {
      const result = await resendVerificationCode(
        req.body.phone,
        'phone',
        req.user!.sub,
        { ipAddress: req.ip }
      );

      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.error,
          waitSeconds: result.waitSeconds
        });
        return;
      }

      res.json({
        success: true,
        message: 'Código reenviado',
        data: {
          expiresAt: result.expiresAt
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
