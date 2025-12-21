const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgres://postgres:Y7UfZjKmUsENlPibkeQv28p6TteDm7Xl2BPmWxKBIhlktc7TQeHTxXvbpzjxgKEJ@31.97.47.20:5433/postgres?sslmode=require',
  ssl: false
});

client.connect()
  .then(() => console.log("Connected ✅"))
  .catch(err => console.error(err));
