const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

const phoneNumber = '+85298377469'; 

db.run(
  `UPDATE sessions SET conversation_state = NULL, verified = 0, patient_id = NULL, data = NULL WHERE phone_number = ?`,
  [phoneNumber],
  function (err) {
    if (err) {
      console.error('Failed to clear session:', err);
    } else {
      console.log('Session reset for', phoneNumber, 'Rows affected:', this.changes);
    }
    db.close();
  }
);
