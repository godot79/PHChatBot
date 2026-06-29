const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  console.log(`🔧 Connecting to: ${dbPath}`);

  db.get("PRAGMA table_info(sessions);", (err, row) => {
    if (err) {
      console.error("❌ Failed to inspect sessions table:", err);
      process.exit(1);
    }

    db.all("PRAGMA table_info(sessions);", (err, columns) => {
      if (err) {
        console.error("❌ Failed to get table info:", err);
        process.exit(1);
      }

      const hasLastActivity = columns.some(col => col.name === 'last_activity');

      if (hasLastActivity) {
        console.log("✅ sessions table already includes 'last_activity'");
        process.exit(0);
      }
      
      db.run(
        "ALTER TABLE sessions ADD COLUMN last_activity DATETIME;",
        (err) => {
            if (err) {
                console.error("❌ Failed to add column:", err);
                process.exit(1);
            } else {
                console.log("✅ Added 'last_activity' column to sessions table.");
                process.exit(0);
            }
        }
      );
    });
  });
});
