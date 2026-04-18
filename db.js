const { Pool } = require('pg');
require('dotenv').config();

const hasConnectionString = Boolean(process.env.DATABASE_URL);
const usingRemoteHost = Boolean(process.env.DB_HOST && process.env.DB_HOST !== 'localhost');

const poolConfig = hasConnectionString
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ...(usingRemoteHost ? { ssl: { rejectUnauthorized: false } } : {}),
    };

const pool = new Pool(poolConfig);

module.exports = pool;