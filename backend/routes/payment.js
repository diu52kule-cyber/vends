/**
 * routes/payment.js
 *
 * Handles Razorpay order creation and payment verification.
 * The key_secret NEVER leaves the server.
 *
 * Endpoints:
 *   POST /api/payment/create-order   – create a Razorpay order
 *   POST /api/payment/verify         – verify HMAC signature after payment
 */

const express   = require('express');
const Razorpay  = require('razorpay');
const crypto    = require('crypto');
const router    = express.Router();

// ── Razorpay instance ─────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─────────────────────────────────────────────────
// POST /api/payment/create-order
//
// Body: { amount_paise, fileName, pages, copies }
// Returns: { orderId, amount, currency, keyId }
// ─────────────────────────────────────────────────
router.post('/create-order', async (req, res) => {
  const { amount_paise, fileName, pages, copies } = req.body;

  if (!amount_paise || amount_paise < 100) {
    return res.status(400).json({ error: 'Invalid amount (minimum ₹1)' });
  }

  try {
    const order = await razorpay.orders.create({
      amount:   Math.round(amount_paise),   // in paise
      currency: 'INR',
      receipt:  `print_${Date.now()}`,
      notes: {
        fileName: fileName || 'document',
        pages:    String(pages  || 1),
        copies:   String(copies || 1),
      },
    });

    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      keyId:    process.env.RAZORPAY_KEY_ID,   // safe to send to frontend
    });
  } catch (err) {
    console.error('[Payment] create-order error:', err.message);
    res.status(502).json({ error: 'Could not create payment order' });
  }
});

// ─────────────────────────────────────────────────
// POST /api/payment/verify
//
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Returns: { success, printCode }
// ─────────────────────────────────────────────────
router.post('/verify', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment fields' });
  }

  // Razorpay HMAC-SHA256 verification
  const body      = razorpay_order_id + '|' + razorpay_payment_id;
  const expected  = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expected !== razorpay_signature) {
    console.warn('[Payment] Signature mismatch!');
    return res.status(400).json({ error: 'Payment verification failed' });
  }

  // Generate 6-char alphanumeric print code
  const printCode = crypto.randomBytes(4)
    .toString('hex').toUpperCase().slice(0, 6);

  console.log(`[Payment] ✓ Verified — paymentId: ${razorpay_payment_id} — code: ${printCode}`);

  // TODO: save job to DB, push to vending machine queue here

  res.json({ success: true, printCode, paymentId: razorpay_payment_id });
});

module.exports = router;
