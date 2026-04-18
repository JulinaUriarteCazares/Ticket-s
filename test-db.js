const pool = require('./db');

async function test() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('✅ Conexión exitosa:', res.rows[0]);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error de conexión:', err.message || err);
    if (err.code) {
      console.error('Código:', err.code);
    }
    process.exit(1);
  }
}

test();