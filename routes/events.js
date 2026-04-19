const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');

const router = express.Router();

let imageSupportChecked = false;
let imageSupported = false;
let activeSupportChecked = false;
let activeSupported = false;

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

async function ensureActiveSupport() {
  if (activeSupportChecked) {
    return activeSupported;
  }

  try {
    const check = await pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'events' AND column_name = 'active'
       LIMIT 1`
    );

    if (check.rows.length > 0) {
      activeSupported = true;
      activeSupportChecked = true;
      return true;
    }

    await pool.query('ALTER TABLE events ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE');
    activeSupported = true;
  } catch (err) {
    if (err.code === '42701') {
      activeSupported = true;
    } else {
      activeSupported = false;
    }
  }

  activeSupportChecked = true;
  return activeSupported;
}

function canManageEvent(user, organizerId) {
  if (!user) {
    return false;
  }

  return user.role === 'organizer' || String(organizerId) === String(user.id);
}

function normalizeTicketCategory(rawTypeName) {
  const value = String(rawTypeName || '').trim().toLowerCase();
  if (!value) {
    return null;
  }

  if (['general', 'normal', 'general/normal', 'general o normal', 'generla', 'generla o normal'].includes(value)) {
    return 'General/Normal';
  }

  if (value === 'numerado') {
    return 'Numerado';
  }

  if (value === 'vip') {
    return 'VIP';
  }

  if (value === 'platino') {
    return 'Platino';
  }

  return null;
}

function getRequestUser(req) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return null;
  }

  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function buildEventDateTime(eventDate, eventTime) {
  if (!eventDate) {
    return null;
  }

  const datePart = String(eventDate).slice(0, 10);
  const timePart = eventTime ? String(eventTime).slice(0, 8) : '23:59:59';
  const candidate = new Date(`${datePart}T${timePart}`);

  if (!Number.isNaN(candidate.getTime())) {
    return candidate;
  }

  const fallback = new Date(eventDate);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function isPastEvent(event) {
  const eventDateTime = buildEventDateTime(event?.event_date, event?.event_time);
  if (!eventDateTime) {
    return false;
  }

  return eventDateTime.getTime() < Date.now();
}

function isEventActive(event) {
  return event?.active !== false;
}

function canViewRestrictedEvent(user, event) {
  if (!user || !event) {
    return false;
  }

  return user.role === 'admin' || user.role === 'organizer' || String(user.id) === String(event.organizer_id);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function buildEventAdminReport(eventId) {
  const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
  if (eventResult.rows.length === 0) {
    return null;
  }

  const event = eventResult.rows[0];
  const ticketTypesResult = await pool.query('SELECT * FROM ticket_types WHERE event_id = $1', [eventId]);
  const totalsResult = await pool.query(
    `SELECT
      COALESCE(SUM(tt.sold), 0) AS total_tickets_sold,
      COALESCE(SUM(tt.capacity - tt.sold), 0) AS tickets_unsold,
      COALESCE(SUM(tt.sold * tt.price), 0) AS total_income,
      COALESCE(SUM(GREATEST(tt.capacity - tt.sold, 0) * tt.price), 0) AS unsold_potential,
      COALESCE(SUM(tt.capacity), 0) AS total_capacity
     FROM ticket_types tt
     WHERE tt.event_id = $1`,
    [eventId]
  );

  const totals = totalsResult.rows[0] || {};
  return {
    event,
    ticket_types: ticketTypesResult.rows,
    total_tickets_sold: Number(totals.total_tickets_sold || 0),
    tickets_unsold: Number(totals.tickets_unsold || 0),
    total_income: Number(totals.total_income || 0),
    unsold_potential: Number(totals.unsold_potential || 0),
    total_capacity: Number(totals.total_capacity || 0),
  };
}

router.get('/admin/overview', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const eventRows = await pool.query('SELECT * FROM events ORDER BY event_date DESC, event_time DESC');
    const reports = [];
    for (const event of eventRows.rows) {
      const report = await buildEventAdminReport(event.id);
      if (report) {
        reports.push({
          id: event.id,
          name: event.name,
          location: event.location,
          event_date: event.event_date,
          event_time: event.event_time,
          active: event.active,
          artist_fee: Number(event.artist_fee || 0),
          tickets_sold: report.total_tickets_sold,
          tickets_unsold: report.tickets_unsold,
          total_income: report.total_income,
          unsold_potential: report.unsold_potential,
        });
      }
    }

    const summary = reports.reduce((acc, event) => {
      acc.ticketsSold += Number(event.tickets_sold || 0);
      acc.totalIncome += Number(event.total_income || 0);
      acc.artistPaid += Number(event.artist_fee || 0);
      return acc;
    }, {
      ticketsSold: 0,
      totalIncome: 0,
      artistPaid: 0,
    });

    res.json({ summary: { ...summary, balance: summary.totalIncome - summary.artistPaid }, reports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/admin-report', auth, async (req, res) => {
  const { id } = req.params;

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const report = await buildEventAdminReport(id);
    if (!report) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/admin-report/pdf', auth, async (req, res) => {
  const { id } = req.params;

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const report = await buildEventAdminReport(id);
    if (!report) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const event = report.event;
    const eventDate = event.event_date ? new Date(event.event_date).toLocaleDateString('es-MX') : 'Fecha por confirmar';
    const eventTime = event.event_time ? ` ${event.event_time}` : '';
    const statusLabel = event.active === false ? 'Inactivo' : 'Activo';
    const htmlRows = report.ticket_types.map((type) => {
      const sold = Number(type.sold || 0);
      const unsold = Math.max(Number(type.capacity || 0) - sold, 0);
      const income = sold * Number(type.price || 0);
      return `
        <tr>
          <td>${escapeHtml(type.type_name)}</td>
          <td>${Number(type.capacity || 0)}</td>
          <td>${sold}</td>
          <td>${unsold}</td>
          <td>$${income.toFixed(2)}</td>
        </tr>
      `;
    }).join('');

    const totalIncome = Number(report.total_income || 0);
    const artistFee = Number(event.artist_fee || 0);
    const balance = totalIncome - artistFee;

    const html = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; color: #111; padding: 28px; }
          h1 { margin: 0 0 6px; font-size: 24px; }
          .muted { color: #666; font-size: 12px; margin-bottom: 14px; }
          .summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 16px 0 18px; }
          .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
          .card span { display: block; font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: .04em; }
          .card strong { display: block; margin-top: 4px; font-size: 18px; }
          table { width: 100%; border-collapse: collapse; margin-top: 14px; }
          th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; font-size: 12px; }
          th { background: #f5f5f5; }
          .footer { margin-top: 18px; font-size: 12px; color: #555; }
        </style>
      </head>
      <body>
        <h1>Estado de cuenta del evento</h1>
        <div class="muted">${escapeHtml(event.name || 'Evento')} | ${escapeHtml(`${eventDate}${eventTime} | ${event.location || 'Ubicacion por confirmar'}`)} | ${escapeHtml(statusLabel)}</div>
        <div class="summary">
          <div class="card"><span>Boletos vendidos</span><strong>${Number(report.total_tickets_sold || 0)}</strong></div>
          <div class="card"><span>Boletos no vendidos</span><strong>${Number(report.tickets_unsold || 0)}</strong></div>
          <div class="card"><span>Total de ventas</span><strong>$${totalIncome.toFixed(2)}</strong></div>
          <div class="card"><span>Tarifa del artista</span><strong>$${artistFee.toFixed(2)}</strong></div>
          <div class="card"><span>Ganancia neta</span><strong>$${balance.toFixed(2)}</strong></div>
          <div class="card"><span>Potencial no vendido</span><strong>$${Number(report.unsold_potential || 0).toFixed(2)}</strong></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Capacidad</th>
              <th>Vendidos</th>
              <th>No vendidos</th>
              <th>Ingreso</th>
            </tr>
          </thead>
          <tbody>
            ${htmlRows || '<tr><td colspan="5">Sin tipos de boleto</td></tr>'}
          </tbody>
        </table>
        <div class="footer">Reporte generado por Ticketmaster Clone.</div>
      </body>
      </html>
    `;

    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', right: '14mm', bottom: '18mm', left: '14mm' } });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="reporte-evento-${escapeHtml(event.name || 'evento').replace(/[^a-zA-Z0-9_-]+/g, '-')}.pdf"`);
      res.send(pdfBuffer);
    } finally {
      await browser.close();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getTicketCapacitySum(eventId, excludeTicketTypeId = null) {
  if (excludeTicketTypeId) {
    const result = await pool.query(
      'SELECT COALESCE(SUM(capacity), 0) AS total FROM ticket_types WHERE event_id = $1 AND id <> $2',
      [eventId, excludeTicketTypeId]
    );
    return Number(result.rows[0].total || 0);
  }

  const result = await pool.query(
    'SELECT COALESCE(SUM(capacity), 0) AS total FROM ticket_types WHERE event_id = $1',
    [eventId]
  );
  return Number(result.rows[0].total || 0);
}

router.get('/', async (req, res) => {
  try {
    const requestUser = getRequestUser(req);
    const supportsActive = await ensureActiveSupport();
    const supportsImage = await ensureImageSupport();
    const query = supportsImage
      ? 'SELECT * FROM events ORDER BY event_date, event_time'
      : 'SELECT *, NULL::text AS image_url FROM events ORDER BY event_date, event_time';
    const result = await pool.query(query);
    const rows = requestUser && (requestUser.role === 'admin' || requestUser.role === 'organizer')
      ? result.rows
      : result.rows.filter((event) => (!supportsActive || isEventActive(event)) && !isPastEvent(event));

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const requestUser = getRequestUser(req);
    const supportsActive = await ensureActiveSupport();
    const supportsImage = await ensureImageSupport();
    const selectQuery = supportsImage
      ? 'SELECT * FROM events WHERE id = $1'
      : 'SELECT *, NULL::text AS image_url FROM events WHERE id = $1';
    const result = await pool.query(selectQuery, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Evento no encontrado' });
    const event = result.rows[0];
    const canViewRestricted = canViewRestrictedEvent(requestUser, event);
    const isRestrictedByDate = isPastEvent(event);
    const isRestrictedByState = supportsActive && !isEventActive(event);
    if ((isRestrictedByDate || isRestrictedByState) && !canViewRestricted) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const { name, location, event_date, event_time, description, capacity, artist_name, artist_fee, image_url = null } = req.body;

  try {
    const supportsActive = await ensureActiveSupport();
    const supportsImage = await ensureImageSupport();

    let result;
    if (supportsImage && supportsActive) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id, image_url, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE) RETURNING *`,
        [name, location, event_date, event_time, description, capacity, artist_name, artist_fee, req.user.id, image_url]
      );
    } else if (supportsImage) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [name, location, event_date, event_time, description, capacity, artist_name, artist_fee, req.user.id, image_url]
      );
    } else if (supportsActive) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) RETURNING *, NULL::text AS image_url`,
        [name, location, event_date, event_time, description, capacity, artist_name, artist_fee, req.user.id]
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

router.patch('/:id/active', auth, async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;

  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active debe ser booleano' });
  }

  try {
    const supportsActive = await ensureActiveSupport();
    if (!supportsActive) {
      return res.status(500).json({ error: 'No fue posible habilitar estados de evento' });
    }

    const eventResult = await pool.query('SELECT id, organizer_id FROM events WHERE id = $1', [id]);
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const event = eventResult.rows[0];
    if (!canManageEvent(req.user, event.organizer_id)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const result = await pool.query('UPDATE events SET active = $1 WHERE id = $2 RETURNING *', [active, id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;

    const eventResult = await client.query('SELECT id, name, organizer_id FROM events WHERE id = $1', [id]);
    if (eventResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const event = eventResult.rows[0];
    if (!canManageEvent(req.user, event.organizer_id)) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ error: 'No autorizado' });
    }

    await client.query(
      `DELETE FROM tickets
       WHERE ticket_type_id IN (
         SELECT id FROM ticket_types WHERE event_id = $1
       )`,
      [id]
    );

    await client.query('DELETE FROM ticket_types WHERE event_id = $1', [id]);
    await client.query('DELETE FROM events WHERE id = $1', [id]);

    await client.query('COMMIT');
    transactionStarted = false;

    res.json({ message: 'Evento eliminado correctamente', eventName: event.name });
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        return res.status(500).json({ error: rollbackErr.message });
      }
    }

    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/:id/ticket-types', async (req, res) => {
  const { id } = req.params;
  try {
    const requestUser = getRequestUser(req);
    const supportsActive = await ensureActiveSupport();
    const eventQuery = supportsActive
      ? 'SELECT id, organizer_id, event_date, event_time, active FROM events WHERE id = $1'
      : 'SELECT id, organizer_id, event_date, event_time, TRUE::boolean AS active FROM events WHERE id = $1';
    const eventResult = await pool.query(eventQuery, [id]);
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const event = eventResult.rows[0];
    const canViewRestricted = canViewRestrictedEvent(requestUser, event);
    const isRestrictedByDate = isPastEvent(event);
    const isRestrictedByState = supportsActive && !isEventActive(event);
    if ((isRestrictedByDate || isRestrictedByState) && !canViewRestricted) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

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
    const eventResult = await pool.query('SELECT organizer_id, capacity FROM events WHERE id = $1', [eventId]);
    if (eventResult.rows.length === 0) return res.status(404).json({ error: 'Evento no encontrado' });

    const event = eventResult.rows[0];
    if (!canManageEvent(req.user, event.organizer_id)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const normalizedType = normalizeTicketCategory(type_name);
    if (!normalizedType) {
      return res.status(400).json({ error: 'Categoria invalida. Usa: General/Normal, Numerado, VIP o Platino' });
    }

    const numericCapacity = Number(capacity);
    if (!Number.isInteger(numericCapacity) || numericCapacity < 1) {
      return res.status(400).json({ error: 'La capacidad del boleto debe ser un entero mayor a 0' });
    }

    const currentTotalCapacity = await getTicketCapacitySum(eventId);
    if (currentTotalCapacity + numericCapacity > Number(event.capacity)) {
      return res.status(400).json({
        error: `La capacidad total de boletos no puede exceder la capacidad del evento (${event.capacity})`
      });
    }

    const result = await pool.query(
      `INSERT INTO ticket_types (event_id, type_name, price, capacity)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [eventId, normalizedType, price, numericCapacity]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:eventId/ticket-types/:ticketTypeId', auth, async (req, res) => {
  const { eventId, ticketTypeId } = req.params;
  const { type_name, price, capacity } = req.body;

  try {
    const eventResult = await pool.query('SELECT organizer_id, capacity FROM events WHERE id = $1', [eventId]);
    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const event = eventResult.rows[0];
    if (!canManageEvent(req.user, event.organizer_id)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const ticketTypeResult = await pool.query(
      'SELECT * FROM ticket_types WHERE id = $1 AND event_id = $2',
      [ticketTypeId, eventId]
    );
    if (ticketTypeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tipo de boleto no encontrado' });
    }

    const currentType = ticketTypeResult.rows[0];
    const normalizedType = normalizeTicketCategory(type_name ?? currentType.type_name);
    if (!normalizedType) {
      return res.status(400).json({ error: 'Categoria invalida. Usa: General/Normal, Numerado, VIP o Platino' });
    }

    const numericCapacity = Number(capacity ?? currentType.capacity);
    if (!Number.isInteger(numericCapacity) || numericCapacity < 1) {
      return res.status(400).json({ error: 'La capacidad del boleto debe ser un entero mayor a 0' });
    }

    if (numericCapacity < Number(currentType.sold || 0)) {
      return res.status(400).json({ error: `La capacidad no puede ser menor a los vendidos (${currentType.sold})` });
    }

    const totalWithoutCurrent = await getTicketCapacitySum(eventId, ticketTypeId);
    if (totalWithoutCurrent + numericCapacity > Number(event.capacity)) {
      return res.status(400).json({
        error: `La capacidad total de boletos no puede exceder la capacidad del evento (${event.capacity})`
      });
    }

    const result = await pool.query(
      `UPDATE ticket_types
       SET type_name = $1, price = $2, capacity = $3
       WHERE id = $4 AND event_id = $5
       RETURNING *`,
      [normalizedType, price ?? currentType.price, numericCapacity, ticketTypeId, eventId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:eventId/ticket-types/:ticketTypeId', auth, async (req, res) => {
  const { eventId, ticketTypeId } = req.params;
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;

    let ticketTypeResult = await client.query(
      `SELECT tt.id, tt.event_id, e.organizer_id
       FROM ticket_types tt
       JOIN events e ON e.id = tt.event_id
       WHERE tt.id = $1 AND tt.event_id = $2`,
      [ticketTypeId, eventId]
    );

    // Fallback when URL eventId is stale but ticket type still exists.
    if (ticketTypeResult.rows.length === 0) {
      ticketTypeResult = await client.query(
        `SELECT tt.id, tt.event_id, e.organizer_id
         FROM ticket_types tt
         JOIN events e ON e.id = tt.event_id
         WHERE tt.id = $1`,
        [ticketTypeId]
      );
    }

    if (ticketTypeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Tipo de boleto no encontrado' });
    }

    const ticketType = ticketTypeResult.rows[0];
    if (!canManageEvent(req.user, ticketType.organizer_id)) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ error: 'No autorizado' });
    }

    const deletedTicketsResult = await client.query('DELETE FROM tickets WHERE ticket_type_id = $1', [ticketTypeId]);
    const deletedTypeResult = await client.query('DELETE FROM ticket_types WHERE id = $1 AND event_id = $2', [ticketTypeId, ticketType.event_id]);

    if (deletedTypeResult.rowCount === 0) {
      throw new Error('No se pudo eliminar el tipo de boleto');
    }

    await client.query('COMMIT');
    transactionStarted = false;

    res.json({
      message: 'Tipo de boleto eliminado correctamente',
      deletedTickets: deletedTicketsResult.rowCount || 0
    });
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        return res.status(500).json({ error: rollbackErr.message });
      }
    }

    if (err.code === '23503') {
      return res.status(400).json({ error: 'No se puede eliminar por dependencias de base de datos' });
    }

    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;