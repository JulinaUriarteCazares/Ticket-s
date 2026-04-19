const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./db');

const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const ticketRoutes = require('./routes/tickets');
const reportRoutes = require('./routes/reports');
const paymentRoutes = require('./routes/payments');

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'SAMEORIGIN');
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	next();
});

app.use(cors());
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), paymentRoutes.webhook);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public', { dotfiles: 'deny' }));  // Sirve archivos estáticos desde la carpeta "public"

app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/payments', paymentRoutes.router);

const PORT = process.env.PORT || 3000;

async function startServer() {
	try {
		await pool.query('SELECT NOW()');
		console.log('Conexion a base de datos OK');
		app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
	} catch (err) {
		console.error('Error conectando a la base de datos:', err.message || err);
		process.exit(1);
	}
}

startServer();