/**
 * KALSHI PERÚ - Punto de Entrada
 * Plataforma de Mercados de Predicción
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.config';
import { pool, healthCheck } from './config/database.config';

// Importar rutas
import authRoutes from './api/routes/auth.routes';
import kycRoutes from './api/routes/kyc.routes';
import walletRoutes from './api/routes/wallet.routes';
import paymentRoutes from './api/routes/payment.routes';

// Importar middleware
import { checkMaintenance } from './middleware/auth.middleware';
import { AuthError } from './services/auth.service';
import { KYCError } from './services/kyc.service';
import { WalletError } from './services/wallet.service';
import { PaymentError } from './services/payment.service';

const app = express();

// ============================================================================
// MIDDLEWARE DE SEGURIDAD
// ============================================================================

// Helmet: Headers de seguridad
app.use(helmet());

// CORS
app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting global
const limiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  message: {
    error: 'Too many requests, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// JSON parsing
app.use(express.json({ limit: '10kb' }));

// Verificar modo mantenimiento
app.use(checkMaintenance);

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', async (req, res) => {
  const dbHealthy = await healthCheck();

  res.status(dbHealthy ? 200 : 503).json({
    status: dbHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    version: env.API_VERSION,
    database: dbHealthy ? 'connected' : 'disconnected'
  });
});

// ============================================================================
// RUTAS DE API
// ============================================================================

const apiPrefix = `/api/${env.API_VERSION}`;

// Información del API
app.get(apiPrefix, (req, res) => {
  res.json({
    message: 'Kalshi Perú API',
    version: env.API_VERSION,
    endpoints: {
      auth: `${apiPrefix}/auth`,
      kyc: `${apiPrefix}/kyc`,
      wallet: `${apiPrefix}/wallet`,
      payments: `${apiPrefix}/payments`,
      markets: `${apiPrefix}/markets`,
      orders: `${apiPrefix}/orders`
    }
  });
});

// Rutas de autenticación
app.use(`${apiPrefix}/auth`, authRoutes);

// Rutas KYC
app.use(`${apiPrefix}/kyc`, kycRoutes);

// Rutas de Wallet
app.use(`${apiPrefix}/wallet`, walletRoutes);

// Rutas de Pagos
app.use(`${apiPrefix}/payments`, paymentRoutes);

// ============================================================================
// MANEJO DE ERRORES
// ============================================================================

// Errores de autenticación y KYC
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Manejar errores de autenticación
  if (err instanceof AuthError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code
    });
    return;
  }

  // Manejar errores de KYC
  if (err instanceof KYCError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code
    });
    return;
  }

  // Manejar errores de Wallet
  if (err instanceof WalletError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code
    });
    return;
  }

  // Manejar errores de Pagos
  if (err instanceof PaymentError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code
    });
    return;
  }

  // Errores de Multer (upload de archivos)
  if (err.name === 'MulterError') {
    res.status(400).json({
      success: false,
      error: err.message,
      code: 'FILE_UPLOAD_ERROR'
    });
    return;
  }

  // Log del error
  console.error('Error:', err.message);
  if (env.NODE_ENV === 'development') {
    console.error(err.stack);
  }

  // Error genérico
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    ...(env.NODE_ENV === 'development' && { details: err.message })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    code: 'NOT_FOUND',
    path: req.path
  });
});

// ============================================================================
// INICIO DEL SERVIDOR
// ============================================================================

const server = app.listen(env.PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    KALSHI PERÚ API                        ║
╠═══════════════════════════════════════════════════════════╣
║  Ambiente:  ${env.NODE_ENV.padEnd(44)}║
║  Puerto:    ${env.PORT.toString().padEnd(44)}║
║  API:       ${env.API_BASE_URL.padEnd(44)}║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n🛑 Recibida señal SIGTERM, cerrando...');
  server.close(async () => {
    await pool.end();
    console.log('✅ Servidor cerrado correctamente');
    process.exit(0);
  });
});

export default app;
