const pool = require('./db');

async function testTrends() {
  try {
    const eventId = '0f32e8ad-0113-4612-af31-51da302903ae';
    
    const q = `
      WITH bounds AS (
        SELECT
          COALESCE(MIN(COALESCE(t.created_at, NOW())), NOW()) AS min_created_at,
          COALESCE(MAX(COALESCE(t.created_at, NOW())), NOW()) AS max_created_at
        FROM tickets t
        JOIN ticket_types tt ON tt.id = t.ticket_type_id
        WHERE tt.event_id = $1
      ),
      base AS (
        SELECT
          date_trunc('day', COALESCE((SELECT max_created_at FROM bounds), NOW()))
          - INTERVAL '1 day' * 0 AS period_end,
          date_trunc('day', COALESCE((SELECT min_created_at FROM bounds), NOW())) AS period_start_floor
      ),
      series AS (
        SELECT generate_series(
          GREATEST(
            (SELECT period_start_floor FROM base),
            (SELECT period_end FROM base) - INTERVAL '1 day' * 13
          ),
          (SELECT period_end FROM base),
          INTERVAL '1 day'
        ) AS period_start
      )
      SELECT
        (SELECT period_start_floor FROM base) AS period_start_floor,
        (SELECT period_end FROM base) AS period_end,
        COUNT(*) AS series_count
      FROM series
    `;
    
    const r = await pool.query(q, [eventId]);
    console.log('RESULT:', JSON.stringify(r.rows[0], null, 2));
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
}

testTrends();
