const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events ORDER BY event_date');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
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
  const { name, location, event_date, event_time, description, capacity, artist_name, artist_fee } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [name, location, event_date, event_time, description, capacity, artist_name, artist_fee, req.user.id]
    );
    res.status(201).json(result.rows[0]);
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