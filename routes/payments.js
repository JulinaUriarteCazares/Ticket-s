const express = require('express');
const { randomUUID, randomBytes } = require('crypto');
const Stripe = require('stripe');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

function isStripeSecretKeyValid(value) {
  return /^sk_test_/.test(String(value || '').trim());
}

function isStripeLiveKey(value) {
  return /^sk_live_/.test(String(value || '').trim());
}

let seatsSupportChecked = false;
let seatsSupported = false;

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

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function isPublicImageUrl(url) {
  const value = String(url || '').trim();
  return /^https?:\/\//i.test(value);
}

function isNoSeatType(typeName) {
  const normalized = String(typeName || '').trim().toLowerCase();
  const compact = normalized.replace(/[^a-z]/g, '');
  return compact === 'generalnormal' || compact === 'general' || compact === 'normal';
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function cleanupExpiredReservations(client) {
  const supportsSeats = await ensureSeatsSupport();
  if (!supportsSeats) {
    return;
  }

  await client.query(
    `UPDATE seats
     SET status = 'available',
         reserved_by = NULL,
         reserved_until = NULL
     WHERE status = 'reserved'
       AND reserved_until IS NOT NULL
       AND reserved_until < NOW()`
  );
}

async function releaseReservedSeatsForItems(client, items, userId) {
  const supportsSeats = await ensureSeatsSupport();
  if (!supportsSeats) {
    return;
  }

  const safeItems = Array.isArray(items) ? items : [];
  for (const item of safeItems) {
    const ticketTypeId = String(item?.ticketTypeId || '').trim();
    const labels = Array.isArray(item?.seatLabels)
      ? [...new Set(item.seatLabels.map((label) => String(label || '').trim().toUpperCase()).filter(Boolean))]
      : [];

    if (!ticketTypeId || !labels.length) {
      continue;
    }

    await client.query(
      `UPDATE seats
       SET status = 'available',
           reserved_by = NULL,
           reserved_until = NULL
       WHERE ticket_type_id = $1
         AND UPPER(seat_label) = ANY($2::text[])
         AND status = 'reserved'
         AND (reserved_by IS NULL OR reserved_by::text = $3)`,
      [ticketTypeId, labels, String(userId || '')]
    );
  }
}

async function closePendingPaymentAndReleaseSeats(client, paymentRow, nextStatus, stripeStatus, errorMessage = null) {
  if (!paymentRow || String(paymentRow.status || '').toLowerCase() !== 'pending') {
    return;
  }

  const items = Array.isArray(paymentRow.payload?.items) ? paymentRow.payload.items : [];
  await releaseReservedSeatsForItems(client, items, paymentRow.user_id);

  await client.query(
    `UPDATE stripe_payments
     SET status = $2,
         stripe_status = $3,
         error_message = $4,
         updated_at = NOW()
     WHERE id = $1
       AND status = 'pending'`,
    [paymentRow.id, nextStatus, stripeStatus, errorMessage]
  );
}

async function closePreviousPendingPaymentsForUser(client, userId) {
  const pendingResult = await client.query(
    `SELECT *
     FROM stripe_payments
     WHERE user_id = $1
       AND status = 'pending'
     FOR UPDATE`,
    [String(userId)]
  );

  for (const pendingPayment of pendingResult.rows) {
    await closePendingPaymentAndReleaseSeats(
      client,
      pendingPayment,
      'abandoned',
      'superseded',
      'Checkout reemplazado por un nuevo intento de pago'
    );
  }
}

async function ensurePaymentSupport(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS stripe_payments (
      id UUID PRIMARY KEY,
      request_id UUID UNIQUE NOT NULL,
      stripe_session_id TEXT UNIQUE,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      currency TEXT NOT NULL DEFAULT 'mxn',
      amount_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      payload JSONB NOT NULL,
      session_url TEXT,
      stripe_status TEXT,
      ticket_ids JSONB,
      error_message TEXT,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMP WITHOUT TIME ZONE
    )`
  );
}

async function fetchTicketTypeAndEvent(client, ticketTypeId) {
  const result = await client.query(
    `SELECT tt.id, tt.type_name, tt.price, tt.capacity, tt.sold, tt.event_id,
            e.name AS event_name, e.event_date, e.event_time, e.location, e.image_url
     FROM ticket_types tt
     JOIN events e ON e.id = tt.event_id
     WHERE tt.id = $1`,
    [ticketTypeId]
  );

  return result.rows[0] || null;
}

function buildStripeLineItem(item, ticketType, event) {
  const seatLabels = Array.isArray(item.seatLabels) ? item.seatLabels : [];
  const seatText = seatLabels.length ? `Asientos: ${seatLabels.join(', ')}` : 'Asientos asignados automaticamente';
  const description = `${event.name} · ${ticketType.type_name} · ${seatText}`;
  const imageUrl = isPublicImageUrl(event.image_url) ? String(event.image_url).trim() : null;

  return {
    price_data: {
      currency: 'mxn',
      unit_amount: Math.round(Number(ticketType.price || 0) * 100),
      product_data: {
        name: `${event.name} - ${ticketType.type_name}`,
        description,
        images: imageUrl ? [imageUrl] : undefined,
      },
    },
    quantity: Number(item.quantity || 1),
  };
}

async function reserveSeatsForItem(client, ticketTypeId, seatLabels, userId) {
  if (!seatLabels.length) {
    return [];
  }

  const supportsSeats = await ensureSeatsSupport();
  if (!supportsSeats) {
    throw new Error('No hay soporte de asientos configurado en la base de datos');
  }

  const normalizedLabels = [...new Set(seatLabels.map((label) => String(label || '').trim().toUpperCase()).filter(Boolean))];
  if (!normalizedLabels.length) {
    throw new Error('Debes seleccionar asientos validos');
  }

  const seatsResult = await client.query(
    `SELECT id, seat_label, status, reserved_by, reserved_until
     FROM seats
     WHERE ticket_type_id = $1
       AND UPPER(seat_label) = ANY($2::text[])
     FOR UPDATE`,
    [ticketTypeId, normalizedLabels]
  );

  if (seatsResult.rows.length !== normalizedLabels.length) {
    throw new Error('Algunos asientos no existen');
  }

  const unavailable = seatsResult.rows.filter((seat) => {
    const status = String(seat.status || '').toLowerCase();
    const expired = seat.reserved_until && new Date(seat.reserved_until).getTime() < Date.now();
    return status !== 'available' && !(status === 'reserved' && expired);
  });

  if (unavailable.length) {
    throw new Error('Algunos asientos ya no estan disponibles');
  }

  for (const seat of seatsResult.rows) {
    await client.query(
      `UPDATE seats
       SET status = 'reserved',
           reserved_by = $2,
           reserved_until = NOW() + INTERVAL '30 minutes'
       WHERE id = $1`,
      [seat.id, userId]
    );
  }

  return seatsResult.rows.map((seat) => String(seat.seat_label || '').toUpperCase());
}

async function createTicketsForItem(client, item, paymentId, userId) {
  const ticketType = await fetchTicketTypeAndEvent(client, item.ticketTypeId);
  if (!ticketType) {
    throw new Error('Tipo de boleto no encontrado');
  }

  const available = Number(ticketType.capacity || 0) - Number(ticketType.sold || 0);
  const quantity = Number(item.quantity || 0);
  if (available < quantity) {
    throw new Error(`Solo hay ${available} boletos disponibles para ${ticketType.type_name}`);
  }

  const tickets = [];
  const supportsSeats = await ensureSeatsSupport();
  const seatLabels = Array.isArray(item.seatLabels) ? item.seatLabels : [];

  if (seatLabels.length) {
    for (const seatLabel of seatLabels) {
      const qrCode = randomBytes(16).toString('hex');
      const qrSvg = '';
      const insertResult = await client.query(
        `INSERT INTO tickets (ticket_type_id, user_id, qr_code, seat_number)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [item.ticketTypeId, userId, qrCode, seatLabel]
      );

      tickets.push({
        id: insertResult.rows[0].id,
        qrCode,
        qrSvg,
        seatNumber: seatLabel,
        event: {
          id: ticketType.event_id,
          name: ticketType.event_name,
          event_date: ticketType.event_date,
          event_time: ticketType.event_time,
          location: ticketType.location,
          image_url: ticketType.image_url,
        },
        ticketType: {
          id: ticketType.id,
          type_name: ticketType.type_name,
          price: Number(ticketType.price),
        },
      });
    }

    if (supportsSeats) {
      await client.query(
        `UPDATE seats
         SET status = 'sold',
             reserved_by = NULL,
             reserved_until = NULL
         WHERE ticket_type_id = $1
           AND UPPER(seat_label) = ANY($2::text[])`,
        [item.ticketTypeId, seatLabels.map((label) => String(label).trim().toUpperCase())]
      );
    }
  } else {
    const startSold = Number(ticketType.sold || 0);
    const noSeatType = isNoSeatType(ticketType.type_name);
    for (let index = 1; index <= quantity; index += 1) {
      const seatNumber = noSeatType ? `N/A-${startSold + index}` : String(startSold + index);
      const qrCode = randomBytes(16).toString('hex');
      const qrSvg = '';
      const insertResult = await client.query(
        `INSERT INTO tickets (ticket_type_id, user_id, qr_code, seat_number)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [item.ticketTypeId, userId, qrCode, seatNumber]
      );

      tickets.push({
        id: insertResult.rows[0].id,
        qrCode,
        qrSvg,
        seatNumber,
        event: {
          id: ticketType.event_id,
          name: ticketType.event_name,
          event_date: ticketType.event_date,
          event_time: ticketType.event_time,
          location: ticketType.location,
          image_url: ticketType.image_url,
        },
        ticketType: {
          id: ticketType.id,
          type_name: ticketType.type_name,
          price: Number(ticketType.price),
        },
      });
    }
  }

  await client.query('UPDATE ticket_types SET sold = sold + $2 WHERE id = $1', [item.ticketTypeId, quantity]);

  return tickets;
}

async function finalizePendingPayment(paymentRow, stripeSession) {
  if (!paymentRow || paymentRow.status === 'paid') {
    return paymentRow;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensurePaymentSupport(client);

    const current = await client.query(
      'SELECT * FROM stripe_payments WHERE request_id = $1 FOR UPDATE',
      [paymentRow.request_id]
    );
    const row = current.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }

    if (row.status === 'paid') {
      await client.query('COMMIT');
      return row;
    }

    const payload = Array.isArray(row.payload?.items) ? row.payload.items : [];
    const ticketIds = [];
    for (const item of payload) {
      const tickets = await createTicketsForItem(client, item, row.id, row.user_id);
      ticketIds.push(...tickets.map((ticket) => ticket.id));
    }

    await client.query(
      `UPDATE stripe_payments
       SET status = 'paid',
           stripe_status = $2,
           ticket_ids = $3,
           paid_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, stripeSession?.payment_status || 'paid', JSON.stringify(ticketIds)]
    );

    await client.query('COMMIT');
    return { ...row, status: 'paid', ticket_ids: ticketIds };
  } catch (err) {
    await client.query('ROLLBACK');
    await pool.query(
      `UPDATE stripe_payments
       SET status = 'failed',
           error_message = $2,
           updated_at = NOW()
       WHERE request_id = $1`,
      [paymentRow.request_id, err.message]
    );
    throw err;
  } finally {
    client.release();
  }
}

router.post('/create-checkout-session', auth, async (req, res) => {
  if (!stripeSecretKey) {
    return res.status(500).json({ error: 'Stripe no esta configurado en el servidor' });
  }

  if (isStripeLiveKey(stripeSecretKey)) {
    return res.status(400).json({
      error: 'Solo se permite Stripe en modo prueba (sk_test). No se aceptan llaves live.',
    });
  }

  if (!stripe) {
    return res.status(500).json({ error: 'Stripe no pudo inicializarse en el servidor' });
  }

  if (!isStripeSecretKeyValid(stripeSecretKey)) {
    return res.status(400).json({
      error: 'STRIPE_SECRET_KEY invalida para pruebas. Debe iniciar con sk_test_.',
    });
  }

  const { items: rawItems } = req.body || {};
  const items = Array.isArray(rawItems) ? rawItems : [];

  if (!items.length) {
    return res.status(400).json({ error: 'Debes enviar al menos un boleto para pagar' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensurePaymentSupport(client);
    await cleanupExpiredReservations(client);
    await closePreviousPendingPaymentsForUser(client, req.user.id);

    const userResult = await client.query(
      'SELECT id, name, email FROM users WHERE id = $1',
      [req.user.id]
    );
    const currentUser = userResult.rows[0];
    if (!currentUser) {
      throw new Error('Usuario no encontrado');
    }

    const cleanedItems = [];
    const lineItems = [];
    let totalAmount = 0;

    for (const rawItem of items) {
      const ticketTypeId = String(rawItem?.ticketTypeId || '').trim();
      const quantity = Number(rawItem?.quantity || 0);
      const seatLabels = Array.isArray(rawItem?.seatLabels)
        ? [...new Set(rawItem.seatLabels.map((label) => String(label || '').trim().toUpperCase()).filter(Boolean))]
        : [];

      if (!ticketTypeId || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        throw new Error('Hay boletos invalidos en el carrito');
      }

      const ticketType = await fetchTicketTypeAndEvent(client, ticketTypeId);
      if (!ticketType) {
        throw new Error('Tipo de boleto no encontrado');
      }

      const event = {
        id: ticketType.event_id,
        name: ticketType.event_name,
        event_date: ticketType.event_date,
        event_time: ticketType.event_time,
        location: ticketType.location,
        image_url: ticketType.image_url,
      };

      const normalizedItem = {
        ticketTypeId,
        eventId: String(event.id),
        eventName: event.name,
        typeName: ticketType.type_name,
        unitPrice: Number(ticketType.price),
        quantity,
        seatLabels,
      };

      if (seatLabels.length && seatLabels.length !== quantity) {
        throw new Error(`La cantidad de asientos no coincide para ${ticketType.type_name}`);
      }

      if (seatLabels.length) {
        await reserveSeatsForItem(client, ticketTypeId, seatLabels, req.user.id);
      }

      cleanedItems.push(normalizedItem);
      lineItems.push(buildStripeLineItem(normalizedItem, ticketType, event));
      totalAmount += Number(ticketType.price) * quantity;
    }

    const requestId = randomUUID();
    const successBase = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const firstEventId = cleanedItems[0]?.eventId || '';
    const successUrl = `${successBase.replace(/\/$/, '')}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${successBase.replace(/\/$/, '')}/purchase.html?id=${encodeURIComponent(firstEventId)}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: requestId,
      metadata: {
        request_id: requestId,
        user_id: String(req.user.id),
      },
      billing_address_collection: 'auto',
      customer_email: isValidEmail(currentUser.email) ? normalizeEmail(currentUser.email) : undefined,
    });

    await client.query(
      `INSERT INTO stripe_payments (id, request_id, stripe_session_id, user_id, status, currency, amount_total, payload, session_url, stripe_status)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT (request_id) DO UPDATE
         SET stripe_session_id = EXCLUDED.stripe_session_id,
             status = 'pending',
             currency = EXCLUDED.currency,
             amount_total = EXCLUDED.amount_total,
             payload = EXCLUDED.payload,
             session_url = EXCLUDED.session_url,
             stripe_status = EXCLUDED.stripe_status,
             updated_at = NOW()`,
      [
        requestId,
        requestId,
        session.id,
        String(req.user.id),
        'mxn',
        totalAmount,
        JSON.stringify({ items: cleanedItems }),
        session.url,
        session.payment_status || 'unpaid',
      ]
    );

    await client.query('COMMIT');

    res.json({
      sessionId: session.id,
      url: session.url,
      requestId,
      total: totalAmount,
      items: cleanedItems,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    const stripeErrorType = String(err?.type || '');
    if (stripeErrorType === 'StripeAuthenticationError') {
      return res.status(500).json({
        error: 'No se pudo autenticar con Stripe. Revisa STRIPE_SECRET_KEY en .env.',
      });
    }

    if (stripeErrorType.startsWith('Stripe')) {
      return res.status(502).json({
        error: 'Stripe no pudo iniciar el checkout con los datos enviados.',
      });
    }

    return res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/session/:sessionId', auth, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe no esta configurado en el servidor' });
  }

  const { sessionId } = req.params;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId es obligatorio' });
  }

  try {
    const stripeSession = await stripe.checkout.sessions.retrieve(sessionId);
    let paymentResult = await pool.query(
      'SELECT * FROM stripe_payments WHERE stripe_session_id = $1 OR request_id = $2',
      [sessionId, stripeSession.client_reference_id || stripeSession.metadata?.request_id || null]
    );
    let paymentRow = paymentResult.rows[0] || null;

    const stripePaid = ['paid', 'succeeded', 'complete'].includes(String(stripeSession.payment_status || '').toLowerCase());
    if (stripePaid && paymentRow && String(paymentRow.status || '').toLowerCase() !== 'paid') {
      await finalizePendingPayment(paymentRow, stripeSession);
      paymentResult = await pool.query(
        'SELECT * FROM stripe_payments WHERE stripe_session_id = $1 OR request_id = $2',
        [sessionId, stripeSession.client_reference_id || stripeSession.metadata?.request_id || null]
      );
      paymentRow = paymentResult.rows[0] || paymentRow;
    }

    if (!stripePaid && paymentRow && String(paymentRow.status || '').toLowerCase() === 'pending') {
      const stripeSessionStatus = String(stripeSession.status || '').toLowerCase();
      const stripePaymentStatus = String(stripeSession.payment_status || '').toLowerCase();
      const isExpiredOrCanceled = stripeSessionStatus === 'expired' || stripePaymentStatus === 'canceled';

      if (isExpiredOrCanceled) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await closePendingPaymentAndReleaseSeats(
            client,
            paymentRow,
            'expired',
            stripePaymentStatus || stripeSessionStatus || 'expired',
            'Sesion de pago expirada o cancelada sin confirmacion'
          );
          await client.query('COMMIT');
        } catch (releaseErr) {
          await client.query('ROLLBACK');
          throw releaseErr;
        } finally {
          client.release();
        }

        paymentResult = await pool.query(
          'SELECT * FROM stripe_payments WHERE stripe_session_id = $1 OR request_id = $2',
          [sessionId, stripeSession.client_reference_id || stripeSession.metadata?.request_id || null]
        );
        paymentRow = paymentResult.rows[0] || paymentRow;
      }
    }

    return res.json({
      sessionId,
      status: paymentRow?.status || stripeSession.payment_status || 'unknown',
      stripeStatus: stripeSession.payment_status || null,
      amountTotal: paymentRow ? Number(paymentRow.amount_total || 0) : Number(stripeSession.amount_total || 0) / 100,
      currency: paymentRow?.currency || stripeSession.currency || 'mxn',
      payload: paymentRow?.payload || { items: [] },
      ticketIds: paymentRow?.ticket_ids || [],
      stripe: {
        customerEmail: stripeSession.customer_details?.email || stripeSession.customer_email || null,
        paymentStatus: stripeSession.payment_status || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function webhookHandler(req, res) {
  if (!stripe) {
    return res.status(500).send('Stripe no configurado');
  }

  if (!stripeWebhookSecret) {
    return res.status(500).send('Webhook secret no configurado');
  }

  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const paymentResult = await pool.query(
        'SELECT * FROM stripe_payments WHERE stripe_session_id = $1 OR request_id = $2',
        [session.id, session.client_reference_id || session.metadata?.request_id || null]
      );
      const paymentRow = paymentResult.rows[0];
      if (paymentRow) {
        await finalizePendingPayment(paymentRow, session);
      }
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const paymentResult = await client.query(
          'SELECT * FROM stripe_payments WHERE stripe_session_id = $1 FOR UPDATE',
          [session.id]
        );
        const paymentRow = paymentResult.rows[0];
        if (paymentRow) {
          await closePendingPaymentAndReleaseSeats(
            client,
            paymentRow,
            'expired',
            session.payment_status || 'expired',
            'Sesion de pago expirada sin confirmacion'
          );
        }
        await client.query('COMMIT');
      } catch (webhookErr) {
        await client.query('ROLLBACK');
        throw webhookErr;
      } finally {
        client.release();
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err);
    res.status(500).send('Webhook processing failed');
  }
}

module.exports = {
  router,
  webhook: webhookHandler,
};
