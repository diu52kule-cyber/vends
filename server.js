const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const bwipjs = require('bwip-js');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3001;

// --- INITIALIZATION ---
// Use Service Role Key to bypass RLS policies on the backend
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY 
);

// Keep files in memory (RAM) instead of saving to disk, as Railway disk is ephemeral
const upload = multer({ storage: multer.memoryStorage() });

// --- MIDDLEWARE ---
app.use(cors()); // Allow standard cross-origin requests
app.use(express.json()); // Parse JSON bodies for webhooks

// Security Middleware: Block requests that don't come from your Vercel Server Action
const requireInternalSecret = (req, res, next) => {
  const secret = req.headers['x-internal-secret'];
  if (secret !== process.env.INTERNAL_SECRET) {
    return res.status(403).json({ error: 'Unauthorized. Direct API access forbidden.' });
  }
  next();
};

// --- ENDPOINT 1: UPLOAD & MERGE (Protected) ---
app.post('/process-pdf', requireInternalSecret, upload.array('files'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    // 1. Create a new blank PDF
    const mergedPdf = await PDFDocument.create();
    
    // 2. Iterate through uploaded files, copy pages, and append
    for (const file of req.files) {
      const pdf = await PDFDocument.load(file.buffer);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }

    // 3. Serialize to bytes
    const mergedPdfBytes = await mergedPdf.save();
    const fileName = `${Date.now()}_temp_order.pdf`;

    // 4. Upload raw merged file to Supabase Storage (pending state)
    const { data: storageData, error: storageError } = await supabase.storage
      .from('pdfs')
      .upload(fileName, mergedPdfBytes, { contentType: 'application/pdf' });

    if (storageError) throw storageError;

    // 5. Create Database Entry
    const { data: order, error: dbError } = await supabase
      .from('orders')
      .insert([{ file_url: storageData.path, status: 'pending' }])
      .select()
      .single();

    if (dbError) throw dbError;

    res.status(200).json({ orderId: order.id, filePath: storageData.path });
  } catch (err) {
    console.error("Merge Error:", err);
    res.status(500).json({ error: 'Failed to process PDFs' });
  }
});

// --- ENDPOINT 2: PAYMENT WEBHOOK (Open to Gateway, but verify signature in prod) ---
app.post('/webhook/payment', async (req, res) => {
  const { orderId, success } = req.body; // Adapt this to match Stripe/Razorpay payload

  try {
    // Fetch order details
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (success) {
      // --- PAYMENT SUCCESS: INJECT BARCODE ---
      
      // 1. Generate Unique Barcode ID
      const barcodeId = `PF-${Date.now().toString().slice(-6)}`;

      // 2. Generate Barcode Image Buffer using bwip-js
      const barcodeBuffer = await bwipjs.toBuffer({
        bcid: 'code128',       // Barcode type
        text: barcodeId,       // Text to encode
        scale: 3,              // 3x scaling factor
        height: 10,            // Bar height, in millimeters
        includetext: true,     // Show human-readable text
        textxalign: 'center',  // Always good to set this
      });

      // 3. Download the pending PDF from Supabase
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('pdfs')
        .download(order.file_url);
      
      if (downloadError) throw downloadError;

      // 4. Load PDF and embed the barcode image
      const pdfBytes = await fileData.arrayBuffer();
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const barcodeImage = await pdfDoc.embedPng(barcodeBuffer);
      
      // 5. Stamp barcode on the top-right of the first page
      const firstPage = pdfDoc.getPages()[0];
      const { width, height } = firstPage.getSize();
      firstPage.drawImage(barcodeImage, {
        x: width - 150,       // 150px from right edge
        y: height - 60,       // 60px from top edge
        width: 120,
        height: 40,
      });

      // 6. Save final PDF and overwrite the old one in Storage
      const finalPdfBytes = await pdfDoc.save();
      await supabase.storage
        .from('pdfs')
        .update(order.file_url, finalPdfBytes, { contentType: 'application/pdf', upsert: true });

      // 7. Update DB Status
      await supabase
        .from('orders')
        .update({ status: 'paid', barcode_id: barcodeId })
        .eq('id', orderId);

      return res.status(200).json({ message: 'Order processed successfully' });

    } else {
      // --- PAYMENT FAILED: CLEANUP ---
      
      // 1. Delete file from storage
      await supabase.storage.from('pdfs').remove([order.file_url]);
      
      // 2. Delete database record
      await supabase.from('orders').delete().eq('id', orderId);

      return res.status(200).json({ message: 'Order deleted due to payment failure' });
    }
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// --- START SERVER ---
app.listen(port, '0.0.0.0', () => {
  console.log(`Railway Backend running on port ${port}`);
});
