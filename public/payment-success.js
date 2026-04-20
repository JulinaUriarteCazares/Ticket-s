(function () {
  const paymentStatusBadge = document.getElementById('paymentStatusBadge');
  const purchaseSuccessDetail = document.getElementById('purchaseSuccessDetail');
  const purchaseSuccessSummary = document.getElementById('purchaseSuccessSummary');
  const paymentSessionId = document.getElementById('paymentSessionId');
  const paymentTotal = document.getElementById('paymentTotal');
  const paymentTotalInline = document.getElementById('paymentTotalInline');
  const paymentStatusText = document.getElementById('paymentStatusText');
  const paymentItems = document.getElementById('paymentItems');
  const purchaseTicketsWrap = document.getElementById('purchaseTicketsWrap');
  const purchaseTicketsGrid = document.getElementById('purchaseTicketsGrid');
  const ticketCardTemplate = document.getElementById('ticketCardTemplate');
  const downloadAllPaidTickets = document.getElementById('downloadAllPaidTickets');
  const closePurchaseSuccess = document.getElementById('closePurchaseSuccess');

  let lastPurchasedTickets = [];
  let lastResolvedTicketKey = '';

  function formatMoney(value) {
    return Number(value || 0).toLocaleString('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function notifyFallback(message) {
    if (purchaseSuccessDetail) {
      purchaseSuccessDetail.textContent = message;
    }
  }

  function getSessionId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('session_id') || localStorage.getItem('tm_last_checkout_session_id') || '';
  }

  function getToken() {
    return localStorage.getItem('tm_token') || '';
  }

  function getCartPrefix() {
    const userRaw = localStorage.getItem('tm_user');
    let user = null;
    if (userRaw) {
      try {
        user = JSON.parse(userRaw);
      } catch (err) {
        user = null;
      }
    }
    const owner = user?.id ? `user_${user.id}` : 'guest';
    return `tm_cart_v1_${owner}_event_`;
  }

  function clearCurrentCart() {
    const prefix = getCartPrefix();
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(prefix)) {
        localStorage.removeItem(key);
      }
    }
  }

  function clearBoletosCache() {
    sessionStorage.removeItem('tm_boletos_cache');
    sessionStorage.removeItem('tm_boletos_cache_time');
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatEventDate(dateText, timeText) {
    if (!dateText) {
      return 'Fecha por confirmar';
    }

    const date = new Date(dateText);
    const safeDate = Number.isNaN(date.getTime()) ? String(dateText) : date.toLocaleDateString('es-MX');
    return `${safeDate}${timeText ? ` ${timeText}` : ''}`;
  }

  function isNoSeatTicketTypeName(typeName) {
    const normalized = String(typeName || '').trim().toLowerCase();
    const compact = normalized.replace(/[^a-z]/g, '');
    return compact === 'generalnormal' || compact === 'general' || compact === 'normal';
  }

  function getDisplaySeatNumber(typeName, seatNumber) {
    const raw = String(seatNumber || '').trim();
    if (!raw) {
      return 'N/A';
    }
    if (isNoSeatTicketTypeName(typeName) || raw.toUpperCase().startsWith('N/A-')) {
      return 'N/A';
    }
    return raw;
  }

  function renderItems(items) {
    if (!Array.isArray(items) || !items.length) {
      paymentItems.innerHTML = '<li>No se encontraron items del pago.</li>';
      return;
    }

    paymentItems.innerHTML = items.map((item) => {
      const subtotal = Number(item.quantity || 0) * Number(item.unitPrice || 0);
      return `<li><strong>${escapeHtml(item.eventName || 'Evento')}</strong> · ${escapeHtml(item.typeName || 'Boleto')} - ${Number(item.quantity || 0)} x $${formatMoney(item.unitPrice || 0)} = $${formatMoney(subtotal)}</li>`;
    }).join('');
  }

  function flattenTicketLines(items) {
    const safeItems = Array.isArray(items) ? items : [];
    const lines = [];

    safeItems.forEach((item) => {
      const quantity = Number(item.quantity || 0);
      const seats = Array.isArray(item.seatLabels) ? item.seatLabels : [];

      if (seats.length) {
        seats.forEach((seatLabel) => {
          lines.push({
            eventName: item.eventName || 'Evento',
            typeName: item.typeName || 'Boleto',
            seatLabel: seatLabel || 'N/A',
            unitPrice: Number(item.unitPrice || 0),
          });
        });
      } else {
        for (let index = 0; index < Math.max(quantity, 1); index += 1) {
          lines.push({
            eventName: item.eventName || 'Evento',
            typeName: item.typeName || 'Boleto',
            seatLabel: 'N/A',
            unitPrice: Number(item.unitPrice || 0),
          });
        }
      }
    });

    return lines;
  }

  async function fetchPurchasedEvents() {
    return apiCall('GET', '/tickets/purchased-events');
  }

  async function resolvePurchasedTicketsById(ticketIds) {
    const normalizedIds = Array.isArray(ticketIds)
      ? ticketIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];

    if (!normalizedIds.length) {
      return [];
    }

    const events = await fetchPurchasedEvents();
    const ticketMap = new Map();

    (Array.isArray(events) ? events : []).forEach((event) => {
      (Array.isArray(event.tickets) ? event.tickets : []).forEach((ticket) => {
        ticketMap.set(String(ticket.id), {
          id: ticket.id,
          qrCode: ticket.qr_code,
          seatNumber: ticket.seat_number,
          status: ticket.status,
          event: {
            id: event.id,
            name: event.name,
            event_date: event.event_date,
            event_time: event.event_time,
            location: event.location,
            image_url: event.image_url,
            artist_name: event.artist_name,
          },
          ticketType: {
            type_name: ticket.type_name,
            price: Number(ticket.price || 0),
          },
        });
      });
    });

    return normalizedIds.map((id) => ticketMap.get(id)).filter(Boolean);
  }

  function setQrPlaceholder(container) {
    container.innerHTML = '<span style="font-size:12px;color:#7b7383;">Generando QR...</span>';
  }

  async function hydrateTicketQr(container, ticketId) {
    try {
      const token = getToken();
      const response = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/qr-svg`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        throw new Error('No se pudo obtener QR');
      }

      const data = await response.json();
      container.innerHTML = data.qrSvg || '';
    } catch (err) {
      container.innerHTML = '<span style="font-size:12px;color:#7b7383;">QR no disponible</span>';
    }
  }

  function renderPurchasedTickets(tickets) {
    lastPurchasedTickets = Array.isArray(tickets) ? tickets : [];
    if (!purchaseTicketsWrap || !purchaseTicketsGrid || !ticketCardTemplate) {
      return;
    }

    if (!lastPurchasedTickets.length) {
      purchaseTicketsWrap.classList.add('hidden');
      purchaseTicketsGrid.innerHTML = '';
      if (downloadAllPaidTickets) {
        downloadAllPaidTickets.classList.add('hidden');
      }
      return;
    }

    purchaseTicketsWrap.classList.remove('hidden');
    purchaseTicketsGrid.innerHTML = '';

    lastPurchasedTickets.forEach((ticket) => {
      const fragment = ticketCardTemplate.content.cloneNode(true);
      const card = fragment.querySelector('.generated-ticket');
      const image = fragment.querySelector('.generated-ticket-image');
      const name = fragment.querySelector('.ticket-event-name');
      const subtitle = fragment.querySelector('.ticket-event-subtitle');
      const artist = fragment.querySelector('.ticket-event-artist');
      const typeName = fragment.querySelector('.ticket-type-name');
      const seatNumber = fragment.querySelector('.ticket-seat-number');
      const price = fragment.querySelector('.ticket-price');
      const status = fragment.querySelector('.ticket-status');
      const qrContainer = fragment.querySelector('.qr-container');
      const downloadBtn = fragment.querySelector('.download-single');

      const event = ticket.event || {};
      const ticketType = ticket.ticketType || {};

      image.src = event.image_url || 'https://placehold.co/520x760?text=Evento';
      image.alt = event.name || 'Boleto';
      name.textContent = event.name || 'Evento';
      subtitle.textContent = `${formatEventDate(event.event_date, event.event_time)} | ${event.location || 'Ubicacion por confirmar'}`;
      artist.textContent = `Artista: ${event.artist_name || 'Por confirmar'}`;
      typeName.textContent = ticketType.type_name || 'Boleto';
      seatNumber.textContent = getDisplaySeatNumber(ticketType.type_name, ticket.seatNumber);
      price.textContent = `$${formatMoney(ticketType.price || 0)}`;
      status.textContent = ticket.status === false ? 'Usado' : 'Confirmado';

      if (card) {
        card.dataset.ticketId = String(ticket.id || '');
      }

      if (downloadBtn) {
        downloadBtn.dataset.ticketId = String(ticket.id || '');
      }

      if (qrContainer) {
        setQrPlaceholder(qrContainer);
        hydrateTicketQr(qrContainer, ticket.id).catch(() => {});
      }

      purchaseTicketsGrid.appendChild(fragment);
    });

    if (downloadAllPaidTickets) {
      downloadAllPaidTickets.classList.toggle('hidden', lastPurchasedTickets.length <= 1);
    }
  }

  async function apiCall(method, url) {
    const headers = {};
    const token = getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`/api${url}`, {
      method,
      headers,
    });

    let data = {};
    try {
      data = await response.json();
    } catch (err) {
      data = {};
    }

    if (!response.ok) {
      throw new Error(data.error || 'No se pudo obtener el detalle del pago');
    }

    return data;
  }

  async function downloadSingleTicket(ticketId) {
    const token = getToken();
    const response = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/pdf`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!response.ok) {
      throw new Error('No se pudo descargar el boleto');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `boleto-${ticketId}.pdf`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadAllTickets(ticketIds) {
    const token = getToken();
    const response = await fetch('/api/tickets/bulk-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ticket_ids: ticketIds }),
    });

    if (!response.ok) {
      throw new Error('No se pudieron descargar todos los boletos');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `boletos-${Date.now()}.pdf`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function updateUi(data) {
    const status = String(data.status || 'unknown').toLowerCase();
    const isPaid = status === 'paid' || status === 'succeeded' || status === 'complete';

    if (paymentStatusBadge) {
      paymentStatusBadge.textContent = isPaid ? 'Pago confirmado' : 'Procesando pago';
      paymentStatusBadge.classList.toggle('is-paid', isPaid);
    }

    if (paymentStatusText) {
      paymentStatusText.textContent = isPaid ? 'Pagado' : 'Pendiente';
    }

    if (paymentSessionId) {
      paymentSessionId.textContent = data.sessionId || '-';
    }

    if (paymentTotal) {
      paymentTotal.textContent = `$${formatMoney(data.amountTotal || 0)}`;
    }

    if (paymentTotalInline) {
      paymentTotalInline.textContent = `$${formatMoney(data.amountTotal || 0)}`;
    }

    const lineItems = Array.isArray(data.payload?.items) ? data.payload.items : [];
    const totalElements = lineItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);

    if (purchaseSuccessDetail) {
      purchaseSuccessDetail.textContent = isPaid
        ? `Tu compra fue exitosa. Se procesaron ${totalElements} elemento(s).`
        : 'Stripe todavia esta confirmando tu pago. Mantente en esta pantalla.';
    }

    renderItems(Array.isArray(data.payload?.items) ? data.payload.items : []);

    if (isPaid) {
      clearCurrentCart();
      clearBoletosCache();
      localStorage.removeItem('tm_last_checkout_session_id');
      localStorage.removeItem('tm_last_checkout_request_id');
    }

    return isPaid;
  }

  async function loadPayment() {
    const sessionId = getSessionId();
    if (!sessionId) {
      notifyFallback('Falta el identificador de sesión de Stripe.');
      return;
    }

    try {
      const data = await apiCall('GET', `/payments/session/${encodeURIComponent(sessionId)}`);
      const isPaid = updateUi(data);

      if (isPaid) {
        const ticketIds = Array.isArray(data.ticketIds) ? data.ticketIds : [];
        const ticketKey = ticketIds.map((id) => String(id)).join('|');
        if (ticketKey !== lastResolvedTicketKey) {
          const resolvedTickets = await resolvePurchasedTicketsById(ticketIds);
          renderPurchasedTickets(resolvedTickets);
          lastResolvedTicketKey = ticketKey;
        }
      } else {
        renderPurchasedTickets([]);
        lastResolvedTicketKey = '';
      }

      if (isPaid && pollTimer) {
        clearInterval(pollTimer);
      }
      if (data.stripe?.paymentStatus && purchaseSuccessDetail && !isPaid) {
        purchaseSuccessDetail.textContent = `Estado actual en Stripe: ${data.stripe.paymentStatus}`;
      }
    } catch (err) {
      notifyFallback(err.message);
    }
  }

  const pollTimer = setInterval(() => {
    loadPayment().catch(() => {});
  }, 2500);

  if (purchaseTicketsGrid) {
    purchaseTicketsGrid.addEventListener('click', (event) => {
      const button = event.target.closest('[data-ticket-id]');
      if (!button) {
        return;
      }

      downloadSingleTicket(button.dataset.ticketId).catch((err) => notifyFallback(err.message));
    });
  }

  if (downloadAllPaidTickets) {
    downloadAllPaidTickets.addEventListener('click', async () => {
      try {
        const ticketIds = lastPurchasedTickets.map((ticket) => ticket?.id).filter(Boolean);
        if (!ticketIds.length) {
          throw new Error('Aun no hay boletos generados para descargar');
        }
        await downloadAllTickets(ticketIds);
      } catch (err) {
        notifyFallback(err.message);
      }
    });
  }

  if (closePurchaseSuccess) {
    closePurchaseSuccess.addEventListener('click', () => {
      window.location.href = '/';
    });
  }

  loadPayment().catch((err) => notifyFallback(err.message));
})();
