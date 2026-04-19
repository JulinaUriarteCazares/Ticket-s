const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return EMAIL_REGEX.test(normalizeEmail(email));
}

function getMinPasswordLengthByRole(role) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (normalizedRole === 'organizer' || normalizedRole === 'admin') {
    return 4;
  }
  return 6;
}

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

async function cleanupUserAccount(client, userId) {
  await client.query('DELETE FROM tickets WHERE user_id = $1', [userId]);

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
}

router.post('/register', async (req, res) => {
  const { name, email, password, role = 'user' } = req.body;
  const normalizedEmail = normalizeEmail(email);
  const normalizedName = String(name || '').trim();

  if (!normalizedName || !normalizedEmail || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña son obligatorios' });
  }

  if (!isValidEmail(normalizedEmail)) {
    return res.status(400).json({ error: 'Debes ingresar un correo electronico valido' });
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
  const minPasswordLength = getMinPasswordLengthByRole(finalRole);

  if (String(password).length < minPasswordLength) {
    return res.status(400).json({
      error: `La contrasena para ${finalRole} debe tener al menos ${minPasswordLength} caracteres`,
    });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [normalizedName, normalizedEmail, hashed, finalRole]
    );
    const createdUser = result.rows[0];

    // Auto-login only for first-party self registration (no authenticated requester).
    if (!requesterRole) {
      const token = jwt.sign({ id: createdUser.id, role: createdUser.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
      return res.status(201).json({
        message: 'Registro exitoso',
        token,
        user: createdUser,
      });
    }

    return res.status(201).json({
      message: 'Usuario creado correctamente',
      user: createdUser,
    });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'El correo ya está registrado' });
    if (err.code === '42P01') return res.status(500).json({ error: 'La tabla users no existe en la base de datos' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    return res.status(400).json({ error: 'Email y contraseña son obligatorios' });
  }

  if (!isValidEmail(normalizedEmail)) {
    return res.status(400).json({ error: 'Debes ingresar un correo electronico valido' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
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

router.patch('/me', auth, async (req, res) => {
  const { name, current_password: currentPassword, new_password: newPassword } = req.body || {};
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const nextName = String(name || '').trim();
  const nextPassword = String(newPassword || '');
  const wantsNameChange = Boolean(nextName);
  const wantsPasswordChange = Boolean(nextPassword);

  if (!wantsNameChange && !wantsPasswordChange) {
    return res.status(400).json({ error: 'No hay cambios para actualizar' });
  }

  if (wantsNameChange && nextName.length < 2) {
    return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres' });
  }

  if (wantsPasswordChange && !currentPassword) {
    return res.status(400).json({ error: 'Debes ingresar tu contrasena actual' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      'SELECT id, name, email, role, password_hash FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );

    const user = userResult.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const minPasswordLength = getMinPasswordLengthByRole(user.role);
    if (wantsPasswordChange && nextPassword.length < minPasswordLength) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `La nueva contrasena para ${user.role} debe tener al menos ${minPasswordLength} caracteres`,
      });
    }

    let updatedPasswordHash = user.password_hash;
    if (wantsPasswordChange) {
      const validPassword = await bcrypt.compare(String(currentPassword), String(user.password_hash));
      if (!validPassword) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Contrasena actual incorrecta' });
      }
      updatedPasswordHash = await bcrypt.hash(nextPassword, 10);
    }

    const updatedName = wantsNameChange ? nextName : user.name;

    const updateResult = await client.query(
      `UPDATE users
       SET name = $2,
           password_hash = $3
       WHERE id = $1
       RETURNING id, name, email, role`,
      [userId, updatedName, updatedPasswordHash]
    );

    await client.query('COMMIT');
    return res.json({
      message: 'Perfil actualizado correctamente',
      user: updateResult.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
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

    await cleanupUserAccount(client, userId);
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

router.get('/users', auth, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Solo un admin puede ver los usuarios' });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, role
       FROM users
       ORDER BY
         CASE role
           WHEN 'admin' THEN 1
           WHEN 'organizer' THEN 2
           ELSE 3
         END,
         name ASC`
    );

    return res.json({ users: result.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', auth, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Solo un admin puede eliminar usuarios' });
  }

  const targetUserId = String(req.params.id || '').trim();
  if (!targetUserId) {
    return res.status(400).json({ error: 'Debes indicar un usuario valido' });
  }

  if (String(req.user?.id || '') === targetUserId) {
    return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta desde este panel' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [targetUserId]
    );
    const targetUser = userResult.rows[0];

    if (!targetUser) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    await cleanupUserAccount(client, targetUserId);
    await client.query('DELETE FROM users WHERE id = $1', [targetUserId]);

    await client.query('COMMIT');
    return res.json({ message: 'Usuario eliminado correctamente' });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;