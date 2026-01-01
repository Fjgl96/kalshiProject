/**
 * KALSHI PERÚ - Sistema de Migraciones
 *
 * Ejecuta las migraciones SQL en orden
 * Uso:
 *   npm run migrate        - Ejecuta todas las migraciones pendientes
 *   npm run migrate:up     - Ejecuta la siguiente migración
 *   npm run migrate:down   - Revierte la última migración
 */

import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'kalshi_peru',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface Migration {
  id: number;
  name: string;
  applied_at: Date;
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedMigrations(): Promise<string[]> {
  const result = await pool.query<Migration>(
    'SELECT name FROM schema_migrations ORDER BY id'
  );
  return result.rows.map(row => row.name);
}

async function getMigrationFiles(): Promise<string[]> {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  return files
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function runMigration(filename: string): Promise<void> {
  const filepath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filepath, 'utf-8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log(`  Ejecutando: ${filename}`);
    await client.query(sql);

    await client.query(
      'INSERT INTO schema_migrations (name) VALUES ($1)',
      [filename]
    );

    await client.query('COMMIT');
    console.log(`  ✓ Completado: ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function migrate(): Promise<void> {
  console.log('\n🔄 Iniciando migraciones...\n');

  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const files = await getMigrationFiles();

  const pending = files.filter(f => !applied.includes(f));

  if (pending.length === 0) {
    console.log('✓ No hay migraciones pendientes\n');
    return;
  }

  console.log(`📋 ${pending.length} migración(es) pendiente(s):\n`);

  for (const file of pending) {
    await runMigration(file);
  }

  console.log('\n✅ Migraciones completadas\n');
}

async function migrateUp(): Promise<void> {
  console.log('\n🔄 Ejecutando siguiente migración...\n');

  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const files = await getMigrationFiles();

  const pending = files.filter(f => !applied.includes(f));

  if (pending.length === 0) {
    console.log('✓ No hay migraciones pendientes\n');
    return;
  }

  await runMigration(pending[0]);
  console.log('\n✅ Migración completada\n');
}

async function migrateDown(): Promise<void> {
  console.log('\n⚠️  Revertir migración no implementado');
  console.log('Para revertir, ejecuta el script de rollback manualmente\n');
  // En producción, cada migración debería tener su archivo de rollback
  // Ejemplo: 001_initial_schema.down.sql
}

async function main(): Promise<void> {
  const command = process.argv[2];

  try {
    switch (command) {
      case 'up':
        await migrateUp();
        break;
      case 'down':
        await migrateDown();
        break;
      default:
        await migrate();
    }
  } catch (error) {
    console.error('\n❌ Error en migración:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
