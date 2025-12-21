const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgres://postgres:6DQNh71sjOwHWwi5VYvGGZDtx5GpsdXRz6DWQKb7mBy9fwHNTn9X21yAJy05A14v@31.97.47.20:5433/postgres?sslmode=allow',
  ssl: false
});

client.connect()
  .then(() => console.log("Connected ✅"))
  .catch(err => console.error(err));
