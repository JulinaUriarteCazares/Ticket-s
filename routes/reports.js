const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

// Reporte dinámico (en vivo)
router.get('/event/:eventId', auth, async (req, res) => {
  const { eventId } = req.params;
  try {
    const event = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    if (event.rows.length === 0) return res.status(404).json({ error: 'Evento no encontrado' });
    if (req.user.role !== 'admin' && event.rows[0].organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const ticketTypes = await pool.query('SELECT * FROM ticket_types WHERE event_id = $1', [eventId]);
    const sales = await pool.query(
      `SELECT COUNT(t.id) as sold, SUM(tt.price) as total_income
       FROM tickets t
       JOIN ticket_types tt ON t.ticket_type_id = tt.id
       WHERE tt.event_id = $1 AND t.status = true`,
      [eventId]
    );

    const report = {
      event: event.rows[0],
      ticket_types: ticketTypes.rows,
      total_tickets_sold: sales.rows[0].sold || 0,
      total_income: sales.rows[0].total_income || 0,
    };
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Guardar reporte en tabla reports
router.post('/generate/:eventId', auth, async (req, res) => {
  const { eventId } = req.params;
  try {
    const event = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    if (event.rows.length === 0) return res.status(404).json({ error: 'Evento no encontrado' });
    if (req.user.role !== 'admin' && event.rows[0].organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const ticketTypes = await pool.query('SELECT * FROM ticket_types WHERE event_id = $1', [eventId]);
    const sales = await pool.query(
      `SELECT COUNT(t.id) as sold, SUM(tt.price) as total_income
       FROM tickets t
       JOIN ticket_types tt ON t.ticket_type_id = tt.id
       WHERE tt.event_id = $1 AND t.status = true`,
      [eventId]
    );

    const totalSold = sales.rows[0].sold || 0;
    const totalIncome = sales.rows[0].total_income || 0;

    const result = await pool.query(
      `INSERT INTO reports 
       (event_id, event_name, location, event_date, event_time, total_capacity, tickets_sold, total_income, artist_name, artist_fee, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        eventId,
        event.rows[0].name,
        event.rows[0].location,
        event.rows[0].event_date,
        event.rows[0].event_time,
        event.rows[0].capacity,
        totalSold,
        totalIncome,
        event.rows[0].artist_name,
        event.rows[0].artist_fee,
        req.user.id
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener todos los reportes guardados
router.get('/saved', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reports ORDER BY generated_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener reportes guardados de un evento específico
router.get('/saved/:eventId', auth, async (req, res) => {
  const { eventId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM reports WHERE event_id = $1 ORDER BY generated_at DESC',
      [eventId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;