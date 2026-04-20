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
let eventEndTimeSupportChecked = false;
let eventEndTimeSupported = false;
let ticketCreatedAtSupportChecked = false;
let ticketCreatedAtSupported = false;

async function ensureTicketCreatedAtSupport() {
  if (ticketCreatedAtSupportChecked) {
    return ticketCreatedAtSupported;
  }

  try {
    const check = await pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'tickets' AND column_name = 'created_at'
       LIMIT 1`
    );

    if (check.rows.length > 0) {
      // Column exists, make sure it has data for NULL entries
      try {
        await pool.query(
          `UPDATE tickets SET created_at = NOW() WHERE created_at IS NULL`
        );
      } catch (err) {
        // ignore if already constrained
      }
      ticketCreatedAtSupported = true;
      ticketCreatedAtSupportChecked = true;
      return true;
    }

    // Column doesn't exist, create it
    await pool.query('ALTER TABLE tickets ADD COLUMN created_at TIMESTAMP WITHOUT TIME ZONE');
    await pool.query('UPDATE tickets SET created_at = NOW()');
    try {
      await pool.query('ALTER TABLE tickets ALTER COLUMN created_at SET NOT NULL');
    } catch (err) {
      // ignore if already set
    }
    try {
      await pool.query('ALTER TABLE tickets ALTER COLUMN created_at SET DEFAULT NOW()');
    } catch (err) {
      // ignore if already set
    }
    ticketCreatedAtSupported = true;
  } catch (err) {
    if (err.code === '42701') {
      ticketCreatedAtSupported = true;
    } else {
      ticketCreatedAtSupported = false;
    }
  }

  ticketCreatedAtSupportChecked = true;
  return ticketCreatedAtSupported;
}

function getTrendSqlConfig(bucket) {
  switch (bucket) {
    case 'day':
      return {
        trunc: 'day',
        step: '1 day',
        points: 14,
      };
    case 'week':
      return {
        trunc: 'week',
        step: '1 week',
        points: 12,
      };
    case 'month':
      return {
        trunc: 'month',
        step: '1 month',
        points: 12,
      };
    case 'year':
      return {
        trunc: 'year',
        step: '1 year',
        points: 1,
      };
    default:
      return null;
  }
}

async function getEventSalesTrend(eventId, bucket, offset = 0) {
  const config = getTrendSqlConfig(bucket);
  if (!config) {
    return [];
  }

  const query = `
    WITH series AS (
      SELECT generate_series(
        date_trunc('${config.trunc}', NOW()) - INTERVAL '${config.step}' * (${config.points} - 1 + $2),
        date_trunc('${config.trunc}', NOW()) - INTERVAL '${config.step}' * $2,
        INTERVAL '${config.step}'
      ) AS period_start
    ),
    sales AS (
      SELECT
        date_trunc('${config.trunc}', COALESCE(t.created_at, NOW())) AS period_start,
        COUNT(*)::int AS tickets_sold,
        COALESCE(SUM(tt.price), 0)::numeric AS total_income
      FROM tickets t
      JOIN ticket_types tt ON tt.id = t.ticket_type_id
      WHERE tt.event_id = $1
      GROUP BY 1
    )
    SELECT
      s.period_start,
      COALESCE(sa.tickets_sold, 0)::int AS tickets_sold,
      COALESCE(sa.total_income, 0)::numeric AS total_income
    FROM series s
    LEFT JOIN sales sa ON sa.period_start = s.period_start
    ORDER BY s.period_start ASC
  `;

  try {
    const result = await pool.query(query, [eventId, Number(offset || 0)]);
    const rows = result.rows || [];
    
    // If we have real ticket records, use them
    if (rows.some(row => row.tickets_sold > 0)) {
      return rows.map((row) => ({
        period_start: row.period_start,
        tickets_sold: Number(row.tickets_sold || 0),
        total_income: Number(row.total_income || 0),
      }));
    }

    // Fallback: if no tickets in the table but ticket_types has sold > 0, use that
    // Get total sales from ticket_types
    const ttResult = await pool.query(
      `SELECT COALESCE(SUM(sold), 0)::int AS total_sold, COALESCE(SUM(sold * price), 0)::numeric AS total_income
       FROM ticket_types WHERE event_id = $1`,
      [eventId]
    );
    
    const totalSold = Number(ttResult.rows[0]?.total_sold || 0);
    const totalIncome = Number(ttResult.rows[0]?.total_income || 0);
    
    if (totalSold > 0 && rows.length > 0) {
      // Distribute sales to the last point in the series
      return rows.map((row, index) => {
        const isLast = index === rows.length - 1;
        return {
          period_start: row.period_start,
          tickets_sold: isLast ? totalSold : 0,
          total_income: isLast ? totalIncome : 0,
        };
      });
    }

    return rows.map((row) => ({
      period_start: row.period_start,
      tickets_sold: Number(row.tickets_sold || 0),
      total_income: Number(row.total_income || 0),
    }));
  } catch (err) {
    console.error('getEventSalesTrend error:', err.message, 'code:', err.code);
    if (err.code === '42703' || err.code === '42P01') {
      return [];
    }
    throw err;
  }
}

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

async function ensureEventEndTimeSupport() {
  if (eventEndTimeSupportChecked) {
    return eventEndTimeSupported;
  }

  try {
    const check = await pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_name = 'events' AND column_name = 'event_end_time'
       LIMIT 1`
    );

    if (check.rows.length > 0) {
      eventEndTimeSupported = true;
      eventEndTimeSupportChecked = true;
      return true;
    }

    await pool.query('ALTER TABLE events ADD COLUMN event_end_time TIME');
    eventEndTimeSupported = true;
  } catch (err) {
    if (err.code === '42701') {
      eventEndTimeSupported = true;
    } else {
      eventEndTimeSupported = false;
    }
  }

  eventEndTimeSupportChecked = true;
  return eventEndTimeSupported;
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

function isValidTimeRange(startTime, endTime) {
  if (!startTime || !endTime) {
    return true;
  }

  const start = String(startTime).slice(0, 5);
  const end = String(endTime).slice(0, 5);
  return end > start;
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

function formatTrendPointLabel(periodStart, bucket) {
  const date = new Date(periodStart);
  if (Number.isNaN(date.getTime())) {
    return String(periodStart || '');
  }

  if (bucket === 'day') {
    return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  }

  if (bucket === 'week') {
    const end = new Date(date);
    end.setUTCDate(date.getUTCDate() + 6);
    const startLabel = date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    const endLabel = end.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    return `${startLabel} - ${endLabel}`;
  }

  if (bucket === 'month') {
    return date.toLocaleDateString('es-MX', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  return String(date.getUTCFullYear());
}

function buildTrendChartSvg(rows, bucket, title) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const labels = safeRows.map((row) => String(row.period_label || formatTrendPointLabel(row.period_start, bucket)));
  const tickets = safeRows.map((row) => Number(row.tickets_sold || 0));
  const income = safeRows.map((row) => Number(row.total_income || 0));
  const width = 760;
  const height = 300;
  const pad = { top: 44, right: 36, bottom: 72, left: 48 };
  const chartW = Math.max(width - pad.left - pad.right, 1);
  const chartH = Math.max(height - pad.top - pad.bottom, 1);
  const points = Math.max(labels.length, 1);
  const maxIncome = Math.max(...income, 1) * 1.2;
  const maxTickets = Math.max(...tickets, 1) * 1.2;
  const getX = (index) => pad.left + (points === 1 ? chartW / 2 : (chartW * index) / (points - 1));
  const getIncomeY = (value) => pad.top + chartH - (Math.max(value, 0) / maxIncome) * chartH;
  const getTicketsY = (value) => pad.top + chartH - (Math.max(value, 0) / maxTickets) * chartH;
  const labelStep = Math.ceil(Math.max(labels.length, 1) / 4);

  const gridLines = Array.from({ length: 5 }, (_, index) => {
    const y = pad.top + (chartH / 4) * index;
    return `<line x1="${pad.left}" y1="${y}" x2="${pad.left + chartW}" y2="${y}" stroke="#eadfcb" stroke-width="1" />`;
  }).join('');

  const incomePath = income.map((value, index) => {
    const x = getX(index);
    const y = getIncomeY(value);
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
  const ticketsPath = tickets.map((value, index) => {
    const x = getX(index);
    const y = getTicketsY(value);
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');

  const pointLabels = labels.map((label, index) => {
    const x = getX(index);
    const incomeY = getIncomeY(income[index] || 0);
    const ticketsY = getTicketsY(tickets[index] || 0);
    const axisY = pad.top + chartH + 22;
    const showAxisLabel = (index % labelStep === 0) || index === labels.length - 1;
    const incomeValue = `$${Number(income[index] || 0).toFixed(2)}`;
    const ticketsValue = `${Number(tickets[index] || 0)} b`;
    return `
      <circle cx="${x}" cy="${incomeY}" r="3" fill="#d46920" />
      <circle cx="${x}" cy="${ticketsY}" r="3" fill="#2472c8" />
      <text x="${x}" y="${incomeY - 10}" text-anchor="middle" font-size="10" fill="#9c4d17">${escapeHtml(incomeValue)}</text>
      <text x="${x}" y="${ticketsY + 14}" text-anchor="middle" font-size="10" fill="#1f5fa8">${escapeHtml(ticketsValue)}</text>
      ${showAxisLabel ? `<text x="${x}" y="${axisY}" text-anchor="middle" font-size="10" fill="#5f584b">${escapeHtml(label)}</text>` : ''}
    `;
  }).join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(title)}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#fffdf8" />
      ${gridLines}
      <text x="${pad.left}" y="24" font-size="13" font-weight="700" fill="#1d1a13">${escapeHtml(title)}</text>
      <path d="${incomePath}" fill="none" stroke="#d46920" stroke-width="2.2" />
      <path d="${ticketsPath}" fill="none" stroke="#2472c8" stroke-width="2.2" stroke-dasharray="6 4" />
      ${pointLabels}
      <g transform="translate(${pad.left}, ${height - 22})">
        <circle cx="0" cy="0" r="4" fill="#d46920" />
        <text x="10" y="4" font-size="11" fill="#6a6355">Ingresos</text>
        <circle cx="90" cy="0" r="4" fill="#2472c8" />
        <text x="100" y="4" font-size="11" fill="#6a6355">Boletos</text>
      </g>
    </svg>
  `;
}

function formatSingleTrendPeriodLabel(row, bucket, index, mode = 'table') {
  const startLabelDay = formatTrendPointLabel(row?.period_start, 'day');
  const endLabelDay = row?.period_end ? formatTrendPointLabel(row.period_end, 'day') : startLabelDay;

  if (bucket === 'day') {
    return startLabelDay;
  }

  if (bucket === 'week') {
    return startLabelDay;
  }

  if (bucket === 'month') {
    if (mode === 'chart') {
      return `Sem ${Number(index || 0) + 1}`;
    }
    return `Semana ${Number(index || 0) + 1} (${startLabelDay} - ${endLabelDay})`;
  }

  if (bucket === 'year') {
    return formatTrendPointLabel(row?.period_start, 'month');
  }

  return startLabelDay;
}

async function buildEventAdminReport(eventId, options = {}) {
  await ensureTicketCreatedAtSupport();

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
  const bucket = ['day', 'week', 'month', 'year'].includes(options.bucket) ? options.bucket : 'day';
  const offset = Number.isInteger(Number(options.offset)) ? Number(options.offset) : 0;
  const [dayTrend, weekTrend, monthTrend, yearTrend] = await Promise.all([
    getEventSalesTrend(eventId, 'day', bucket === 'day' ? offset : 0),
    getEventSalesTrend(eventId, 'week', bucket === 'week' ? offset : 0),
    getEventSalesTrend(eventId, 'month', bucket === 'month' ? offset : 0),
    getEventSalesTrend(eventId, 'year', bucket === 'year' ? offset : 0),
  ]);

  return {
    event,
    ticket_types: ticketTypesResult.rows,
    total_tickets_sold: Number(totals.total_tickets_sold || 0),
    tickets_unsold: Number(totals.tickets_unsold || 0),
    total_income: Number(totals.total_income || 0),
    unsold_potential: Number(totals.unsold_potential || 0),
    total_capacity: Number(totals.total_capacity || 0),
    trend_window: {
      bucket,
      offset,
    },
    trends: {
      day: dayTrend,
      week: weekTrend,
      month: monthTrend,
      year: yearTrend,
    },
  };
}

async function getSingleTrendDetailRows(eventId, bucket, offset = 0) {
  await ensureTicketCreatedAtSupport();
  const safeOffset = Number.isInteger(Number(offset)) ? Number(offset) : 0;

  if (bucket === 'day') {
    const query = `
      WITH bounds AS (
        SELECT date_trunc('day', NOW()) - INTERVAL '1 day' * $2 AS day_start
      ),
      sales AS (
        SELECT
          date_trunc('day', COALESCE(t.created_at, NOW())) AS period_start,
          COUNT(*)::int AS tickets_sold,
          COALESCE(SUM(tt.price), 0)::numeric AS total_income
        FROM tickets t
        JOIN ticket_types tt ON tt.id = t.ticket_type_id
        WHERE tt.event_id = $1
        GROUP BY 1
      )
      SELECT
        b.day_start AS period_start,
        COALESCE(s.tickets_sold, 0)::int AS tickets_sold,
        COALESCE(s.total_income, 0)::numeric AS total_income
      FROM bounds b
      LEFT JOIN sales s ON s.period_start = b.day_start
    `;
    const result = await pool.query(query, [eventId, safeOffset]);
    return (result.rows || []).map((row) => ({
      period_start: row.period_start,
      period_end: row.period_start,
      tickets_sold: Number(row.tickets_sold || 0),
      total_income: Number(row.total_income || 0),
    }));
  }

  if (bucket === 'week') {
    const query = `
      WITH bounds AS (
        SELECT date_trunc('week', NOW()) - INTERVAL '1 week' * $2 AS week_start
      ),
      series AS (
        SELECT generate_series(
          (SELECT week_start FROM bounds),
          (SELECT week_start FROM bounds) + INTERVAL '6 day',
          INTERVAL '1 day'
        ) AS period_start
      ),
      sales AS (
        SELECT
          date_trunc('day', COALESCE(t.created_at, NOW())) AS period_start,
          COUNT(*)::int AS tickets_sold,
          COALESCE(SUM(tt.price), 0)::numeric AS total_income
        FROM tickets t
        JOIN ticket_types tt ON tt.id = t.ticket_type_id
        WHERE tt.event_id = $1
        GROUP BY 1
      )
      SELECT
        s.period_start,
        COALESCE(sa.tickets_sold, 0)::int AS tickets_sold,
        COALESCE(sa.total_income, 0)::numeric AS total_income
      FROM series s
      LEFT JOIN sales sa ON sa.period_start = s.period_start
      ORDER BY s.period_start ASC
    `;
    const result = await pool.query(query, [eventId, safeOffset]);
    return (result.rows || []).map((row) => ({
      period_start: row.period_start,
      period_end: row.period_start,
      tickets_sold: Number(row.tickets_sold || 0),
      total_income: Number(row.total_income || 0),
    }));
  }

  if (bucket === 'month') {
    const query = `
      WITH bounds AS (
        SELECT
          date_trunc('month', NOW()) - INTERVAL '1 month' * $2 AS month_start,
          date_trunc('month', NOW()) - INTERVAL '1 month' * $2 + INTERVAL '1 month' AS next_month_start
      ),
      series AS (
        SELECT generate_series(
          (SELECT month_start FROM bounds),
          (SELECT next_month_start FROM bounds) - INTERVAL '1 day',
          INTERVAL '7 day'
        ) AS period_start
      ),
      periods AS (
        SELECT
          s.period_start,
          LEAST(s.period_start + INTERVAL '6 day', b.next_month_start - INTERVAL '1 day') AS period_end
        FROM series s
        CROSS JOIN bounds b
      ),
      sales AS (
        SELECT
          p.period_start,
          p.period_end,
          COUNT(t.id)::int AS tickets_sold,
          COALESCE(SUM(CASE WHEN t.id IS NOT NULL THEN tt.price ELSE 0 END), 0)::numeric AS total_income
        FROM periods p
        LEFT JOIN ticket_types tt ON tt.event_id = $1
        LEFT JOIN tickets t
          ON t.ticket_type_id = tt.id
         AND COALESCE(t.created_at, NOW()) >= p.period_start
         AND COALESCE(t.created_at, NOW()) < (p.period_end + INTERVAL '1 day')
        GROUP BY p.period_start, p.period_end
      )
      SELECT
        sa.period_start,
        sa.period_end,
        COALESCE(sa.tickets_sold, 0)::int AS tickets_sold,
        COALESCE(sa.total_income, 0)::numeric AS total_income
      FROM sales sa
      ORDER BY sa.period_start ASC
    `;
    const result = await pool.query(query, [eventId, safeOffset]);
    return (result.rows || []).map((row) => ({
      period_start: row.period_start,
      period_end: row.period_end,
      tickets_sold: Number(row.tickets_sold || 0),
      total_income: Number(row.total_income || 0),
    }));
  }

  if (bucket === 'year') {
    const query = `
      WITH bounds AS (
        SELECT
          date_trunc('year', NOW()) - INTERVAL '1 year' * $2 AS year_start,
          date_trunc('year', NOW()) - INTERVAL '1 year' * $2 + INTERVAL '1 year' AS next_year_start
      ),
      series AS (
        SELECT generate_series(
          (SELECT year_start FROM bounds),
          (SELECT next_year_start FROM bounds) - INTERVAL '1 month',
          INTERVAL '1 month'
        ) AS period_start
      ),
      sales AS (
        SELECT
          date_trunc('month', COALESCE(t.created_at, NOW())) AS period_start,
          COUNT(*)::int AS tickets_sold,
          COALESCE(SUM(tt.price), 0)::numeric AS total_income
        FROM tickets t
        JOIN ticket_types tt ON tt.id = t.ticket_type_id
        CROSS JOIN bounds b
        WHERE tt.event_id = $1
          AND COALESCE(t.created_at, NOW()) >= b.year_start
          AND COALESCE(t.created_at, NOW()) < b.next_year_start
        GROUP BY 1
      )
      SELECT
        s.period_start,
        COALESCE(sa.tickets_sold, 0)::int AS tickets_sold,
        COALESCE(sa.total_income, 0)::numeric AS total_income
      FROM series s
      LEFT JOIN sales sa ON sa.period_start = s.period_start
      ORDER BY s.period_start ASC
    `;
    const result = await pool.query(query, [eventId, safeOffset]);
    return (result.rows || []).map((row) => ({
      period_start: row.period_start,
      period_end: row.period_start,
      tickets_sold: Number(row.tickets_sold || 0),
      total_income: Number(row.total_income || 0),
    }));
  }

  return [];
}

router.get('/admin/overview', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const supportsEndTime = await ensureEventEndTimeSupport();
    const eventRows = await pool.query('SELECT * FROM events ORDER BY event_date DESC, event_time DESC');
    const reports = [];
    for (const event of eventRows.rows) {
      const report = await buildEventAdminReport(event.id);
      if (report) {
        reports.push({
          id: event.id,
          name: event.name,
          image_url: event.image_url || null,
          location: event.location,
          event_date: event.event_date,
          event_time: event.event_time,
          event_end_time: supportsEndTime ? (event.event_end_time || null) : null,
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
  const bucket = String(req.query.bucket || 'day').toLowerCase();
  const offset = Number(req.query.offset || 0);

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'No autorizado' });
  }

  try {
    const report = await buildEventAdminReport(id, { bucket, offset });
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
    const requestedBucket = String(req.query.bucket || 'day').toLowerCase();
    const singleTrend = String(req.query.singleTrend || '0').toLowerCase() === '1'
      || String(req.query.singleTrend || '').toLowerCase() === 'true';
    const report = await buildEventAdminReport(id, {
      bucket: requestedBucket,
      offset: Number(req.query.offset || 0),
    });
    if (!report) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const event = report.event;
    const eventDate = event.event_date ? new Date(event.event_date).toLocaleDateString('es-MX') : 'Fecha por confirmar';
    const eventTime = event.event_time && event.event_end_time
      ? ` ${event.event_time} - ${event.event_end_time}`
      : (event.event_time ? ` ${event.event_time}` : '');
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
    const generatedAt = new Date().toLocaleString('es-MX', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'America/Mexico_City',
    });
    const trendBuckets = [
      { key: 'day', title: 'Grafica diaria' },
      { key: 'week', title: 'Grafica semanal' },
      { key: 'month', title: 'Grafica mensual' },
      { key: 'year', title: 'Grafica anual' },
    ];
    const selectedTrendBuckets = singleTrend
      ? trendBuckets.filter((bucketInfo) => bucketInfo.key === requestedBucket)
      : trendBuckets;
    const trendSections = await Promise.all(selectedTrendBuckets.map(async (bucketInfo) => {
      const requestOffset = Number(req.query.offset || 0);
      const bucketOffset = bucketInfo.key === requestedBucket ? requestOffset : 0;
      const detailRows = await getSingleTrendDetailRows(id, bucketInfo.key, bucketOffset);

      const detailRowsLabeled = detailRows.map((row, index) => ({
        ...row,
        period_label_chart: formatSingleTrendPeriodLabel(row, bucketInfo.key, index, 'chart'),
        period_label_table: formatSingleTrendPeriodLabel(row, bucketInfo.key, index, 'table'),
      }));

      const chartRows = detailRowsLabeled.map((row) => ({ ...row, period_label: row.period_label_chart }));

      const labelBucket = bucketInfo.key === 'week'
        ? 'day'
        : bucketInfo.key === 'month'
          ? 'week'
          : bucketInfo.key === 'year'
            ? 'month'
            : 'day';

      const labelRows = chartRows.length ? chartRows : detailRowsLabeled;
      const firstLabel = labelRows.length ? formatTrendPointLabel(labelRows[0].period_start, labelBucket) : 'Sin datos';
      const lastLabel = labelRows.length ? formatTrendPointLabel(labelRows[labelRows.length - 1].period_start, labelBucket) : 'Sin datos';
      const chartTitle = `${bucketInfo.title} | ${event.name || 'Evento'} | ${eventDate}${eventTime} | ${generatedAt}`;
      const chartSvg = buildTrendChartSvg(chartRows, labelBucket, chartTitle);

      const tableRows = detailRowsLabeled;

      const pointRows = tableRows.map((row) => `
        <tr>
          <td>${escapeHtml(row.period_label_table || formatTrendPointLabel(row.period_start, labelBucket))}</td>
          <td>${Number(row.tickets_sold || 0)}</td>
          <td>$${Number(row.total_income || 0).toFixed(2)}</td>
        </tr>
      `).join('');

      return `
        <section class="trend-section">
          <h3>${escapeHtml(`${bucketInfo.title} (${firstLabel} a ${lastLabel})`)}</h3>
          <div class="chart-wrap">${chartSvg}</div>
          <table class="points-table">
            <thead>
              <tr>
                <th>Periodo</th>
                <th>Boletos</th>
                <th>Ingresos</th>
              </tr>
            </thead>
            <tbody>
              ${pointRows || '<tr><td colspan="3">Sin ventas registradas en este periodo</td></tr>'}
            </tbody>
          </table>
        </section>
      `;
    }));
    const trendSectionsHtml = trendSections.join('');

    const html = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; color: #111; padding: 28px; }
          h1 { margin: 0 0 6px; font-size: 24px; }
          h3 { margin: 0 0 8px; font-size: 15px; }
          .muted { color: #666; font-size: 12px; margin-bottom: 14px; }
          .summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 16px 0 18px; }
          .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
          .card span { display: block; font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: .04em; }
          .card strong { display: block; margin-top: 4px; font-size: 18px; }
          table { width: 100%; border-collapse: collapse; margin-top: 14px; }
          th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; font-size: 12px; }
          th { background: #f5f5f5; }
          .trend-section { margin-top: 22px; page-break-inside: avoid; }
          .chart-wrap { border: 1px solid #ddd; border-radius: 10px; padding: 8px; background: #fffdf8; }
          .points-table { margin-top: 10px; }
          .footer { margin-top: 18px; font-size: 12px; color: #555; }
        </style>
      </head>
      <body>
        <h1>${singleTrend ? 'Grafica del evento' : 'Estado de cuenta del evento'}</h1>
        <div class="muted">${escapeHtml(event.name || 'Evento')} | ${escapeHtml(`${eventDate}${eventTime} | ${event.location || 'Ubicacion por confirmar'}`)} | ${escapeHtml(statusLabel)}</div>
        <div class="muted">Fecha de generacion del reporte: ${escapeHtml(generatedAt)}</div>
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
        ${trendSectionsHtml}
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
      const cleanName = escapeHtml(event.name || 'evento').replace(/[^a-zA-Z0-9_-]+/g, '-');
      const filename = singleTrend
        ? `grafica-${requestedBucket}-evento-${cleanName}.pdf`
        : `reporte-evento-${cleanName}.pdf`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
    const supportsEndTime = await ensureEventEndTimeSupport();
    const query = supportsImage
      ? 'SELECT * FROM events ORDER BY event_date, event_time'
      : 'SELECT *, NULL::text AS image_url FROM events ORDER BY event_date, event_time';
    const result = await pool.query(query);
    const withEndTime = supportsEndTime
      ? result.rows
      : result.rows.map((event) => ({ ...event, event_end_time: null }));
    const rows = requestUser && (requestUser.role === 'admin' || requestUser.role === 'organizer')
      ? withEndTime
      : withEndTime.filter((event) => isPastEvent(event) || !supportsActive || isEventActive(event));

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
    const supportsEndTime = await ensureEventEndTimeSupport();
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
    res.json({
      ...event,
      event_end_time: supportsEndTime ? (event.event_end_time || null) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const { name, location, event_date, event_time, event_end_time = null, description, capacity, artist_name, artist_fee, image_url = null } = req.body;

  try {
    const supportsActive = await ensureActiveSupport();
    const supportsImage = await ensureImageSupport();
    const supportsEndTime = await ensureEventEndTimeSupport();

    if (!isValidTimeRange(event_time, event_end_time)) {
      return res.status(400).json({ error: 'La hora de fin debe ser mayor a la hora de inicio' });
    }

    let result;
    if (supportsImage && supportsActive && supportsEndTime) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, event_end_time, description, capacity, artist_name, artist_fee, organizer_id, image_url, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE) RETURNING *`,
        [name, location, event_date, event_time, event_end_time || null, description, capacity, artist_name, artist_fee, req.user.id, image_url]
      );
    } else if (supportsImage && supportsActive) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id, image_url, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE) RETURNING *`,
        [name, location, event_date, event_time, description, capacity, artist_name, artist_fee, req.user.id, image_url]
      );
    } else if (supportsImage && supportsEndTime) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, event_end_time, description, capacity, artist_name, artist_fee, organizer_id, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [name, location, event_date, event_time, event_end_time || null, description, capacity, artist_name, artist_fee, req.user.id, image_url]
      );
    } else if (supportsImage) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [name, location, event_date, event_time, description, capacity, artist_name, artist_fee, req.user.id, image_url]
      );
    } else if (supportsActive && supportsEndTime) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, event_end_time, description, capacity, artist_name, artist_fee, organizer_id, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE) RETURNING *, NULL::text AS image_url`,
        [name, location, event_date, event_time, event_end_time || null, description, capacity, artist_name, artist_fee, req.user.id]
      );
    } else if (supportsActive) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE) RETURNING *, NULL::text AS image_url`,
        [name, location, event_date, event_time, description, capacity, artist_name, artist_fee, req.user.id]
      );
    } else if (supportsEndTime) {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, event_end_time, description, capacity, artist_name, artist_fee, organizer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *, NULL::text AS image_url`,
        [name, location, event_date, event_time, event_end_time || null, description, capacity, artist_name, artist_fee, req.user.id]
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
    event_end_time,
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
    const supportsEndTime = await ensureEventEndTimeSupport();

    if (!isValidTimeRange(event_time ?? current.event_time, event_end_time ?? current.event_end_time)) {
      return res.status(400).json({ error: 'La hora de fin debe ser mayor a la hora de inicio' });
    }

    if (!canManageEvent(req.user, current.organizer_id)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const next = {
      name: name ?? current.name,
      location: location ?? current.location,
      event_date: event_date ?? current.event_date,
      event_time: event_time ?? current.event_time,
      event_end_time: event_end_time ?? current.event_end_time,
      description: description ?? current.description,
      capacity: capacity ?? current.capacity,
      artist_name: artist_name ?? current.artist_name,
      artist_fee: artist_fee ?? current.artist_fee
    };

    const result = supportsEndTime
      ? await pool.query(
        `UPDATE events
         SET name = $1, location = $2, event_date = $3, event_time = $4, event_end_time = $5,
             description = $6, capacity = $7, artist_name = $8, artist_fee = $9
         WHERE id = $10
         RETURNING *`,
        [
          next.name,
          next.location,
          next.event_date,
          next.event_time,
          next.event_end_time || null,
          next.description,
          next.capacity,
          next.artist_name,
          next.artist_fee,
          id
        ]
      )
      : await pool.query(
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