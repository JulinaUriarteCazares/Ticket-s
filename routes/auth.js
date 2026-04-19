const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

function getRequesterRoleFromAuthHeader(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice(7).trim();
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.role || null;
  } catch (err) {
    return null;
  }
}

router.post('/register', async (req, res) => {
  const { name, email, password, role = 'user' } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña son obligatorios' });
  }

  const allowedRoles = ['user', 'organizer', 'admin'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }

  const requesterRole = getRequesterRoleFromAuthHeader(req);
  const canCreatePrivilegedUser = requesterRole === 'admin';
  const requestedRole = String(role || 'user');

  if (!canCreatePrivilegedUser && requestedRole !== 'user') {
    return res.status(403).json({ error: 'Solo un admin puede registrar organizadores o administradores' });
  }

  const finalRole = canCreatePrivilegedUser ? requestedRole : 'user';

  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, hashed, finalRole]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'El correo ya está registrado' });
    if (err.code === '42P01') return res.status(500).json({ error: 'La tabla users no existe en la base de datos' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son obligatorios' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Credenciales inválidas' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/me', auth, async (req, res) => {
  const { password, confirm_text: confirmText } = req.body || {};
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  if (!password) {
    return res.status(400).json({ error: 'La contraseña es obligatoria' });
  }

  if (String(confirmText || '').trim().toUpperCase() !== 'ELIMINAR') {
    return res.status(400).json({ error: 'Debes escribir ELIMINAR para confirmar' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      'SELECT id, password_hash FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const user = userResult.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Contraseña incorrecta' });
    }

    // Remove owned tickets to satisfy foreign-key constraints.
    await client.query('DELETE FROM tickets WHERE user_id = $1', [userId]);

    // Best-effort cleanup for optional tables in some deployments.
    try {
      await client.query('UPDATE reports SET generated_by = NULL WHERE generated_by = $1', [userId]);
    } catch (err) {
      if (err.code !== '42P01') {
        throw err;
      }
    }

    try {
      await client.query('UPDATE seats SET reserved_by = NULL, reserved_until = NULL WHERE reserved_by = $1', [userId]);
    } catch (err) {
      if (err.code !== '42P01') {
        throw err;
      }
    }

    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    await client.query('COMMIT');
    return res.json({ message: 'Cuenta eliminada correctamente' });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;