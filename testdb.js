const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgres://postgres:PASSWORD@HOST:5432/postgres?sslmode=disable',
  ssl: false
});

client.connect()
  .then(() => console.log("Connected ✅"))
  .catch(err => console.error(err));
