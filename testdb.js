import pkg from 'pg';
const { Client } = pkg;

const client = new Client({
  connectionString: 'postgres://postgres:V8CKJiFGGof7BrQWjRc1Ytgv0bIuN6vTaeCLyearfmEeUJiO1igU5WurO6v24nDs@zkwowwc8sk4kko8cksogcw80:5432/postgres?sslmode=require',
  ssl: false
});

await client.connect();
console.log("Connected ✅");

// مثال query
const res = await client.query('SELECT NOW()');
console.log(res.rows);
