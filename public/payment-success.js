(function () {
  const paymentStatusBadge = document.getElementById('paymentStatusBadge');
  const paymentSubtitle = document.getElementById('paymentSubtitle');
  const paymentSessionId = document.getElementById('paymentSessionId');
  const paymentTotal = document.getElementById('paymentTotal');
  const paymentStatusText = document.getElementById('paymentStatusText');
  const paymentItems = document.getElementById('paymentItems');
  const refreshButton = document.getElementById('refreshPayment');
  const ticketDownloadsSection = document.getElementById('ticketDownloadsSection');
  const paymentTicketList = document.getElementById('paymentTicketList');
  const downloadAllPaidTickets = document.getElementById('downloadAllPaidTickets');

  function formatMoney(value) {
    return Number(value || 0).toLocaleString('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function notifyFallback(message) {
    if (paymentSubtitle) {
      paymentSubtitle.textContent = message;
    }
  }

  function getSessionId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('session_id') || '';
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

  function renderItems(items) {
    if (!Array.isArray(items) || !items.length) {
      paymentItems.innerHTML = '<div class="payment-item">No se encontraron items del pago.</div>';
      return;
    }

    paymentItems.innerHTML = items.map((item) => {
      const seats = Array.isArray(item.seatLabels) && item.seatLabels.length ? `<small>Asientos: ${item.seatLabels.join(', ')}</small>` : '<small>Asientos asignados automaticamente</small>';
      const subtotal = Number(item.quantity || 0) * Number(item.unitPrice || 0);
      return `
        <div class="payment-item">
          <strong>${item.eventName || 'Evento'}</strong>
          <span>${item.typeName || 'Boleto'} · ${item.quantity || 0} x $${formatMoney(item.unitPrice || 0)}</span>
          ${seats}
          <span>Subtotal: $${formatMoney(subtotal)}</span>
        </div>
      `;
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

  function renderTicketDownloads(data, isPaid) {
    const ticketIds = Array.isArray(data.ticketIds) ? data.ticketIds : [];
    if (!isPaid || !ticketIds.length || !ticketDownloadsSection || !paymentTicketList) {
      if (ticketDownloadsSection) {
        ticketDownloadsSection.style.display = 'none';
      }
      return;
    }

    const lines = flattenTicketLines(Array.isArray(data.payload?.items) ? data.payload.items : []);
    paymentTicketList.innerHTML = ticketIds.map((ticketId, index) => {
      const line = lines[index] || {};
      return `
        <article class="payment-ticket-row">
          <div>
            <strong>${line.eventName || 'Evento'} · ${line.typeName || 'Boleto'}</strong>
            <small>Asiento: ${line.seatLabel || 'N/A'} · Precio: $${formatMoney(line.unitPrice || 0)}</small>
          </div>
          <button type="button" data-ticket-id="${ticketId}">Descargar boleto</button>
        </article>
      `;
    }).join('');

    ticketDownloadsSection.style.display = 'grid';
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
    const isPending = !isPaid;

    if (paymentStatusBadge) {
      paymentStatusBadge.textContent = isPaid ? 'Pago confirmado' : 'Procesando pago';
      paymentStatusBadge.classList.toggle('is-paid', isPaid);
      paymentStatusBadge.classList.toggle('is-pending', isPending);
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

    if (paymentSubtitle) {
      paymentSubtitle.textContent = isPaid
        ? 'Tu compra ya quedó reflejada. Aquí tienes el detalle de lo que pagaste.'
        : 'Stripe todavía está confirmando tu pago. Mantén esta pestaña abierta.';
    }

    renderItems(Array.isArray(data.payload?.items) ? data.payload.items : []);
    renderTicketDownloads(data, isPaid);

    if (isPaid) {
      clearCurrentCart();
      clearBoletosCache();
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
      if (isPaid && pollTimer) {
        clearInterval(pollTimer);
      }
      if (data.stripe?.paymentStatus && paymentSubtitle && !isPaid) {
        paymentSubtitle.textContent = `Estado de Stripe: ${data.stripe.paymentStatus}`;
      }
    } catch (err) {
      notifyFallback(err.message);
    }
  }

  const pollTimer = setInterval(() => {
    loadPayment().catch(() => {});
  }, 2500);

  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      loadPayment().catch((err) => notifyFallback(err.message));
    });
  }

  if (paymentTicketList) {
    paymentTicketList.addEventListener('click', (event) => {
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
        const sessionId = getSessionId();
        if (!sessionId) {
          throw new Error('Sesion de pago no encontrada');
        }
        const data = await apiCall('GET', `/payments/session/${encodeURIComponent(sessionId)}`);
        const ticketIds = Array.isArray(data.ticketIds) ? data.ticketIds : [];
        if (!ticketIds.length) {
          throw new Error('Aun no hay boletos generados para descargar');
        }
        await downloadAllTickets(ticketIds);
      } catch (err) {
        notifyFallback(err.message);
      }
    });
  }

  loadPayment().catch((err) => notifyFallback(err.message));
})();
