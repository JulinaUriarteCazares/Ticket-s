const pool = require('../db');

async function getOrganizerId() {
  const preferred = await pool.query(
    "SELECT id, role FROM users WHERE role IN ('organizer', 'admin') ORDER BY role DESC LIMIT 1"
  );

  if (preferred.rows.length > 0) {
    return preferred.rows[0].id;
  }

  const fallback = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');
  if (fallback.rows.length === 0) {
    throw new Error('No hay usuarios disponibles para asignar organizer_id');
  }

  return fallback.rows[0].id;
}

async function insertEvents(organizerId) {
  const events = [
    {
      name: 'Noche de Mariachi en Garibaldi',
      location: 'Plaza Garibaldi, CDMX',
      event_date: '2026-08-21',
      event_time: '20:30',
      description: 'Show de mariachi tradicional con invitados sorpresa.',
      capacity: 900,
      artist_name: 'Mariachi Sol de Mexico',
      artist_fee: 185000,
      image_url: null,
    },
    {
      name: 'Festival Son Jarocho Veracruz Vivo',
      location: 'Malecon de Veracruz, Veracruz',
      event_date: '2026-09-05',
      event_time: '18:00',
      description: 'Tarima, zapateado y fandango frente al mar.',
      capacity: 1400,
      artist_name: 'Colectivo Jarocho Vivo',
      artist_fee: 132000,
      image_url: null,
    },
    {
      name: 'Norteno Bajo las Estrellas Monterrey',
      location: 'Parque Fundidora, Monterrey',
      event_date: '2026-10-12',
      event_time: '21:00',
      description: 'Noche regional nortena con bandas invitadas.',
      capacity: 2200,
      artist_name: 'Grupo Sierra Regia',
      artist_fee: 240000,
      image_url: null,
    },
  ];

  const inserted = [];

  for (const event of events) {
    let result;
    try {
      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id, image_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, name, location, event_date, event_time, capacity, organizer_id`,
        [
          event.name,
          event.location,
          event.event_date,
          event.event_time,
          event.description,
          event.capacity,
          event.artist_name,
          event.artist_fee,
          organizerId,
          event.image_url,
        ]
      );
    } catch (err) {
      if (err.code !== '42703') {
        throw err;
      }

      result = await pool.query(
        `INSERT INTO events (name, location, event_date, event_time, description, capacity, artist_name, artist_fee, organizer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, name, location, event_date, event_time, capacity, organizer_id`,
        [
          event.name,
          event.location,
          event.event_date,
          event.event_time,
          event.description,
          event.capacity,
          event.artist_name,
          event.artist_fee,
          organizerId,
        ]
      );
    }

    inserted.push(result.rows[0]);
  }

  return inserted;
}

async function main() {
  const organizerId = await getOrganizerId();
  const inserted = await insertEvents(organizerId);

  console.table(inserted);
}

main()
  .catch((err) => {
    console.error('Error al crear eventos:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
