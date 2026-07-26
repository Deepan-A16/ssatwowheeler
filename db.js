// PostgreSQL Database Setup for Two-Wheeler Parking System
require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');

// SHA-256 helper function to keep usernames and passwords secret in DB
function hashSecret(val) {
  if (!val) return '';
  return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
}

// PostgreSQL Pool Configuration
const poolConfig = process.env.DATABASE_URL
  ? { 
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    }
  : {
      host: process.env.PGHOST || 'localhost',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: process.env.PGDATABASE || 'parking_db',
      port: parseInt(process.env.PGPORT || '5432', 10),
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
    };

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  console.log('Connected to PostgreSQL Database.');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

// Initialize Database Tables & Sample Entries
async function initDatabase() {
  try {
    // 1. Users Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        role VARCHAR(50) NOT NULL DEFAULT 'owner',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Parking Entries Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS parking_entries (
        id SERIAL PRIMARY KEY,
        token_no INTEGER UNIQUE NOT NULL,
        barcode VARCHAR(255),
        veh_type VARCHAR(50) NOT NULL DEFAULT 'BIKE 15',
        veh_no VARCHAR(50) NOT NULL,
        cust_name VARCHAR(255),
        mobile_no VARCHAR(50),
        rate NUMERIC(10, 2) DEFAULT 15,
        payment_mode VARCHAR(50) DEFAULT 'CASH',
        in_date VARCHAR(50) NOT NULL,
        entry_time VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'ACTIVE',
        exit_time VARCHAR(50),
        total_hours INTEGER DEFAULT 1,
        total_amount NUMERIC(10, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Exit History Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exit_history (
        id SERIAL PRIMARY KEY,
        token_no INTEGER NOT NULL,
        barcode VARCHAR(255),
        veh_type VARCHAR(50) NOT NULL,
        veh_no VARCHAR(50) NOT NULL,
        cust_name VARCHAR(255),
        mobile_no VARCHAR(50),
        rate NUMERIC(10, 2),
        payment_mode VARCHAR(50),
        in_date VARCHAR(50) NOT NULL,
        entry_time VARCHAR(50) NOT NULL,
        exit_date VARCHAR(50) NOT NULL,
        exit_time VARCHAR(50) NOT NULL,
        fine_amount NUMERIC(10, 2) DEFAULT 0,
        total_amount NUMERIC(10, 2),
        exited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Fix null exited_at timestamps and purge records older than 45 days
    await pool.query(`UPDATE exit_history SET exited_at = CURRENT_TIMESTAMP WHERE exited_at IS NULL;`);
    const deleteRes = await pool.query(`DELETE FROM exit_history WHERE exited_at < NOW() - INTERVAL '45 days';`);
    if (deleteRes.rowCount > 0) {
      console.log(`Auto-cleaned ${deleteRes.rowCount} customer history records older than 45 days.`);
    }

    // Seed Authorized User with SHA-256 Hashed Username & Password (ssaparking / ssaparking2026)
    const defaultHashedUsername = hashSecret('ssaparking');
    const defaultHashedPassword = hashSecret('ssaparking2026');

    const userRes = await pool.query(
      `SELECT id, username, password FROM users WHERE username = $1 OR username = 'ssaparking'`,
      [defaultHashedUsername]
    );

    if (userRes.rows.length === 0) {
      await pool.query(
        `INSERT INTO users (username, password, full_name, role) VALUES ($1, $2, 'SSA Parking Operator', 'owner')`,
        [defaultHashedUsername, defaultHashedPassword]
      );
    } else {
      const user = userRes.rows[0];
      const newUsername = (user.username && user.username.length === 64) ? user.username : defaultHashedUsername;
      const newPassword = (user.password && user.password.length === 64) ? user.password : defaultHashedPassword;
      await pool.query(
        `UPDATE users SET username = $1, password = $2 WHERE id = $3`,
        [newUsername, newPassword, user.id]
      );
    }

    console.log('PostgreSQL database tables & schema verified successfully.');
  } catch (err) {
    console.error('Error initializing PostgreSQL database schema:', err.message);
  }
}

initDatabase();

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
