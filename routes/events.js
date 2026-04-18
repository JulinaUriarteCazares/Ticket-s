const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

let imageSupportChecked = false;
let imageSupported = false;

async function ensureImageSupport() {
  if (imageSupportChecked) {
    return imageSupported;
  }

  try {
    const check = await pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'events' AND column_name = 'image_url'
       LIMIT 1`
    );

    if (check.rows.length > 0) {
      imageSupported = true;
      imageSupportChecked = true;
      return true;
    }

    await pool.query('ALTER TABLE events ADD COLUMN image_url TEXT');
    imageSupported = true;
  } catch (err) {
    if (err.code === '42701') {
      imageSupported = true;
    } else {
      imageSupported = false;
    }
  }

  imageSupportChecked = true;
  return imageSupported;
}

function canManageEvent(user, organizerId) {
  if (!user) {
    return false;
  }

  return user.role === 'admin' || String(organizerId) === String(user.id);
}

router.get('/', async (req, res) => {
  try {
    const supportsImage = await ensureImageSupport();

    if (!supportsImage) {
      const fallback = await pool.query('SELECT *, NULL::text AS image_url FROM events ORDER BY event_date');
      return res.json(fallback.rows);
    }

    const result = await pool.query('SELECT * FROM events ORDER BY event_date');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const supportsImage = await ensureImageSupport();
    const selectQuery = supportsImage
      ? 'SELECT * FROM events WHERE id = $1'
      : 'SELECT *, NULL::text AS image_url FROM events WHERE id = $1';
    const result = await pool.query(selectQuery, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Evento no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const { name, location, event_date, event_time, description, capacity, artist_name, artist_fee, image_url = null } = req.body;

  try {
    const supportsImage = await ensureImageSupport();

    let result;
    if (supportsImage) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [name, location, event_date, event_time, description, capacity, artist_name, artist_fee, req.user.id, image_url]
      );
    } else {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *, NULL::text AS image_url`,
        [name, location, event_date, event_time, description, capacity, artist_name, artist_fee, req.user.id]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/image', auth, async (req, res) => {
  const { id } = req.params;
  const { image_url } = req.body;

  if (typeof image_url !== 'string' || !image_url.trim()) {
    return res.status(400).json({ error: 'image_url es obligatorio' });
  }

  try {
    const supportsImage = await ensureImageSupport();
    if (!supportsImage) {
      return res.status(500).json({ error: 'No fue posible habilitar imagenes de eventos' });
    }

    const eventResult = await pool.query(
      'SELECT id, organizer_id FROM events WHERE id = $1',
      [id]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    if (!canManageEvent(req.user, eventResult.rows[0].organizer_id)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const result = await pool.query(
      'UPDATE events SET image_url = $1 WHERE id = $2 RETURNING *',
      [image_url.trim(), id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const {
    name,
    location,
    event_date,
    event_time,
    description,
    capacity,
    artist_name,
    artist_fee
  } = req.body;

  try {
    const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const current = eventResult.rows[0];
    if (!canManageEvent(req.user, current.organizer_id)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const next = {
      name: name ?? current.name,
      location: location ?? current.location,
      event_date: event_date ?? current.event_date,
      event_time: event_time ?? current.event_time,
      description: description ?? current.description,
      capacity: capacity ?? current.capacity,
      artist_name: artist_name ?? current.artist_name,
      artist_fee: artist_fee ?? current.artist_fee
    };

    const result = await pool.query(
      `UPDATE events
       SET name = $1, location = $2, event_date = $3, event_time = $4,
           description = $5, capacity = $6, artist_name = $7, artist_fee = $8
       WHERE id = $9
       RETURNING *`,
      [
        next.name,
        next.location,
        next.event_date,
        next.event_time,
        next.description,
        next.capacity,
        next.artist_name,
        next.artist_fee,
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/ticket-types', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM ticket_types WHERE event_id = $1', [id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/ticket-types', auth, async (req, res) => {
  const { id: eventId } = req.params;
  const { type_name, price, capacity } = req.body;
  try {
    const event = await pool.query('SELECT organizer_id FROM events WHERE id = $1', [eventId]);
    if (event.rows.length === 0) return res.status(404).json({ error: 'Evento no encontrado' });
    if (req.user.role !== 'admin' && event.rows[0].organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const result = await pool.query(
      `INSERT INTO ticket_types (event_id, type_name, price, capacity)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [eventId, type_name, price, capacity]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;