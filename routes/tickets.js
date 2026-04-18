const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const { randomBytes } = require('crypto');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

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

      const insertResult = await client.query(
        `INSERT INTO tickets (ticket_type_id, user_id, qr_code, seat_number)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [ticket_type_id, userId, qrCode, seatNumber]
      );

      purchasedTickets.push({
        id: insertResult.rows[0].id,
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

router.get('/:ticketId/pdf', auth, async (req, res) => {
  const { ticketId } = req.params;

  try {
    const result = await pool.query(
      `SELECT t.id, t.qr_code, t.seat_number, t.user_id, t.status, t.purchase_date,
              tt.id AS ticket_type_id, tt.type_name, tt.price,
              e.id AS event_id, e.name, e.event_date, e.event_time, e.location, e.image_url, e.description
       FROM tickets t
       JOIN ticket_types tt ON t.ticket_type_id = tt.id
       JOIN events e ON tt.event_id = e.id
       WHERE t.id = $1`,
      [ticketId]
    );

    const ticket = result.rows[0];
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket no encontrado' });
    }

    if (req.user.role !== 'admin' && String(ticket.user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const qrDataUrl = await QRCode.toDataURL(ticket.qr_code, {
      margin: 1,
      width: 220,
      errorCorrectionLevel: 'M'
    });

    let eventImageBuffer = null;
    if (ticket.image_url && /^https?:\/\//i.test(ticket.image_url)) {
      try {
        const imageResponse = await fetch(ticket.image_url);
        if (imageResponse.ok) {
          const arrayBuffer = await imageResponse.arrayBuffer();
          eventImageBuffer = Buffer.from(arrayBuffer);
        }
      } catch (err) {
        eventImageBuffer = null;
      }
    }

    const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const fileName = `boleto-${String(ticket.name || 'evento').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${ticket.seat_number}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    document.pipe(res);

    const pageWidth = document.page.width;
    const pageHeight = document.page.height;
    const panelX = 28;
    const panelY = 28;
    const panelWidth = pageWidth - 56;
    const panelHeight = pageHeight - 56;
    const posterWidth = 260;
    const qrWidth = 215;
    const contentWidth = panelWidth - posterWidth - qrWidth;

    document.rect(panelX, panelY, panelWidth, panelHeight).fillAndStroke('#ffffff', '#7a2df0');
    document.rect(panelX + posterWidth, panelY, contentWidth, panelHeight).fill('#ffffff');

    if (eventImageBuffer) {
      document.image(eventImageBuffer, panelX, panelY, { width: posterWidth, height: panelHeight });
    } else {
      document.rect(panelX, panelY, posterWidth, panelHeight).fill('#111318');
      document.fillColor('#f5f5f5').fontSize(22).text('EVENTO', panelX + 24, panelY + 24, { width: posterWidth - 48, align: 'center' });
    }

    document.fillColor('#7a2df0').fontSize(11).font('Helvetica-Bold').text('Ticketmaster', panelX + posterWidth + 28, panelY + 28, { width: contentWidth - 56, align: 'left' });
    document.fillColor('#101318').font('Helvetica-Bold').fontSize(36).text(ticket.name || 'Evento', panelX + posterWidth + 28, panelY + 56, { width: contentWidth - 56, height: 110 });
    document.fillColor('#5b6270').font('Helvetica').fontSize(14).text(`${ticket.event_date ? new Date(ticket.event_date).toLocaleDateString('es-MX') : 'Fecha por confirmar'}${ticket.event_time ? ` ${ticket.event_time}` : ''} | ${ticket.location || 'Ubicacion por confirmar'}`, panelX + posterWidth + 28, panelY + 136, { width: contentWidth - 56 });

    const metaStartY = panelY + 188;
    const metaBoxWidth = Math.max(180, Math.floor((contentWidth - 80) / 2));
    const metaBoxHeight = 52;
    const metaGapX = 16;
    const metaGapY = 12;

    const metaBoxes = [
      { label: 'Tipo', value: ticket.type_name },
      { label: 'Asiento', value: ticket.seat_number },
      { label: 'Precio', value: `$${Number(ticket.price).toFixed(2)}` },
      { label: 'Estado', value: ticket.status ? 'Confirmado' : 'Usado' },
    ];

    metaBoxes.forEach((box, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = panelX + posterWidth + 28 + column * (metaBoxWidth + metaGapX);
      const y = metaStartY + row * (metaBoxHeight + metaGapY);
      document.roundedRect(x, y, metaBoxWidth, metaBoxHeight, 10).fillAndStroke('#fbfaff', '#ded7ea');
      document.fillColor('#7d8594').font('Helvetica').fontSize(9).text(box.label, x + 12, y + 10, { width: metaBoxWidth - 24 });
      document.fillColor('#101318').font('Helvetica-Bold').fontSize(13).text(box.value, x + 12, y + 24, { width: metaBoxWidth - 24 });
    });

    const qrX = panelX + panelWidth - qrWidth + 18;
    const qrY = panelY + 40;
    document.roundedRect(qrX, qrY, qrWidth - 36, 260, 16).fillAndStroke('#faf9ff', '#ebe5f7');
    document.image(qrDataUrl, qrX + 22, qrY + 22, { width: qrWidth - 80, align: 'center' });
    document.fillColor('#596173').font('Helvetica').fontSize(12).text('Escanea para validar', qrX + 18, qrY + 208, { width: qrWidth - 72, align: 'center' });

    document.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
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