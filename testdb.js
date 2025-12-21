const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgres://postgres:V8CKJiFGGof7BrQWjRc1Ytgv0bIuN6vTaeCLyearfmEeUJiO1igU5WurO6v24nDs@zkwowwc8sk4kko8cksogcw80:5432/postgres?sslmode=require',
  ssl: false
});

client.connect()
  .then(() => console.log("Connected ✅"))
  .catch(err => console.error(err));
