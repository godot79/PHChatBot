const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '../database.sqlite');

const db = new sqlite3.Database(dbPath);
console.log(`🔧 Connecting to: ${dbPath}`);

db.serialize(() => {
  db.all(`PRAGMA table_info(sessions);`, (err, columns) => {
    if (err) {
      console.error('❌ Error reading schema:', err.message);
      process.exit(1);
    }

    const hasState = columns.some(col => col.name === 'conversation_state');
    if (hasState) {
      console.log('✅ "conversation_state" column already exists.');
      process.exit(0);
    }

    console.log('🛠 Adding "conversation_state" column...');
    db.run(`ALTER TABLE sessions ADD COLUMN conversation_state TEXT DEFAULT NULL;`, (err) => {
      if (err) {
        console.error('❌ Failed to add column:', err.message);
        process.exit(1);
      }
      console.log('✅ "conversation_state" column added successfully.');
      process.exit(0);
    });
  });
});
