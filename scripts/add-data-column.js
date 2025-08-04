const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.resolve(__dirname, '../database.sqlite');
console.log(`🛠 Connecting to: ${dbPath}`);

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.all(`PRAGMA table_info(sessions);`, (err, columns) => {
    if (err) {
      console.error('❌ Failed to read session table info:', err);
      process.exit(1);
    }

    const hasDataColumn = columns.some(col => col.name === 'data');
    if (hasDataColumn) {
      console.log('✅ "data" column already exists. No action needed.');
      process.exit(0);
    }

    console.log('🔧 Adding "data" column to sessions...');
    db.run(`ALTER TABLE sessions ADD COLUMN data TEXT;`, (err) => {
      if (err) {
        console.error('❌ Failed to add "data" column:', err);
        process.exit(1);
      }
      console.log('✅ "data" column added successfully.');
      process.exit(0);
    });
  });
});
