(function () {
  const paymentStatusBadge = document.getElementById('paymentStatusBadge');
  const paymentSubtitle = document.getElementById('paymentSubtitle');
  const paymentSessionId = document.getElementById('paymentSessionId');
  const paymentTotal = document.getElementById('paymentTotal');
  const paymentStatusText = document.getElementById('paymentStatusText');
  const paymentItems = document.getElementById('paymentItems');
  const refreshButton = document.getElementById('refreshPayment');

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

    if (isPaid) {
      clearCurrentCart();
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

  loadPayment().catch((err) => notifyFallback(err.message));
})();
