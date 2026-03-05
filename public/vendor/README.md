# Vendor PDFs

For offline / air-gapped use, place the PDF.js build here:

  pdf.min.mjs         (ESM build from pdfjs-dist@5.5.207)
  pdf.worker.min.mjs  (Worker build from pdfjs-dist@5.5.207)

Download from: https://unpkg.com/pdfjs-dist@5.5.207/build/

Then update the import URL in ug-pro-importer.html:

  // Replace:
  import * as pdfjsLib from 'https://unpkg.com/pdfjs-dist@5.5.207/build/pdf.min.mjs';
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@5.5.207/build/pdf.worker.min.mjs';

  // With:
  import * as pdfjsLib from './vendor/pdf.min.mjs';
  pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
