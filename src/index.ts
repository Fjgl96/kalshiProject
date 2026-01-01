/**
 * KALSHI PERÚ - Punto de Entrada
 * Plataforma de Mercados de Predicción
 */

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.config';
import { pool, healthCheck } from './config/database.config';

const app = express();

// ============================================================================
// MIDDLEWARE DE SEGURIDAD
// ============================================================================

// Helmet: Headers de seguridad
app.use(helmet());

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
// PLACEHOLDER PARA RUTAS (Se implementarán en fases siguientes)
// ============================================================================

app.get(`/api/${env.API_VERSION}`, (req, res) => {
  res.json({
    message: 'Kalshi Perú API',
    version: env.API_VERSION,
    documentation: '/docs'
  });
});

// ============================================================================
// MANEJO DE ERRORES
// ============================================================================

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message);

  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    ...(env.NODE_ENV === 'development' && { details: err.message })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND'
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
