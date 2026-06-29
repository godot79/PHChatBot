// File: fix_initial_state.js

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

db.run(
  `UPDATE sessions SET conversation_state = 'INTRO' WHERE conversation_state = 'initial'`,
  function (err) {
    if (err) {
      console.error('Failed to update conversation_state:', err);
    } else {
      console.log('Sessions updated:', this.changes);
    }
    db.close();
  }
);
