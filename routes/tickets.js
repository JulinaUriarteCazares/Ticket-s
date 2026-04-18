const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const { randomBytes } = require('crypto');
const QRCode = require('qrcode');

const router = express.Router();

// Comprar ticket (con asiento)
router.post('/purchase', auth, async (req, res) => {
  const { ticket_type_id, quantity = 1 } = req.body;
  const userId = req.user.id;
  const qty = Number(quantity);

  if (!ticket_type_id) {
    return res.status(400).json({ error: 'ticket_type_id es obligatorio' });
  }

  if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
    return res.status(400).json({ error: 'La cantidad debe ser un entero entre 1 y 20' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const typeResult = await client.query(
      'SELECT * FROM ticket_types WHERE id = $1 FOR UPDATE',
      [ticket_type_id]
    );
    const ticketType = typeResult.rows[0];
    if (!ticketType) throw new Error('Tipo de boleto no existe');

    const eventResult = await client.query(
      `SELECT id, name, event_date, event_time, location, image_url, description
       FROM events
       WHERE id = $1`,
      [ticketType.event_id]
    );
    const event = eventResult.rows[0];

    const available = Number(ticketType.capacity) - Number(ticketType.sold);
    if (available < qty) {
      throw new Error(`Solo hay ${available} boletos disponibles para este tipo`);
    }

    const purchasedTickets = [];
    const startSold = Number(ticketType.sold);

    for (let i = 1; i <= qty; i += 1) {
      const seatNumber = (startSold + i).toString();
      const qrCode = randomBytes(16).toString('hex');
      const qrSvg = await QRCode.toString(qrCode, {
        type: 'svg',
        margin: 1,
        width: 180,
        errorCorrectionLevel: 'M'
      });

      await client.query(
        `INSERT INTO tickets (ticket_type_id, user_id, qr_code, seat_number)
         VALUES ($1, $2, $3, $4)`,
        [ticket_type_id, userId, qrCode, seatNumber]
      );

      purchasedTickets.push({
        qrCode,
        qrSvg,
        seatNumber,
        event: event
          ? {
              id: event.id,
              name: event.name,
              event_date: event.event_date,
              event_time: event.event_time,
              location: event.location,
              image_url: event.image_url,
              description: event.description,
            }
          : null,
        ticketType: {
          id: ticketType.id,
          type_name: ticketType.type_name,
          price: Number(ticketType.price),
        },
      });
    }

    await client.query(
      'UPDATE ticket_types SET sold = sold + $2 WHERE id = $1',
      [ticket_type_id, qty]
    );

    await client.query('COMMIT');

    const unitPrice = Number(ticketType.price);
    const total = unitPrice * qty;

    res.json({
      message: 'Compra exitosa',
      quantity: qty,
      ticketType: {
        id: ticketType.id,
        type_name: ticketType.type_name,
        unit_price: unitPrice,
      },
      event: event
        ? {
            id: event.id,
            name: event.name,
            event_date: event.event_date,
            event_time: event.event_time,
            location: event.location,
            image_url: event.image_url,
            description: event.description,
          }
        : null,
      total,
      tickets: purchasedTickets,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Mis tickets
router.get('/my-tickets', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.qr_code, t.seat_number, t.status, t.purchase_date,
              tt.type_name, tt.price,
              e.name as event_name, e.event_date, e.location
       FROM tickets t
       JOIN ticket_types tt ON t.ticket_type_id = tt.id
       JOIN events e ON tt.event_id = e.id
       WHERE t.user_id = $1
       ORDER BY t.purchase_date DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validar ticket
router.put('/validate', auth, async (req, res) => {
  const { qr_code } = req.body;
  try {
    const ticketResult = await pool.query(
      `SELECT t.*, e.organizer_id
       FROM tickets t
       JOIN ticket_types tt ON t.ticket_type_id = tt.id
       JOIN events e ON tt.event_id = e.id
       WHERE t.qr_code = $1`,
      [qr_code]
    );
    const ticket = ticketResult.rows[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    if (req.user.role !== 'admin' && ticket.organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    if (!ticket.status) return res.status(400).json({ error: 'Ticket ya usado' });

    await pool.query('UPDATE tickets SET status = false WHERE id = $1', [ticket.id]);
    res.json({ message: 'Ticket validado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;