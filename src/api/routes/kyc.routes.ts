/**
 * KALSHI PERÚ - Rutas KYC
 */

import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import {
  initiateKYC,
  uploadDocument,
  getKYCDocuments,
  hasRequiredDocuments,
  consultarRENIEC,
  isValidDNI,
  approveKYC,
  rejectKYC
} from '../../services/kyc.service';
import {
  authenticate,
  requireAdmin,
  requirePhoneVerified
} from '../../middleware/auth.middleware';
import { validateRequest } from '../validators/common.validator';
import { query, queryOne } from '../../config/database.config';

const router = Router();

// ============================================================================
// CONFIGURACIÓN DE MULTER
// ============================================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,  // 10MB máximo
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido'));
    }
  }
});

// ============================================================================
// SCHEMAS DE VALIDACIÓN
// ============================================================================

const submitKYCSchema = z.object({
  body: z.object({
    dni: z.string()
      .length(8, 'DNI debe tener 8 dígitos')
      .regex(/^\d{8}$/, 'DNI solo puede contener números'),
    firstName: z.string()
      .min(2, 'Nombre muy corto')
      .max(100, 'Nombre muy largo'),
    lastName: z.string()
      .min(2, 'Apellido muy corto')
      .max(100, 'Apellido muy largo'),
    birthDate: z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato: YYYY-MM-DD'),
    address: z.string()
      .min(10, 'Dirección muy corta')
      .max(200, 'Dirección muy larga')
  })
});

const verifyDNISchema = z.object({
  body: z.object({
    dni: z.string()
      .length(8, 'DNI debe tener 8 dígitos')
      .regex(/^\d{8}$/, 'DNI solo puede contener números')
  })
});

// ============================================================================
// RUTAS PÚBLICAS (requieren autenticación)
// ============================================================================

/**
 * GET /kyc/status
 * Obtiene el estado KYC del usuario
 */
router.get(
  '/status',
  authenticate,
  async (req, res, next) => {
    try {
      const user = await queryOne<{
        kyc_status: string;
        kyc_submitted_at: Date | null;
        kyc_verified_at: Date | null;
        kyc_rejection_reason: string | null;
      }>(`
        SELECT kyc_status, kyc_submitted_at, kyc_verified_at, kyc_rejection_reason
        FROM users WHERE id = $1
      `, [req.user!.sub]);

      const documents = await getKYCDocuments(req.user!.sub);
      const { complete, missing } = await hasRequiredDocuments(req.user!.sub);

      res.json({
        success: true,
        data: {
          status: user?.kyc_status || 'pending',
          submittedAt: user?.kyc_submitted_at,
          verifiedAt: user?.kyc_verified_at,
          rejectionReason: user?.kyc_rejection_reason,
          documents: documents.map(d => ({
            type: d.type,
            uploadedAt: d.uploaded_at,
            verified: d.verified
          })),
          documentsComplete: complete,
          missingDocuments: missing
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /kyc/verify-dni
 * Verifica un DNI contra RENIEC (sin guardar)
 */
router.post(
  '/verify-dni',
  authenticate,
  validateRequest(verifyDNISchema),
  async (req, res, next) => {
    try {
      const { dni } = req.body;

      if (!isValidDNI(dni)) {
        res.status(400).json({
          success: false,
          error: 'DNI inválido'
        });
        return;
      }

      const reniecData = await consultarRENIEC(dni);

      if (!reniecData) {
        res.status(404).json({
          success: false,
          error: 'DNI no encontrado en RENIEC'
        });
        return;
      }

      // Solo retornar información parcial por seguridad
      res.json({
        success: true,
        data: {
          found: true,
          firstName: reniecData.firstName,
          lastName: `${reniecData.lastName} ${reniecData.maternalLastName}`,
          // No retornar dirección ni otros datos sensibles
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /kyc/submit
 * Envía los datos KYC para verificación
 */
router.post(
  '/submit',
  authenticate,
  requirePhoneVerified,
  validateRequest(submitKYCSchema),
  async (req, res, next) => {
    try {
      // Verificar que no tenga KYC ya en proceso
      const currentStatus = await queryOne<{ kyc_status: string }>(`
        SELECT kyc_status FROM users WHERE id = $1
      `, [req.user!.sub]);

      if (currentStatus?.kyc_status === 'verified') {
        res.status(400).json({
          success: false,
          error: 'KYC ya verificado'
        });
        return;
      }

      if (currentStatus?.kyc_status === 'submitted') {
        res.status(400).json({
          success: false,
          error: 'KYC ya en revisión'
        });
        return;
      }

      const result = await initiateKYC(req.user!.sub, req.body, {
        ipAddress: req.ip
      });

      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.message,
          details: result.errors
        });
        return;
      }

      res.json({
        success: true,
        message: result.message,
        data: {
          status: result.status,
          nextStep: 'Sube los documentos requeridos'
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /kyc/documents
 * Sube un documento KYC
 */
router.post(
  '/documents',
  authenticate,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No se recibió ningún archivo'
        });
        return;
      }

      const documentType = req.body.type;
      const validTypes = ['dni_front', 'dni_back', 'selfie', 'proof_of_address'];

      if (!validTypes.includes(documentType)) {
        res.status(400).json({
          success: false,
          error: 'Tipo de documento inválido',
          validTypes
        });
        return;
      }

      const result = await uploadDocument(
        req.user!.sub,
        {
          type: documentType,
          fileBuffer: req.file.buffer,
          mimeType: req.file.mimetype,
          fileName: req.file.originalname
        },
        { ipAddress: req.ip }
      );

      res.json({
        success: result.success,
        data: {
          fileKey: result.fileKey,
          analysis: {
            valid: result.analysis.valid,
            confidence: result.analysis.confidence,
            issues: result.analysis.issues
          }
        },
        message: result.success
          ? 'Documento subido correctamente'
          : 'Documento subido con observaciones'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /kyc/documents
 * Lista los documentos subidos
 */
router.get(
  '/documents',
  authenticate,
  async (req, res, next) => {
    try {
      const documents = await getKYCDocuments(req.user!.sub);
      const { complete, missing } = await hasRequiredDocuments(req.user!.sub);

      res.json({
        success: true,
        data: {
          documents,
          complete,
          missing,
          requiredTypes: ['dni_front', 'dni_back', 'selfie']
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================================
// RUTAS ADMIN
// ============================================================================

/**
 * GET /kyc/admin/pending
 * Lista usuarios pendientes de verificación KYC
 */
router.get(
  '/admin/pending',
  authenticate,
  requireAdmin,
  async (req, res, next) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = (page - 1) * limit;

      const users = await query<{
        id: string;
        email: string;
        phone: string;
        kyc_status: string;
        kyc_submitted_at: Date;
        kyc_documents: unknown[];
      }>(`
        SELECT id, email, phone, kyc_status, kyc_submitted_at, kyc_documents
        FROM users
        WHERE kyc_status = 'submitted'
          AND deleted_at IS NULL
        ORDER BY kyc_submitted_at ASC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const [{ count }] = await query<{ count: string }>(`
        SELECT COUNT(*) as count FROM users
        WHERE kyc_status = 'submitted' AND deleted_at IS NULL
      `);

      res.json({
        success: true,
        data: {
          users,
          pagination: {
            page,
            limit,
            total: parseInt(count),
            totalPages: Math.ceil(parseInt(count) / limit)
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /kyc/admin/:userId/approve
 * Aprueba el KYC de un usuario
 */
router.post(
  '/admin/:userId/approve',
  authenticate,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { notes } = req.body;

      await approveKYC(userId, req.user!.sub, notes);

      res.json({
        success: true,
        message: 'KYC aprobado'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /kyc/admin/:userId/reject
 * Rechaza el KYC de un usuario
 */
router.post(
  '/admin/:userId/reject',
  authenticate,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const { reason } = req.body;

      if (!reason) {
        res.status(400).json({
          success: false,
          error: 'Razón de rechazo requerida'
        });
        return;
      }

      await rejectKYC(userId, req.user!.sub, reason);

      res.json({
        success: true,
        message: 'KYC rechazado'
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
