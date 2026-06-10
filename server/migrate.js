import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, 'migrations');

export function runMigrations() {
  console.log('Checking database migrations...');
    
  // Create migrations tracking table if it doesn't exist
  db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT UNIQUE NOT NULL,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

  // Get applied migrations
  const appliedMigrations = new Set(
    db.prepare('SELECT filename FROM migrations').all().map(m => m.filename),
  );

  // Get available migration files
  let migrationFiles = [];
  if (fs.existsSync(migrationsDir)) {
    migrationFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort(); // ensures 001_, 002_ ordering
  }

  // Apply new migrations
  for (const file of migrationFiles) {
    if (!appliedMigrations.has(file)) {
      console.log(`Applying migration: ${file}`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
            
      // Run within a transaction
      const runTransaction = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(file);
      });
            
      try {
        runTransaction();
        console.log(`Successfully applied ${file}`);
      } catch (err) {
        console.error(`Error applying migration ${file}:`, err);
        process.exit(1);
      }
    }
  }
    
  console.log('Database migrations up to date.');
}
