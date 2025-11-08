// bot.js
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID || '', 10);
const DATA_FOLDER = process.env.DATA_FOLDER || './data';

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error('Please set TELEGRAM_TOKEN and ADMIN_CHAT_ID in .env');
  process.exit(1);
}

// Ensure data folder exists
if (!fs.existsSync(DATA_FOLDER)) fs.mkdirSync(DATA_FOLDER, { recursive: true });

// --- Database setup (SQLite) ---
const dbPath = path.join(DATA_FOLDER, 'bot.db');
const db = new Database(dbPath);

// Initialize tables if they don't exist
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,           -- Telegram user id
  username TEXT,
  full_name TEXT,
  account_details TEXT,             -- plain JSON string (encrypt in prod)
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT,                        -- 'crypto' or 'giftcard'
  amount TEXT,
  currency_or_card TEXT,
  status TEXT,                      -- 'pending','approved','rejected','completed'
  proof_files TEXT,                 -- JSON array of {file_id, file_type}
  created_at TEXT,
  admin_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
`);

// Prepared statements
const insertUserStmt = db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, created_at) VALUES (@id, @username, @full_name, @created_at)`);
const upsertAccountStmt = db.prepare(`UPDATE users SET account_details = @account_details WHERE id = @id`);
const getUserStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
const createTxStmt = db.prepare(`INSERT INTO transactions (user_id,type,amount,currency_or_card,status,proof_files,created_at) VALUES (@user_id,@type,@amount,@currency_or_card,@status,@proof_files,@created_at)`);
const getTxByIdStmt = db.prepare(`SELECT * FROM transactions WHERE id = ?`);
const updateTxStatusStmt = db.prepare(`UPDATE transactions SET status = @status, admin_note = @admin_note WHERE id = @id`);
const listUsersStmt = db.prepare(`SELECT id FROM users`);

// --- Bot setup ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session()); // For per-chat session state

// Helper - format local ISO
function nowISO() { return new Date().toISOString(); }

// Middleware: store basic user info on every message
bot.use(async (ctx, next) => {
  try {
    if (ctx.from) {
      insertUserStmt.run({
        id: ctx.from.id,
        username: ctx.from.username || null,
        full_name: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim(),
        created_at: nowISO(),
      });
    }
  } catch (err) {
    console.error('DB user insert error', err);
  }
  return next();
});

// --- Commands ---
// /start
bot.start(async (ctx) => {
  await ctx.reply(
    `Welcome ${ctx.from.first_name || ''}!\nI can help you sell crypto or gift cards.\nChoose an option below.`,
    Markup.keyboard([['Sell Crypto', 'Sell Giftcard'], ['My Account']]).resize()
  );
});

// /myaccount shows saved account details (not encrypted here)
bot.hears(/^My Account$/i, async (ctx) => {
  const user = getUserStmt.get(ctx.from.id);
  if (!user || !user.account_details) {
    return ctx.reply('No account details saved. You will be prompted after your first approved transaction.');
  }
  let account = {};
  try { account = JSON.parse(user.account_details || '{}'); } catch (e) {}
  return ctx.reply(`Saved account details:\n${Object.entries(account).map(([k,v])=>`${k}: ${v}`).join('\n')}`);
});

// START SALE FLOW: choose type
bot.hears(/^(Sell Crypto|Sell Giftcard)$/i, async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.flow = {};
  ctx.session.flow.step = 'choose_type';
  ctx.session.flow.type = ctx.message.text.toLowerCase().includes('crypto') ? 'crypto' : 'giftcard';
  await ctx.reply(`You chose to sell: ${ctx.session.flow.type}\nPlease enter the amount (e.g., $10 or $50):`);
});

// Capture amount -> currency/card -> ask for proof images
bot.on('text', async (ctx, next) => {
  ctx.session = ctx.session || {};
  const flow = ctx.session.flow;
  if (!flow || !flow.step) return next();

  const text = ctx.message.text.trim();

  if (flow.step === 'choose_type') {
    flow.amount = text;
    flow.step = 'currency';
    return ctx.reply(flow.type === 'crypto' ? 'Which cryptocurrency? (e.g., BTC, USDT)' : 'Which gift card? (e.g., iTunes $50, Google Play $25)');
  }

  if (flow.step === 'currency') {
    flow.currency_or_card = text;
    flow.step = 'await_proof';
    return ctx.reply('Please upload proof image(s). For crypto: upload your payment proof. For giftcards: upload image of card AND receipt (if any). You can send multiple images one after another. When done, send /done.');
  }

  if (flow.step === 'await_admin_note' && ctx.from.id === ADMIN_CHAT_ID) {
    // used when admin optionally sends a note on approve/reject via chat (not implemented fully)
    return ctx.reply('Admin note received.');
  }

  return next(); // let other handlers run
});

// Receive photos while in awaiting proof step
bot.on('photo', async (ctx) => {
  ctx.session = ctx.session || {};
  const flow = ctx.session.flow;
  if (!flow || flow.step !== 'await_proof') {
    return ctx.reply('I received a photo but you are not in a selling flow. Use "Sell Crypto" or "Sell Giftcard" to start.');
  }

  // save the biggest photo's file_id
  const photos = ctx.message.photo;
  const file = photos[photos.length - 1]; // largest
  flow.proof = flow.proof || [];
  flow.proof.push({ file_id: file.file_id, file_type: 'photo', date: nowISO() });

  return ctx.reply('Image received. Send more images or /done when finished.');
});

// /done finalizes a transaction and notifies admin
bot.command('done', async (ctx) => {
  ctx.session = ctx.session || {};
  const flow = ctx.session.flow;
  if (!flow || flow.step !== 'await_proof') {
    return ctx.reply('You are not in the middle of a sale. Start with "Sell Crypto" or "Sell Giftcard".');
  }
  if (!flow.proof || flow.proof.length === 0) {
    return ctx.reply('Please upload at least one proof image before sending /done.');
  }

  // create transaction
  const tx = {
    user_id: ctx.from.id,
    type: flow.type,
    amount: flow.amount,
    currency_or_card: flow.currency_or_card,
    status: 'pending',
    proof_files: JSON.stringify(flow.proof),
    created_at: nowISO()
  };

  const info = createTxStmt.run(tx);
  const txId = info.lastInsertRowid;

  // Notify admin with Approve/Reject inline buttons
  const userLabel = `${ctx.from.first_name || ''}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''} (@${ctx.from.username || 'no_username'})`;
  let caption = `New ${tx.type.toUpperCase()} sale (ID: ${txId})\nFrom: ${userLabel}\nAmount: ${tx.amount}\nType: ${tx.currency_or_card}\nStatus: pending\n\nProof images are attached below. Use the buttons to Approve or Reject.`;

  // Build inline keyboard
  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback('✅ Approve', `approve:${txId}`),
    Markup.button.callback('❌ Reject', `reject:${txId}`)
  ]);

  // Send a message to ADMIN_CHAT_ID with images (use media group if multiple)
  try {
    // get files
    const files = flow.proof;
    if (files.length === 1) {
      await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, files[0].file_id, { caption, ...keyboard });
    } else {
      // send media group, then a text message with buttons
      const media = files.map(f => ({ type: 'photo', media: f.file_id }));
      await ctx.telegram.sendMediaGroup(ADMIN_CHAT_ID, media);
      await ctx.telegram.sendMessage(ADMIN_CHAT_ID, caption, keyboard);
    }
  } catch (err) {
    console.error('Error notifying admin:', err);
  }

  // Confirm to user
  await ctx.reply('Your submission is pending admin approval. You will be prompted for account details if approved. Thank you!');
  ctx.session.flow = null; // reset flow
});

// --- Admin approves/rejects ---
bot.action(/^(approve|reject):(\d+)$/, async (ctx) => {
  // Only admin
  if (ctx.from.id !== ADMIN_CHAT_ID) {
    return ctx.answerCbQuery('Only admin can perform this action.', { show_alert: true });
  }

  const action = ctx.match[1]; // approve / reject
  const txId = parseInt(ctx.match[2], 10);
  const txRow = getTxByIdStmt.get(txId);
  if (!txRow) {
    await ctx.answerCbQuery('Transaction not found.', { show_alert: true });
    return;
  }

  if (action === 'reject') {
    updateTxStatusStmt.run({ id: txId, status: 'rejected', admin_note: `Rejected by admin ${ctx.from.id} at ${nowISO()}` });
    await ctx.editMessageText(`Transaction ${txId} has been REJECTED by admin.`);
    // notify user
    await ctx.telegram.sendMessage(txRow.user_id, `Your transaction (ID: ${txId}) was rejected by the admin. You may contact support for details.`);
    return ctx.answerCbQuery('Rejected.');
  }

  // Approve
  updateTxStatusStmt.run({ id: txId, status: 'approved', admin_note: `Approved by admin ${ctx.from.id} at ${nowISO()}` });
  await ctx.editMessageText(`Transaction ${txId} has been APPROVED by admin.`);

  // Notify user: prompt for account details (or show stored details and ask to confirm)
  const user = getUserStmt.get(txRow.user_id);
  let saved = null;
  if (user && user.account_details) {
    try { saved = JSON.parse(user.account_details); } catch (e) {}
  }

  if (saved && Object.keys(saved).length > 0) {
    // ask user to confirm or update
    await ctx.telegram.sendMessage(txRow.user_id,
      `Your transaction (ID: ${txId}) was approved.\nWe have saved account details:\n${Object.entries(saved).map(([k,v])=>`${k}: ${v}`).join('\n')}\n\nReply "CONFIRM" to use these details, or send new account details in the format:\nfield1:value1\nfield2:value2`);
  } else {
    // no saved details - prompt
    await ctx.telegram.sendMessage(txRow.user_id,
      `Your transaction (ID: ${txId}) was approved.\nPlease send your account details now in the format (each on new line):\naccount_name:John Doe\naccount_number:0123456789\nbank:ABC Bank\n\nOr send any payment receiving details your prefer.`);
  }

  // Also send the admin the user's current stored details (if any) and file_ids for record
  const proofFiles = JSON.parse(txRow.proof_files || '[]');
  const accountText = saved ? `Saved account details:\n${Object.entries(saved).map(([k,v])=>`${k}: ${v}`).join('\n')}` : 'No saved account details for this user.';
  let adminMsg = `Transaction ${txId} APPROVED.\nFrom user: ${txRow.user_id}\nAmount: ${txRow.amount}\nType: ${txRow.currency_or_card}\n\n${accountText}\n\nProof file_ids:\n${proofFiles.map(p=>p.file_id).join('\n')}`;
  await ctx.telegram.sendMessage(ADMIN_CHAT_ID, adminMsg);

  return ctx.answerCbQuery('Approved.');
});

// Handle replies (user sending account details after approval)
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();

  // If the text is "CONFIRM" and user has saved details we should mark transaction completed for the latest approved tx
  const user = getUserStmt.get(ctx.from.id);
  let saved = null;
  if (user && user.account_details) {
    try { saved = JSON.parse(user.account_details); } catch (e) {}
  }

  // Find latest 'approved' transaction for this user (not completed)
  const latestApproved = db.prepare(`SELECT * FROM transactions WHERE user_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1`).get(ctx.from.id);

  if (latestApproved) {
    if (text.toUpperCase() === 'CONFIRM' && saved) {
      // mark completed and inform admin
      updateTxStatusStmt.run({ id: latestApproved.id, status: 'completed', admin_note: `User confirmed saved details at ${nowISO()}` });
      await ctx.reply('Thanks — your saved details have been attached to the transaction. Admin has been notified.');
      // send admin details
      await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `Transaction ${latestApproved.id} completed. User ${ctx.from.id} confirmed saved details:\n${Object.entries(saved).map(([k,v])=>`${k}: ${v}`).join('\n')}`);
      return;
    }

    // If user provides new details in key:value lines, parse and save
    if (text.includes(':')) {
      // parse body into JSON
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const obj = {};
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim();
          if (k) obj[k] = v;
        }
      }
      if (Object.keys(obj).length === 0) {
        return ctx.reply('Could not parse account details. Use format key:value each on its own line.');
      }
      // update DB (in prod, encrypt)
      upsertAccountStmt.run({ id: ctx.from.id, account_details: JSON.stringify(obj) });

      // mark transaction completed and notify admin
      updateTxStatusStmt.run({ id: latestApproved.id, status: 'completed', admin_note: `User provided details at ${nowISO()}` });
      await ctx.reply('Thanks! Your account details were saved and sent to the admin.');
      await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `Transaction ${latestApproved.id} completed by user ${ctx.from.id}. Account details:\n${Object.entries(obj).map(([k,v])=>`${k}: ${v}`).join('\n')}`);
      return;
    }
  }

  return next();
});

// --- Admin broadcast ---
// /broadcast <message> (admin only)
bot.command('broadcast', async (ctx) => {
  if (ctx.from.id !== ADMIN_CHAT_ID) return ctx.reply('Only admin can use this command.');
  const text = ctx.message.text.replace(/^\/broadcast\s*/i, '').trim();
  if (!text) return ctx.reply('Usage: /broadcast Your message here');

  // fetch all users
  const users = listUsersStmt.all();
  let sent = 0;
  for (const u of users) {
    try {
      await ctx.telegram.sendMessage(u.id, `📣 Broadcast:\n\n${text}`);
      sent++;
      // small delay to avoid hitting limits
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      // ignore blocked users/errors
    }
  }
  await ctx.reply(`Broadcast sent to ~${sent} users.`);
});

// Simple help
bot.command('help', (ctx) => {
  ctx.reply('Commands:\n/start\nSell Crypto\nSell Giftcard\nMy Account\n/admin commands: /broadcast <message>');
});

// Error handling
bot.catch((err) => {
  console.error('Bot error', err);
});

// Launch
bot.launch().then(() => {
  console.log('Bot started');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
