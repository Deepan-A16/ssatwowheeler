// Express REST API Server for Parking System with Card Barcode Support (PostgreSQL)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

// SHA-256 helper function to keep usernames and passwords secret
function hashSecret(val) {
  if (!val) return '';
  return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
}

// Helper function to normalize PostgreSQL numeric string outputs to numbers
function formatEntryRow(row) {
  if (!row) return row;
  return {
    ...row,
    token_no: row.token_no !== null && row.token_no !== undefined ? parseInt(row.token_no, 10) : row.token_no,
    rate: row.rate !== null && row.rate !== undefined ? parseFloat(row.rate) : 15,
    fine_amount: row.fine_amount !== null && row.fine_amount !== undefined ? parseFloat(row.fine_amount) : 0,
    total_amount: row.total_amount !== null && row.total_amount !== undefined ? parseFloat(row.total_amount) : 0,
  };
}

const app = express();
const PORT = process.env.PORT || 5500;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// 1. User Authentication (Login)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required.' });
    }

    const hashedUsername = hashSecret(username);
    const hashedPassword = hashSecret(password);
    const query = `SELECT id, username, full_name, phone, role FROM users WHERE username = $1 AND password = $2`;
    
    const result = await db.query(query, [hashedUsername, hashedPassword]);
    const user = result.rows[0];

    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials.' });

    res.json({
      success: true,
      message: 'Login successful!',
      user: {
        id: user.id,
        username: username,
        fullName: user.full_name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: err.message ? `Database error: ${err.message}` : 'Database error.' });
  }
});

// 2. Get Next Available Token Number
app.get('/api/parking/next-token', async (req, res) => {
  try {
    const result = await db.query(`SELECT MAX(token_no) as max_token FROM parking_entries`);
    const row = result.rows[0];
    const nextToken = (row && row.max_token !== null && row.max_token !== undefined) ? (parseInt(row.max_token, 10) + 1) : 500;
    res.json({ success: true, nextToken });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Get All Parking Entries (with optional barcode / token search)
app.get('/api/parking/entries', async (req, res) => {
  try {
    const { barcode, tokenNo, search } = req.query;

    let sql = `SELECT * FROM parking_entries WHERE 1=1`;
    let params = [];
    let paramIndex = 1;

    if (barcode) {
      sql += ` AND barcode = $${paramIndex++}`;
      params.push(barcode);
    }
    if (tokenNo) {
      sql += ` AND token_no = $${paramIndex++}`;
      params.push(parseInt(tokenNo, 10));
    }
    if (search) {
      sql += ` AND (barcode ILIKE $${paramIndex} OR veh_no ILIKE $${paramIndex} OR cust_name ILIKE $${paramIndex} OR CAST(token_no AS TEXT) ILIKE $${paramIndex})`;
      paramIndex++;
      params.push(`%${search}%`);
    }

    sql += ` ORDER BY id DESC`;

    const result = await db.query(sql, params);
    const formattedEntries = result.rows.map(formatEntryRow);
    res.json({ success: true, count: formattedEntries.length, entries: formattedEntries });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Save New Parking Token Entry (including Card Barcode)
app.post('/api/parking/entry', async (req, res) => {
  try {
    let { tokenNo, barcode, vehType, vehNo, custName, mobileNo, rate, paymentMode, inDate, entryTime } = req.body;

    if (!vehNo) {
      return res.status(400).json({ success: false, message: 'Vehicle Number is required.' });
    }

    // Synchronize token number with card barcode number when barcode is scanned
    if (barcode) {
      const digits = barcode.replace(/\D/g, '');
      if (digits) {
        tokenNo = parseInt(digits, 10);
      }
    }

    const parsedToken = (tokenNo !== undefined && tokenNo !== null && tokenNo !== '') ? parseInt(tokenNo, 10) : 500;
    const now = new Date();
    const dateStr = inDate || now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
    const timeStr = entryTime || now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

    const cardBarcode = barcode || `CARD-${parsedToken}`;

    const sql = `
      INSERT INTO parking_entries (token_no, barcode, veh_type, veh_no, cust_name, mobile_no, rate, payment_mode, in_date, entry_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `;

    const params = [
      parsedToken,
      cardBarcode,
      vehType || 'BIKE 15',
      vehNo.toUpperCase(),
      custName ? custName.toUpperCase() : '',
      mobileNo || '',
      rate !== undefined && rate !== null ? parseFloat(rate) : 15,
      paymentMode || 'CASH',
      dateStr,
      timeStr
    ];

    const result = await db.query(sql, params);
    const insertedId = result.rows[0].id;

    res.status(201).json({
      success: true,
      message: `Token #${parsedToken} saved and linked to Card Barcode [${cardBarcode}]!`,
      id: insertedId,
      tokenNo: parsedToken,
      barcode: cardBarcode
    });
  } catch (err) {
    if (err.code === '23505' || (err.message && err.message.includes('unique constraint'))) {
      return res.status(409).json({ success: false, message: `Token No ${req.body.tokenNo} already exists!` });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Lookup Vehicle by Barcode or Token for Exit Checkout (Exit - F12)
app.get('/api/parking/lookup', async (req, res) => {
  try {
    const query = (req.query.query || '').trim().toUpperCase();
    if (!query) return res.status(400).json({ success: false, message: 'Query is required.' });

    const numericToken = query.replace(/\D/g, '');
    const numericVal = (numericToken && !isNaN(parseInt(numericToken, 10))) ? parseInt(numericToken, 10) : -1;
    const formattedBarcode = numericToken ? `CARD-${numericToken}` : query;

    const sql = `
      SELECT * FROM parking_entries 
      WHERE barcode = $1 
         OR (token_no = $2 AND $2 != -1)
         OR ($3 != '' AND barcode = $3)
         OR veh_no ILIKE $4
      ORDER BY id DESC LIMIT 1
    `;
    const params = [query, numericVal, formattedBarcode, `%${query}%` ];

    const result = await db.query(sql, params);
    const row = formatEntryRow(result.rows[0]);

    if (!row) return res.status(404).json({ success: false, message: `No active vehicle found matching [${query}]` });

    res.json({ success: true, entry: row });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Calculate parking fee rule: 1st hr = ₹15, <= 24 hrs = ₹30, > 24 hrs = ₹30 + ₹30 for each additional 24-hr period
function computeParkingFee(inDateStr, entryTimeStr, createdAtStr) {
  try {
    let entryDate = null;
    if (inDateStr && entryTimeStr) {
      let day, month, year;
      const dateParts = inDateStr.trim().split(/[\/\-]/);
      if (dateParts.length === 3) {
        if (dateParts[0].length === 4) {
          year = parseInt(dateParts[0], 10);
          month = parseInt(dateParts[1], 10) - 1;
          day = parseInt(dateParts[2], 10);
        } else {
          day = parseInt(dateParts[0], 10);
          month = parseInt(dateParts[1], 10) - 1;
          year = parseInt(dateParts[2], 10);
        }
      }

      const timeMatch = entryTimeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (year && month !== undefined && day && timeMatch) {
        let h = parseInt(timeMatch[1], 10);
        let m = parseInt(timeMatch[2], 10);
        const ampm = timeMatch[3] ? timeMatch[3].toUpperCase() : '';

        if (ampm === 'PM' && h < 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;

        entryDate = new Date(year, month, day, h, m, 0);
      }
    }

    if ((!entryDate || isNaN(entryDate.getTime())) && createdAtStr) {
      entryDate = new Date(createdAtStr);
    }

    if (!entryDate || isNaN(entryDate.getTime())) {
      return 15;
    }

    const now = new Date();
    const diffMs = Math.max(0, now.getTime() - entryDate.getTime());
    const totalHours = diffMs / (1000 * 60 * 60);

    if (totalHours <= 1.0) {
      return 15;
    } else if (totalHours <= 24.0) {
      return 30;
    } else {
      const extraHours = totalHours - 24.0;
      const extra24hrPeriods = Math.ceil(extraHours / 24.0);
      return 30 + (extra24hrPeriods * 30);
    }
  } catch (err) {
    return 15;
  }
}

// 6. Complete Vehicle Exit Checkout (Archives record to exit_history before clearing from active entries)
app.post('/api/parking/checkout', async (req, res) => {
  try {
    const { tokenNo, barcode, paymentMode, totalAmount, fineAmount } = req.body;
    const numericToken = (tokenNo && !isNaN(parseInt(tokenNo, 10))) ? parseInt(tokenNo, 10) : -1;
    const searchBarcode = barcode || '';

    const findSql = `SELECT * FROM parking_entries WHERE (token_no = $1 AND $1 != -1) OR (barcode != '' AND barcode = $2)`;
    const findRes = await db.query(findSql, [numericToken, searchBarcode]);
    const entry = findRes.rows[0];

    if (entry) {
      const now = new Date();
      const exitDate = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
      const exitTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
      const finalFine = parseFloat(fineAmount) || 0;
      const baseFee = computeParkingFee(entry.in_date, entry.entry_time, entry.created_at);
      const finalAmount = totalAmount ? parseFloat(totalAmount) : (baseFee + finalFine);

      const archiveSql = `
        INSERT INTO exit_history (token_no, barcode, veh_type, veh_no, cust_name, mobile_no, rate, payment_mode, in_date, entry_time, exit_date, exit_time, fine_amount, total_amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `;
      const params = [
        entry.token_no, entry.barcode, entry.veh_type, entry.veh_no, entry.cust_name, entry.mobile_no,
        entry.rate, paymentMode || entry.payment_mode || 'CASH', entry.in_date, entry.entry_time, exitDate, exitTime, finalFine, finalAmount
      ];

      await db.query(archiveSql, params);
      await db.query(`DELETE FROM parking_entries WHERE id = $1`, [entry.id]);

      return res.json({ success: true, message: `Vehicle Token #${entry.token_no} exit completed & archived to Exit History!` });
    } else {
      // Fallback delete if record exists under tokenNo / barcode
      await db.query(
        `DELETE FROM parking_entries WHERE (token_no = $1 AND $1 != -1) OR (barcode != '' AND barcode = $2)`,
        [numericToken, searchBarcode]
      );
      return res.json({ success: true, message: `Vehicle Token #${tokenNo} exit completed!` });
    }
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. Get Past Exited Vehicle History (Purges records older than 45 days automatically)
app.get('/api/parking/history', async (req, res) => {
  try {
    // Purge records older than 45 days automatically
    try {
      await db.query(`DELETE FROM exit_history WHERE exited_at < NOW() - INTERVAL '45 days'`);
    } catch (cleanErr) {
      console.error('Auto-clean error:', cleanErr.message);
    }

    const search = (req.query.search || '').trim();
    let sql = `SELECT * FROM exit_history WHERE 1=1`;
    let params = [];

    if (search) {
      sql += ` AND (CAST(token_no AS TEXT) ILIKE $1 OR veh_no ILIKE $1 OR barcode ILIKE $1 OR cust_name ILIKE $1 OR mobile_no ILIKE $1)`;
      params.push(`%${search}%`);
    }

    sql += ` ORDER BY id DESC LIMIT 500`;

    const result = await db.query(sql, params);
    const rows = result.rows.map(formatEntryRow);

    let totalAmount = 0;
    let cashAmount = 0;
    let gpayAmount = 0;

    rows.forEach(r => {
      const amt = parseFloat(r.total_amount || r.rate || 0);
      totalAmount += amt;
      if ((r.payment_mode || '').toUpperCase() === 'GPAY') {
        gpayAmount += amt;
      } else {
        cashAmount += amt;
      }
    });

    res.json({
      success: true,
      count: rows.length,
      summary: {
        totalAmount,
        cashAmount,
        gpayAmount
      },
      history: rows
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8. Clear All Parking Entries
app.delete('/api/parking/entries', async (req, res) => {
  try {
    await db.query(`DELETE FROM parking_entries`);
    res.json({ success: true, message: 'All parking entries cleared.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'logo.png'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Parking System with Card Barcode Support running on http://localhost:${PORT}`);
  });
}

module.exports = app;

