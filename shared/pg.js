const { Pool } = require('pg');

function createPool() {
  return new Pool({
    host:     process.env.PGHOST     || 'postgres',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'fluxer',
    user:     process.env.PGUSER     || 'fluxer',
    password: process.env.PGPASSWORD,
  });
}

module.exports = { createPool };
