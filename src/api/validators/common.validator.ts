/**
 * KALSHI PERÚ - Validadores Comunes
 *
 * Middleware de validación usando Zod
 */

import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';

/**
 * Middleware de validación con Zod
 */
export function validateRequest(schema: AnyZodObject) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const formattedErrors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message
        }));

        res.status(400).json({
          success: false,
          error: 'Validation error',
          code: 'VALIDATION_ERROR',
          details: formattedErrors
        });
        return;
      }

      next(error);
    }
  };
}

/**
 * Sanitiza strings para prevenir XSS
 */
export function sanitizeString(str: string): string {
  return str
    .replace(/[<>]/g, '')
    .trim();
}

/**
 * Valida UUID
 */
export function isValidUUID(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}
