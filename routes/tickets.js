const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const { randomBytes } = require('crypto');
const QRCode = require('qrcode');
const puppeteer = require('puppeteer');

const router = express.Router();

let activeSupportChecked = false;
let activeSupported = false;
let seatsSupportChecked = false;
let seatsSupported = false;

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
      await pool.query('ALTER TABLE events ALTER COLUMN active SET DEFAULT FALSE');
      activeSupported = true;
      activeSupportChecked = true;
      return true;
    }

    await pool.query('ALTER TABLE events ADD COLUMN active BOOLEAN NOT NULL DEFAULT FALSE');
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

async function ensureSeatsSupport() {
  if (seatsSupportChecked) {
    return seatsSupported;
  }

  try {
    const check = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_name = 'seats'
       LIMIT 1`
    );

    seatsSupported = check.rows.length > 0;
  } catch (err) {
    seatsSupported = false;
  }

  seatsSupportChecked = true;
  return seatsSupported;
}

function rowLabelFromIndex(index) {
  let n = Number(index) + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function normalizeSeatZoneType(typeName) {
  const normalized = String(typeName || '').trim().toLowerCase();
  if (normalized.includes('platino') || normalized.includes('platinum')) {
    return { code: 'PL', label: 'Platino', rank: 1 };
  }
  if (normalized.includes('vip')) {
    return { code: 'VP', label: 'VIP', rank: 2 };
  }
  return { code: 'NM', label: 'Numerado', rank: 3 };
}

function buildTierSeatLayout(totalSeats, typeName, occupiedLabels = new Set()) {
  const safeTotal = Math.max(Number(totalSeats || 0), 0);
  const zone = normalizeSeatZoneType(typeName);
  const seats = [];

  if (!safeTotal) {
    return seats;
  }

  // Crece primero en ancho (hacia afuera) y despues en filas.
  const preferredRows = 12;
  const minCols = 20;
  const maxCols = 48;
  const colsPerRow = Math.min(maxCols, Math.max(minCols, Math.ceil(safeTotal / preferredRows)));
  const totalRows = Math.ceil(safeTotal / colsPerRow);
  let created = 0;

  for (let row = 1; row <= totalRows; row += 1) {
    for (let col = 1; col <= colsPerRow; col += 1) {
      if (created >= safeTotal) {
        break;
      }

      const seatLabel = `${zone.code}-${String(row).padStart(2, '0')}-${String(col).padStart(2, '0')}`;
      const status = occupiedLabels.has(seatLabel) ? 'sold' : 'available';

      seats.push({
        seat_label: seatLabel,
        row_label: `${zone.code}-${String(row).padStart(2, '0')}`,
        column_label: String(col),
        section_label: zone.code,
        status,
      });

      created += 1;
    }
  }

  return seats;
}

async function ensureDefaultSeatsForTicketType(client, ticketTypeId, capacity, typeName) {
  const targetSeats = Math.max(Number(capacity || 0), 0);
  if (!targetSeats) {
    return 0;
  }

  const countResult = await client.query(
    'SELECT COUNT(*)::int AS total FROM seats WHERE ticket_type_id = $1',
    [ticketTypeId]
  );
  const existing = Number(countResult.rows[0]?.total || 0);
  if (existing >= targetSeats) {
    return existing;
  }

  const generated = buildTierSeatLayout(targetSeats, typeName);
  const seatLabels = generated.map((seat) => seat.seat_label);
  const rowLabels = generated.map((seat) => seat.row_label);
  const colLabels = generated.map((seat) => seat.column_label);

  await client.query(
    `INSERT INTO seats (ticket_type_id, seat_label, row_label, column_label, status)
     SELECT $1, data.seat_label, data.row_label, data.column_label, 'available'
     FROM unnest($2::text[], $3::text[], $4::text[]) AS data(seat_label, row_label, column_label)
     ON CONFLICT (ticket_type_id, seat_label) DO NOTHING`,
    [ticketTypeId, seatLabels, rowLabels, colLabels]
  );

  return targetSeats;
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

function isNoSeatType(typeName) {
  const normalized = String(typeName || '').trim().toLowerCase();
  const compact = normalized.replace(/[^a-z]/g, '');
  return compact === 'generalnormal' || compact === 'general' || compact === 'normal';
}

function toDisplaySeatNumber(typeName, seatNumber) {
  const raw = String(seatNumber || '').trim();
  if (!raw) {
    return 'N/A';
  }
  if (isNoSeatType(typeName) || raw.toUpperCase().startsWith('N/A-')) {
    return 'N/A';
  }
  return raw;
}

async function buildTicketPdfBuffer(ticket) {
  const qrSvg = await QRCode.toString(ticket.qr_code, {
  type: 'svg',
  margin: 1,
  width: 180,
  errorCorrectionLevel: 'M'
  });

  const eventDate = ticket.event_date
  ? new Date(ticket.event_date).toLocaleDateString('es-MX')
  : 'Fecha por confirmar';
  const eventTime = ticket.event_time ? ` ${ticket.event_time}` : '';
  const dateTimeLocation = `${eventDate}${eventTime} | ${ticket.location || 'Ubicacion por confirmar'}`;
  const eventImage = ticket.image_url || 'https://placehold.co/520x760?text=Evento';
  const seatDisplay = toDisplaySeatNumber(ticket.type_name, ticket.seat_number);

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(ticket.name || 'Boleto')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Trebuchet MS', 'Segoe UI', sans-serif;
      background: #f5f5f5;
      display: grid;
      place-items: center;
      min-height: 100vh;
      padding: 20px;
    }
    .ticket-container {
      width: 100%;
      max-width: 1200px;
    }
    .generated-ticket {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr) 250px;
      background: #fff;
      border: 3px solid #7a2df0;
      border-radius: 18px;
      overflow: hidden;
      box-shadow: 0 18px 40px rgba(22, 26, 35, 0.14);
    }
    .generated-ticket-poster {
      background: #101318;
      overflow: hidden;
    }
    .generated-ticket-image {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    .generated-ticket-content {
      padding: 28px 26px;
      display: grid;
      gap: 14px;
      align-content: start;
    }
    .generated-ticket-kicker {
      margin: 0;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-size: 12px;
      color: #7a2df0;
      font-weight: 700;
    }
    .generated-ticket-content h3 {
      margin: 0;
      font-size: 48px;
      line-height: 1.03;
      color: #101318;
    }
    .generated-ticket-subtitle {
      margin: 0;
      color: #5b6270;
      font-size: 15px;
    }
    .generated-ticket-meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .generated-ticket-meta div {
      border: 1px solid #ded7ea;
      border-radius: 12px;
      padding: 12px 14px;
      background: #fbfaff;
    }
    .generated-ticket-meta span {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #7d8594;
      margin-bottom: 4px;
    }
    .generated-ticket-meta strong {
      font-size: 16px;
      color: #101318;
    }
    .generated-ticket-qr {
      padding: 22px;
      background: #faf9ff;
      border-left: 1px solid #ebe5f7;
      display: grid;
      gap: 12px;
      align-content: end;
    }
    .generated-ticket-qr-box {
      background: #fff;
      border: 1px solid #e3def0;
      border-radius: 16px;
      padding: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .generated-ticket-qr-box svg {
      width: 100%;
      height: auto;
      display: block;
    }
    .generated-ticket-qr p {
      margin: 0;
      text-align: center;
      color: #596173;
      font-size: 14px;
    }
    @media print {
      body { background: #fff; padding: 0; }
      .ticket-container { max-width: 100%; }
      .generated-ticket { box-shadow: none; }
    }
  </style>
</head>
<body>
  <div class="ticket-container">
    <article class="generated-ticket">
      <div class="generated-ticket-poster">
        <img src="${escapeAttribute(eventImage)}" alt="${escapeAttribute(ticket.name || 'Evento')}" class="generated-ticket-image">
      </div>
      <div class="generated-ticket-content">
        <p class="generated-ticket-kicker">Ticketmaster</p>
        <h3>${escapeHtml(ticket.name || 'Evento')}</h3>
        <p class="generated-ticket-subtitle">${escapeHtml(dateTimeLocation)}</p>
        <div class="generated-ticket-meta">
          <div><span>Tipo</span><strong>${escapeHtml(ticket.type_name)}</strong></div>
          <div><span>Asiento</span><strong>${escapeHtml(seatDisplay)}</strong></div>
          <div><span>Precio</span><strong>$${Number(ticket.price).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
          <div><span>Estado</span><strong>${ticket.status ? 'Confirmado' : 'Usado'}</strong></div>
        </div>
      </div>
      <div class="generated-ticket-qr">
        <div class="generated-ticket-qr-box">${qrSvg}</div>
        <p>Escanea para validar</p>
      </div>
    </article>
  </div>
</body>
</html>`;

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({
  format: 'A4',
  landscape: true,
  margin: { top: 20, right: 20, bottom: 20, left: 20 },
  printBackground: true
  });

  await browser.close();
  return pdfBuffer;
}

function buildTicketFileName(ticket, fallbackIndex = 1) {
  const eventSlug = String(ticket.name || 'evento').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const seat = ticket.seat_number || String(fallbackIndex);
  return `boleto-${eventSlug}-${seat}.pdf`;
}

async function buildBulkTicketsPdfBuffer(tickets) {
  const pages = await Promise.all(tickets.map(async (ticket) => {
    const qrSvg = await QRCode.toString(ticket.qr_code, {
      type: 'svg',
      margin: 1,
      width: 180,
      errorCorrectionLevel: 'M'
    });

    const eventDate = ticket.event_date
      ? new Date(ticket.event_date).toLocaleDateString('es-MX')
      : 'Fecha por confirmar';
    const eventTime = ticket.event_time ? ` ${ticket.event_time}` : '';
    const dateTimeLocation = `${eventDate}${eventTime} | ${ticket.location || 'Ubicacion por confirmar'}`;
    const eventImage = ticket.image_url || 'https://placehold.co/520x760?text=Evento';
    const seatDisplay = toDisplaySeatNumber(ticket.type_name, ticket.seat_number);

    return `
      <section class="ticket-page">
        <div class="ticket-container">
          <article class="generated-ticket">
            <div class="generated-ticket-poster">
              <img src="${escapeAttribute(eventImage)}" alt="${escapeAttribute(ticket.name || 'Evento')}" class="generated-ticket-image">
            </div>
            <div class="generated-ticket-content">
              <p class="generated-ticket-kicker">Ticketmaster</p>
              <h3>${escapeHtml(ticket.name || 'Evento')}</h3>
              <p class="generated-ticket-subtitle">${escapeHtml(dateTimeLocation)}</p>
              <div class="generated-ticket-meta">
                <div><span>Tipo</span><strong>${escapeHtml(ticket.type_name)}</strong></div>
                <div><span>Asiento</span><strong>${escapeHtml(seatDisplay)}</strong></div>
                <div><span>Precio</span><strong>$${Number(ticket.price).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
                <div><span>Estado</span><strong>${ticket.status ? 'Confirmado' : 'Usado'}</strong></div>
              </div>
            </div>
            <div class="generated-ticket-qr">
              <div class="generated-ticket-qr-box">${qrSvg}</div>
              <p>Escanea para validar</p>
            </div>
          </article>
        </div>
      </section>`;
  }));

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Boletos</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Trebuchet MS', 'Segoe UI', sans-serif;
      background: #f5f5f5;
    }
    .ticket-page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      page-break-after: always;
      break-after: page;
    }
    .ticket-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .ticket-container {
      width: 100%;
      max-width: 1200px;
    }
    .generated-ticket {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr) 250px;
      background: #fff;
      border: 3px solid #7a2df0;
      border-radius: 18px;
      overflow: hidden;
      box-shadow: 0 18px 40px rgba(22, 26, 35, 0.14);
    }
    .generated-ticket-poster {
      background: #101318;
      overflow: hidden;
    }
    .generated-ticket-image {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }
    .generated-ticket-content {
      padding: 28px 26px;
      display: grid;
      gap: 14px;
      align-content: start;
    }
    .generated-ticket-kicker {
      margin: 0;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-size: 12px;
      color: #7a2df0;
      font-weight: 700;
    }
    .generated-ticket-content h3 {
      margin: 0;
      font-size: 48px;
      line-height: 1.03;
      color: #101318;
    }
    .generated-ticket-subtitle {
      margin: 0;
      color: #5b6270;
      font-size: 15px;
    }
    .generated-ticket-meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .generated-ticket-meta div {
      border: 1px solid #ded7ea;
      border-radius: 12px;
      padding: 12px 14px;
      background: #fbfaff;
    }
    .generated-ticket-meta span {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #7d8594;
      margin-bottom: 4px;
    }
    .generated-ticket-meta strong {
      font-size: 16px;
      color: #101318;
    }
    .generated-ticket-qr {
      padding: 22px;
      background: #faf9ff;
      border-left: 1px solid #ebe5f7;
      display: grid;
      gap: 12px;
      align-content: end;
    }
    .generated-ticket-qr-box {
      background: #fff;
      border: 1px solid #e3def0;
      border-radius: 16px;
      padding: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .generated-ticket-qr-box svg {
      width: 100%;
      height: auto;
      display: block;
    }
    .generated-ticket-qr p {
      margin: 0;
      text-align: center;
      color: #596173;
      font-size: 14px;
    }
    @media print {
      body { background: #fff; }
      .ticket-page { padding: 0; }
      .generated-ticket { box-shadow: none; }
    }
  </style>
</head>
<body>
  ${pages.join('\n')}
</body>
</html>`;

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({
    format: 'A4',
    landscape: true,
    margin: { top: 20, right: 20, bottom: 20, left: 20 },
    printBackground: true
  });

  await browser.close();
  return pdfBuffer;
}

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
    const supportsActive = await ensureActiveSupport();
    await client.query('BEGIN');

    const typeResult = await client.query(
      'SELECT * FROM ticket_types WHERE id = $1 FOR UPDATE',
      [ticket_type_id]
    );
    const ticketType = typeResult.rows[0];
    if (!ticketType) throw new Error('Tipo de boleto no existe');

    const eventQuery = supportsActive
      ? `SELECT id, name, event_date, event_time, location, image_url, description, active
         FROM events
         WHERE id = $1`
      : `SELECT id, name, event_date, event_time, location, image_url, description, TRUE::boolean AS active
         FROM events
         WHERE id = $1`;
    const eventResult = await client.query(eventQuery, [ticketType.event_id]);
    const event = eventResult.rows[0];
    if (event && isPastEvent(event)) {
      throw new Error('Este evento ya paso y no admite compras');
    }
    if (event && supportsActive && event.active === false) {
      throw new Error('Este evento esta inactivo y no admite compras');
    }

    const available = Number(ticketType.capacity) - Number(ticketType.sold);
    if (available < qty) {
      throw new Error(`Solo hay ${available} boletos disponibles para este tipo`);
    }

    const purchasedTickets = [];
    const startSold = Number(ticketType.sold);
    const noSeatType = isNoSeatType(ticketType.type_name);

    for (let i = 1; i <= qty; i += 1) {
      const seatNumber = noSeatType
        ? `N/A-${startSold + i}`
        : (startSold + i).toString();
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
        seatNumber: toDisplaySeatNumber(ticketType.type_name, seatNumber),
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

router.get('/seats/:ticketTypeId', auth, async (req, res) => {
  const { ticketTypeId } = req.params;

  const client = await pool.connect();
  try {
    const typeResult = await client.query(
      `SELECT tt.id, tt.type_name, tt.capacity, tt.sold, tt.event_id,
              e.name AS event_name, e.event_date, e.event_time, e.location
       FROM ticket_types tt
       JOIN events e ON e.id = tt.event_id
       WHERE tt.id = $1`,
      [ticketTypeId]
    );

    const ticketType = typeResult.rows[0];
    if (!ticketType) {
      return res.status(404).json({ error: 'Tipo de boleto no encontrado' });
    }

    const supportsSeats = await ensureSeatsSupport();
    let seats = [];

    if (supportsSeats) {
      await ensureDefaultSeatsForTicketType(client, ticketTypeId, ticketType.capacity, ticketType.type_name);

      const seatsResult = await client.query(
        `SELECT seat_label, row_label, column_label, status
         FROM seats
         WHERE ticket_type_id = $1
         ORDER BY row_label, column_label`,
        [ticketTypeId]
      );

      seats = seatsResult.rows.map((seat) => ({
        ...seat,
        section_label: String(seat.row_label || '').split('-')[0] || String(seat.seat_label || '').split('-')[0] || 'NM',
      }));
    }

    if (!seats.length) {
      const soldResult = await client.query(
        `SELECT seat_number
         FROM tickets
         WHERE ticket_type_id = $1`,
        [ticketTypeId]
      );
      const occupied = new Set(soldResult.rows.map((row) => String(row.seat_number || '').trim()).filter(Boolean));
      seats = buildTierSeatLayout(Math.max(Number(ticketType.capacity || 0), 0), ticketType.type_name, occupied);
    }

    const seatZone = normalizeSeatZoneType(ticketType.type_name);

    res.json({
      ticketType: {
        id: ticketType.id,
        type_name: ticketType.type_name,
        capacity: Number(ticketType.capacity || 0),
        sold: Number(ticketType.sold || 0),
        seat_zone: seatZone,
      },
      event: {
        id: ticketType.event_id,
        name: ticketType.event_name,
        event_date: ticketType.event_date,
        event_time: ticketType.event_time,
        location: ticketType.location,
      },
      seats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/purchase-with-seats', auth, async (req, res) => {
  const { ticket_type_id, seat_labels: seatLabelsRaw } = req.body;
  const userId = req.user.id;
  const seatLabels = Array.isArray(seatLabelsRaw)
    ? [...new Set(seatLabelsRaw.map((label) => String(label || '').trim().toUpperCase()).filter(Boolean))]
    : [];

  if (!ticket_type_id) {
    return res.status(400).json({ error: 'ticket_type_id es obligatorio' });
  }

  if (!seatLabels.length) {
    return res.status(400).json({ error: 'Debes seleccionar al menos un asiento' });
  }

  if (seatLabels.length > 20) {
    return res.status(400).json({ error: 'Maximo 20 asientos por compra' });
  }

  const client = await pool.connect();
  try {
    const supportsActive = await ensureActiveSupport();
    const supportsSeats = await ensureSeatsSupport();

    await client.query('BEGIN');

    const typeResult = await client.query(
      'SELECT * FROM ticket_types WHERE id = $1 FOR UPDATE',
      [ticket_type_id]
    );
    const ticketType = typeResult.rows[0];
    if (!ticketType) throw new Error('Tipo de boleto no existe');

    const eventQuery = supportsActive
      ? `SELECT id, name, event_date, event_time, location, image_url, description, active
         FROM events
         WHERE id = $1`
      : `SELECT id, name, event_date, event_time, location, image_url, description, TRUE::boolean AS active
         FROM events
         WHERE id = $1`;
    const eventResult = await client.query(eventQuery, [ticketType.event_id]);
    const event = eventResult.rows[0];

    if (event && isPastEvent(event)) {
      throw new Error('Este evento ya paso y no admite compras');
    }
    if (event && supportsActive && event.active === false) {
      throw new Error('Este evento esta inactivo y no admite compras');
    }

    const available = Number(ticketType.capacity) - Number(ticketType.sold || 0);
    if (available < seatLabels.length) {
      throw new Error(`Solo hay ${available} boletos disponibles para este tipo`);
    }

    let seatsToSell = [];
    if (supportsSeats) {
      await ensureDefaultSeatsForTicketType(client, ticket_type_id, ticketType.capacity, ticketType.type_name);

      const seatsResult = await client.query(
        `SELECT id, seat_label, status
         FROM seats
         WHERE ticket_type_id = $1
           AND UPPER(seat_label) = ANY($2::text[])
         FOR UPDATE`,
        [ticket_type_id, seatLabels]
      );

      if (seatsResult.rows.length !== seatLabels.length) {
        throw new Error('Algunos asientos no existen para este tipo de boleto');
      }

      const unavailable = seatsResult.rows.filter((seat) => String(seat.status) !== 'available');
      if (unavailable.length) {
        throw new Error('Algunos asientos ya no estan disponibles');
      }

      seatsToSell = seatLabels
        .map((label) => seatsResult.rows.find((seat) => String(seat.seat_label || '').toUpperCase() === label))
        .filter(Boolean);
    } else {
      const soldSeatsResult = await client.query(
        `SELECT seat_number
         FROM tickets
         WHERE ticket_type_id = $1
           AND seat_number = ANY($2::text[])
         FOR UPDATE`,
        [ticket_type_id, seatLabels]
      );

      if (soldSeatsResult.rows.length) {
        throw new Error('Algunos asientos ya no estan disponibles');
      }

      seatsToSell = seatLabels.map((label) => ({ seat_label: label }));
    }

    const purchasedTickets = [];
    for (const seat of seatsToSell) {
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
        [ticket_type_id, userId, qrCode, seat.seat_label]
      );

      if (supportsSeats && seat.id) {
        await client.query(
          `UPDATE seats
           SET status = 'sold',
               reserved_by = $2,
               reserved_until = NULL
           WHERE id = $1`,
          [seat.id, userId]
        );
      }

      purchasedTickets.push({
        id: insertResult.rows[0].id,
        qrCode,
        qrSvg,
        seatNumber: seat.seat_label,
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
      [ticket_type_id, seatsToSell.length]
    );

    await client.query('COMMIT');

    const unitPrice = Number(ticketType.price);
    const total = unitPrice * seatsToSell.length;

    res.json({
      message: 'Compra exitosa',
      quantity: seatsToSell.length,
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

    const pdfBuffer = await buildTicketPdfBuffer(ticket);
    const fileName = buildTicketFileName(ticket);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF Generation Error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk-pdf', auth, async (req, res) => {
  const { ticket_ids: ticketIds } = req.body;

  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    return res.status(400).json({ error: 'ticket_ids debe ser un arreglo con al menos un elemento' });
  }

  const normalizedIds = [...new Set(ticketIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!normalizedIds.length) {
    return res.status(400).json({ error: 'ticket_ids invalidos' });
  }

  try {
    const placeholders = normalizedIds.map((_, index) => `$${index + 1}`).join(', ');
    const result = await pool.query(
      `SELECT t.id, t.qr_code, t.seat_number, t.user_id, t.status, t.purchase_date,
              tt.id AS ticket_type_id, tt.type_name, tt.price,
              e.id AS event_id, e.name, e.event_date, e.event_time, e.location, e.image_url, e.description
       FROM tickets t
       JOIN ticket_types tt ON t.ticket_type_id = tt.id
       JOIN events e ON tt.event_id = e.id
       WHERE t.id IN (${placeholders})`,
      normalizedIds
    );

    const byId = new Map(result.rows.map((row) => [String(row.id), row]));
    const tickets = normalizedIds.map((id) => byId.get(String(id))).filter(Boolean);

    if (!tickets.length) {
      return res.status(404).json({ error: 'No se encontraron boletos para descargar' });
    }

    if (req.user.role !== 'admin') {
      const unauthorized = tickets.find((ticket) => String(ticket.user_id) !== String(req.user.id));
      if (unauthorized) {
        return res.status(403).json({ error: 'No autorizado para descargar uno o mas boletos' });
      }
    }

    const pdfBuffer = await buildBulkTicketsPdfBuffer(tickets);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="boletos-${stamp}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Bulk PDF Error:', err);
    res.status(500).json({ error: err.message });
  }
});

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text || '').replace(/[&<>"']/g, (m) => map[m]);
}

function escapeAttribute(text) {
  return String(text || '').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

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

// Obtener eventos donde el usuario compró boletos, agrupados
router.get('/purchased-events', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT e.id, e.name, e.event_date, e.event_time, e.location, e.image_url, e.artist_name
       FROM tickets t
       JOIN ticket_types tt ON t.ticket_type_id = tt.id
       JOIN events e ON tt.event_id = e.id
       WHERE t.user_id = $1
       ORDER BY e.event_date DESC`,
      [req.user.id]
    );
    
    const events = result.rows;
    
    // Para cada evento, obtener sus boletos
    const eventsWithTickets = await Promise.all(
      events.map(async (event) => {
        const ticketsResult = await pool.query(
          `SELECT t.id, t.qr_code, t.seat_number, t.status, t.purchase_date,
                  tt.type_name, tt.price
           FROM tickets t
           JOIN ticket_types tt ON t.ticket_type_id = tt.id
           WHERE tt.event_id = $1 AND t.user_id = $2
           ORDER BY t.purchase_date DESC`,
          [event.id, req.user.id]
        );
        return {
          ...event,
          tickets: ticketsResult.rows
        };
      })
    );
    
    res.json(eventsWithTickets);
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