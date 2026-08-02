import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec('CREATE TABLE test (id TEXT, body TEXT)');

const stmt = db.prepare('INSERT INTO test (id, body) VALUES (@id, @body)');
try {
    stmt.run({ id: '1' }); // body is missing
    console.log('Success without body');
} catch (e: any) {
    console.log('Error without body:', e.message);
}

try {
    stmt.run({ id: '2', body: undefined });
    console.log('Success with undefined body');
} catch (e: any) {
    console.log('Error with undefined body:', e.message);
}
